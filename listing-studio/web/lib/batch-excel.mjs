import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {visibleBatchFiles} from './batches.mjs';
import {realFile} from './reports.mjs';

const script=fileURLToPath(new URL('../scripts/write-batch-excel.py',import.meta.url));
const active=new Set(['queued','staged','running','cancelling']);
const finished=task=>task.state==='completed'&&task.result?.titles?.length===2&&task.result.keywords?.length&&task.result.competitors?.length;
const workbookValues=result=>({
  titles:result.titles.map(({text})=>({text})),
  keywords:result.keywords.map(({term})=>({term})),
  competitors:result.competitors.map(({title})=>({title}))
});

function batchExcelSignature(tasks){
  const inputs=tasks.map(task=>[task.id,task.state,task.name,task.imageFile,task.previewFile,finished(task)?workbookValues(task.result):null]);
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function assertBatchReady(batch,tasks){
  if(!batch||batch.state!=='submitted')throw Object.assign(new Error('请先提交ZIP批次'),{status:409});
  if(!tasks.length||tasks.length!==batch.files.length)throw Object.assign(new Error('批次图片尚未准备完整，暂不能导出'),{status:409});
  const pending=tasks.filter(task=>active.has(task.state));
  if(pending.length)throw Object.assign(new Error(`还有 ${pending.length} 张图片正在调研，全部处理结束后再下载Excel`),{status:409});
  const incomplete=tasks.filter(task=>!finished(task));
  if(incomplete.length)throw Object.assign(new Error(`${incomplete.length} 张图片尚未完整完成，请继续或重试后再导出Excel`),{status:409});
}

export class BatchExcelExporter {
  constructor(tasks,batches){this.tasks=tasks;this.batches=batches;this.locks=new Map();}

  batchContents(batch){
    const files=visibleBatchFiles(batch,this.tasks);
    const tasks=files.map(file=>this.tasks.get(file.taskId)).filter(Boolean);
    return {files,tasks};
  }

  ready(batch){
    if(batch?.state!=='submitted')return false;
    const {files,tasks}=this.batchContents(batch);
    return files.length>0&&tasks.length===files.length&&tasks.every(finished);
  }

  view(batch){
    const ready=this.ready(this.batches.get(batch.id));
    return {...batch,excel:{ready,url:ready?`api/batches/${batch.id}/excel`:null}};
  }

  watch(){
    const prepare=batch=>{
      if(!this.ready(batch))return;
      void this.export(batch.id).catch(error=>{
        if(error.status!==409&&error.status!==404)console.error('批次 Excel 生成失败',batch.id,error.cause||error);
      });
    };
    const taskChanged=(task,previous)=>{
      if(!task.batchId)return;
      const justDeleted=task.deletedAt&&!previous.deletedAt;
      const resultChanged=!task.deletedAt&&finished(task)&&(!finished(previous)||batchExcelSignature([task])!==batchExcelSignature([previous]));
      if(justDeleted||resultChanged)prepare(this.batches.get(task.batchId));
    };
    const batchSubmitted=(batch,previous)=>{
      if(previous.state!=='submitted')prepare(batch);
    };
    this.tasks.on('change',taskChanged);
    this.batches.on('change',batchSubmitted);
    for(const batch of this.batches.list())prepare(batch);
    return ()=>{
      this.tasks.off('change',taskChanged);
      this.batches.off('change',batchSubmitted);
    };
  }

  export(id){
    const operation=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.generate(id));
    this.locks.set(id,operation);
    const cleanup=()=>{if(this.locks.get(id)===operation)this.locks.delete(id);};
    void operation.then(cleanup,cleanup);
    return operation;
  }

  async generate(id){
    const batch=this.batches.get(id);
    if(!batch)throw Object.assign(new Error('批次不存在'),{status:404});
    const {files,tasks}=this.batchContents(batch);
    assertBatchReady({...batch,files},tasks);
    const directory=this.batches.directory(id),output=path.join(directory,'listing-batch.xlsx'),signature=batchExcelSignature(tasks);
    const stamp=path.join(directory,'.listing-batch-excel.json');
    try{
      const saved=JSON.parse(await fs.readFile(stamp,'utf8'));
      if(saved.signature===signature&&(await fs.stat(output)).isFile())return output;
    }catch{}
    const rows=await Promise.all(tasks.map(async(task,index)=>{
      const imageFile=path.extname(task.imageFile).toLowerCase()==='.webp'?task.previewFile:task.imageFile;
      const imagePath=await realFile(this.tasks.directory(task.id),imageFile);
      return {name:files[index].name,imagePath,result:workbookValues(task.result)};
    }));
    await new Promise((resolve,reject)=>{
      const child=execFile('python3',['-I',script,output],{timeout:120000,maxBuffer:1024*1024});
      let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
      const failure=cause=>Object.assign(new Error('Excel生成失败，请稍后重试',{cause}),{status:500});
      child.once('error',error=>reject(failure(error)));
      child.once('close',code=>code===0?resolve():reject(failure(stderr.trim())));
      child.stdin.on('error',error=>reject(failure(error)));
      child.stdin.end(JSON.stringify(rows));
    });
    const latest=this.batchContents(batch).tasks;
    if(batchExcelSignature(latest)!==signature)throw Object.assign(new Error('批次结果刚刚更新，请重新下载Excel'),{status:409});
    await fs.writeFile(stamp,JSON.stringify({signature}),{mode:0o600});
    return output;
  }
}
