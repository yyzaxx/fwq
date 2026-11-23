import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {TaskStore} from '../lib/store.mjs';
import {BatchExcelExporter} from '../lib/batch-excel.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64');
async function fixture(state='completed'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-excel-'));
 const tasks=await new TaskStore(path.join(root,'jobs')).init(),batches=await new TaskStore(path.join(root,'batches')).init();
 const files=[],taskIds=[];
 for(const [index,name] of ['2.png','10.png'].entries()){
  const id=`excel-image-00${index}`;taskIds.push(id);files.push({id:String(index+1).padStart(3,'0'),name});
  await tasks.create(null,{id,name,state,imageFile:'design.png',result:{titles:[{text:`Title one ${index}`},{text:`Title two ${index}`}],keywords:[{term:'frog decor'},{term:'wall art'}],competitors:[{asin:'B000000001',title:`Competitor A ${index}`},{asin:'B000000002',title:`Competitor B ${index}`}]}});
  await fs.writeFile(path.join(tasks.directory(id),'design.png'),png);
 }
 await batches.create(null,{id:'excel-batch-001',name:'图片.zip',state:'submitted',files,taskIds});
 return {root,tasks,batches,exporter:new BatchExcelExporter(tasks,batches)};
}
const result=task=>({...task,events:[]});

test('全部图片完成后生成内嵌图片的Excel并缓存；标题更新后重新生成',async()=>{
 const {root,tasks,batches,exporter}=await fixture();
 try{
  const view=exporter.view({...batches.get('excel-batch-001')});assert.equal(view.excel.ready,true);
  const file=await exporter.export('excel-batch-001');const before=await fs.stat(file);assert.ok(before.size>1000);
  const again=await exporter.export('excel-batch-001');assert.equal(again,file);assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
  await new Promise(resolve=>setTimeout(resolve,15));
  const id=batches.get('excel-batch-001').taskIds[0],task=tasks.get(id);
  await tasks.patch(id,{result:{...task.result,titles:[{text:'Updated title one'},{text:'Updated title two'}]}});
  await exporter.export('excel-batch-001');assert.ok((await fs.stat(file)).mtimeMs>before.mtimeMs);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('排队、暂停、缺标题或缺图片时拒绝不完整Excel',async()=>{
 for(const state of ['queued','running','partial','cancelled']){
  const {root,tasks,batches,exporter}=await fixture(state);
  try{
   assert.equal(exporter.view(batches.get('excel-batch-001')).excel.ready,false);
   await assert.rejects(exporter.export('excel-batch-001'),error=>error.status===409);
   await assert.rejects(fs.access(path.join(batches.directory('excel-batch-001'),'listing-batch.xlsx')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});

test('保留的图片全部完成后可以导出，跳过已删除记录并保持原图名与结果对应',async()=>{
 const {root,tasks,batches,exporter}=await fixture();
 try{
  const batch=batches.get('excel-batch-001');
  await tasks.patch(batch.taskIds[0],{state:'partial'});
  assert.equal(exporter.view(batch).excel.ready,false);
  await tasks.remove(batch.taskIds[0]);
  assert.equal(exporter.view(batch).excel.ready,true);
  const file=await exporter.export(batch.id);
  execFileSync('python3',['-c',`
import sys, zipfile, xml.etree.ElementTree as et
with zipfile.ZipFile(sys.argv[1]) as book:
 ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
 strings = [''.join(cell.itertext()) for cell in et.fromstring(book.read('xl/sharedStrings.xml'))]
 sheet = et.fromstring(book.read('xl/worksheets/sheet1.xml'))
 cells = {cell.attrib['r']: strings[int(cell.findtext(ns+'v'))]
          for cell in sheet.iter(ns+'c') if cell.attrib.get('t') == 's'}
 assert cells['B2'] == '10.png' and cells['C2'] == 'Title one 1'
 assert 'B3' not in cells
`,file]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
