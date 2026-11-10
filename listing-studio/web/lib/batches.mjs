import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {detectImage,validateInput} from './domain.mjs';

const run=promisify(execFile);
const script=fileURLToPath(new URL('../scripts/read-archive.py',import.meta.url));
export async function prepareArchive(filename,directory){
  const extracted=path.join(directory,'images');await fs.mkdir(extracted,{recursive:true,mode:0o700});
  let raw;
  try{raw=JSON.parse((await run('python3',[script,filename,extracted],{timeout:60000,maxBuffer:1024*1024})).stdout);}
  catch(error){const message=error.stderr?.trim()||'';throw new Error(/[\u4e00-\u9fff]/.test(message)?message:'ZIP无法读取，请检查压缩包是否完整且未设置密码');}
  const files=[],skipped=raw.skipped;
  raw.files.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  for(const [index,file] of raw.files.entries()){
    const original=path.join(extracted,file.source),id=String(index+1).padStart(3,'0');
    try{
      const format=detectImage(await fs.readFile(original)),imageFile='images/'+id+'.'+format.ext,previewFile='images/'+id+'-preview.jpg';
      await fs.rename(original,path.join(directory,imageFile));
      await run('convert',['-limit','memory','64MiB','-limit','map','128MiB',path.join(directory,imageFile)+'[0]','-auto-orient','-resize','1200x1200>',path.join(directory,previewFile)],{timeout:20000});
      files.push({id,name:file.name,imageFile,previewFile});
    }catch{skipped.push({name:file.name,reason:'图片无法解码或格式无效'});}
    finally{await fs.rm(original,{force:true});}
  }
  if(!files.length)throw new Error('压缩包中没有可用图片，请使用JPG、PNG或WebP');
  return {files,skipped};
}

export class BatchManager {
  constructor(tasks,batches,runner){this.tasks=tasks;this.batches=batches;this.runner=runner;this.locks=new Map();}
  view(batch){
    const files=batch.files.map((file,i)=>({...file,taskId:batch.taskIds?.[i]||null})).filter(file=>!file.taskId||!this.tasks.isDeleted(file.taskId));
    const taskIds=files.map(file=>file.taskId).filter(Boolean),tasks=taskIds.map(id=>this.tasks.get(id)).filter(Boolean);
    const counts={total:files.length,completed:0,queued:0,running:0,waiting:0,stopped:0,finished:0};
    for(const task of tasks){
      if(task.state==='completed')counts.completed++;
      if(['queued','staged'].includes(task.state))counts.queued++;
      if(['running','cancelling'].includes(task.state))counts.running++;
      if(['partial','needs_input','needs_login','failed'].includes(task.state))counts.waiting++;
      if(task.state==='cancelled')counts.stopped++;
      if(!['queued','staged','running','cancelling'].includes(task.state))counts.finished++;
    }
    return {...batch,counts,files,taskIds};
  }
  list(){return this.batches.list().map(batch=>this.view(batch));}
  start(id,input){
    const snapshot=structuredClone(validateInput(input));
    const operation=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.commit(id,snapshot));
    this.locks.set(id,operation);return operation;
  }
  async commit(id,input){
    let batch=this.batches.get(id);if(!batch)throw new Error('批次不存在，请重新上传压缩包');
    if(batch.state!=='draft'&&JSON.stringify(batch.input)!==JSON.stringify(input))throw new Error('这批已提交，模板已固定；请重新上传建立新批次');
    if(batch.state==='submitted')return this.view(batch);
    if(batch.state==='draft')batch=await this.batches.patch(id,{state:'preparing',input:structuredClone(input),taskIds:batch.files.map(()=>randomUUID())});
    for(const [i,file] of batch.files.entries()){
      const taskId=batch.taskIds[i];if(this.tasks.get(taskId)||this.tasks.isDeleted(taskId))continue;
      const dir=this.tasks.directory(taskId);await fs.mkdir(dir,{recursive:true,mode:0o700});
      const imageFile='design'+path.extname(file.imageFile);
      await fs.copyFile(path.join(this.batches.directory(id),file.imageFile),path.join(dir,imageFile));
      await fs.copyFile(path.join(this.batches.directory(id),file.previewFile),path.join(dir,'preview.jpg'));
      await this.tasks.create(structuredClone(batch.input),{id:taskId,name:file.name,state:'staged',imageFile,previewFile:'preview.jpg',mode:'full',batchId:id,batchIndex:i+1,batchTotal:batch.files.length});
    }
    // All independent image directories and the frozen input exist before any work runs.
    await this.runner.enqueueMany(batch.taskIds.filter(taskId=>this.tasks.get(taskId)?.state==='staged'));
    batch=await this.batches.patch(id,{state:'submitted'});
    return this.view(batch);
  }
  async restore(){for(const batch of this.batches.list())if(batch.state==='preparing')await this.start(batch.id,batch.input);}
  cancel(id){
    const operation=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.stop(id));
    this.locks.set(id,operation);return operation;
  }
  async stop(id){
    const batch=this.batches.get(id);if(!batch)throw new Error('批次不存在');
    // Remove pending children first, so stopping the active child cannot start its successor.
    for(const taskId of batch.taskIds||[])if(this.tasks.get(taskId)?.state==='queued')await this.runner.cancel(taskId);
    for(const taskId of batch.taskIds||[])if(['running','needs_login'].includes(this.tasks.get(taskId)?.state))await this.runner.cancel(taskId);
    return this.view(this.batches.get(id));
  }
  remove(id){
    const operation=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const batch=this.batches.get(id);if(!batch)throw Object.assign(new Error('批次不存在或已删除'),{status:404});
      if(batch.state==='preparing')throw Object.assign(new Error('批次正在准备，请先停止后再删除'),{status:409});
      const taskIds=(batch.taskIds||[]).filter(taskId=>this.tasks.get(taskId));
      await this.runner.deleteHistory(taskIds);await this.batches.remove(id);return {id,deleted:true,taskIds};
    });this.locks.set(id,operation);return operation;
  }
  removeTask(id){
    const task=this.tasks.get(id);if(!task)return Promise.reject(Object.assign(new Error('历史记录不存在或已删除'),{status:404}));
    if(!task.batchId||!this.batches.get(task.batchId))return this.runner.deleteHistory([id]).then(()=>({id,deleted:true}));
    const batchId=task.batchId;
    const operation=(this.locks.get(batchId)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const batch=this.batches.get(batchId);
      if(batch?.state==='preparing')throw Object.assign(new Error('批次正在准备，请先停止后再删除'),{status:409});
      await this.runner.deleteHistory([id]);let batchDeleted=false;
      if(batch&&this.view(batch).files.length===0){await this.batches.remove(batchId);batchDeleted=true;}
      return {id,deleted:true,batchId,batchDeleted};
    });this.locks.set(batchId,operation);return operation;
  }
}
