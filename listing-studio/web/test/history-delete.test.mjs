import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';
import {importHistory} from '../lib/import-history.mjs';

const input={category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]]};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-delete-'));
  const app=await createApp({dataRoot:path.join(root,'jobs'),basePath:'/qa/',importExisting:false,runnerEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true})});
  const base='http://127.0.0.1:'+app.server.address().port+'/qa/api/';
  const request=(route,method='GET',body={})=>fetch(base+route,{method,...(method==='GET'?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  const seed=async(id,extras={})=>{const task=await app.store.create(input,{id,state:'completed',previewFile:'preview.jpg',imageFile:'design.jpg',result:{reportFile:'report.md',competitors:[],keywords:[],titles:[]},...extras});await fs.writeFile(path.join(app.store.directory(id),'report.md'),'# 已保存报告');await fs.writeFile(path.join(app.store.directory(id),'preview.jpg'),'image fixture');return task;};
  return {root,app,request,seed};
}
test('删除历史后列表、详情、图片、报告及下载均移除，重启后不再出现，原资料保留',async t=>{
  const {root,app,request,seed}=await fixture(t);await seed('delete-image-001');await seed('keep-image-002');
  const response=await request('tasks/delete-image-001','DELETE');assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);
  assert.deepEqual((await(await request('tasks')).json()).map(t=>t.id),['keep-image-002']);
  for(const suffix of ['', '/file?path=preview.jpg','/report','/download','/resume'])assert.equal((await request('tasks/delete-image-001'+suffix,suffix==='/resume'?'POST':'GET')).status,404);
  const restored=await new TaskStore(path.join(root,'jobs')).init();assert.equal(restored.get('delete-image-001'),null);assert.ok(restored.isDeleted('delete-image-001'));assert.equal(restored.list().length,1);
  assert.equal(await fs.readFile(path.join(app.store.directory('delete-image-001'),'report.md'),'utf8'),'# 已保存报告');
  await assert.rejects(app.store.patch('delete-image-001',{state:'queued'}),/不存在|删除/);
});
test('运行、排队、收尾和等待登录的任务拒绝删除',async t=>{
  const {app,request,seed}=await fixture(t);
  for(const state of ['queued','running','cancelling','staged','needs_login']){const id='busy-image-'+state.replace('_','-');await seed(id,{state});assert.equal((await request('tasks/'+id,'DELETE')).status,409);assert.ok(app.store.get(id));}
  await seed('cleanup-image-001');app.runner.active='cleanup-image-001';assert.equal((await request('tasks/cleanup-image-001','DELETE')).status,409);app.runner.active=null;
});
async function batchFixture(t){
  const f=await fixture(t),id='delete-batch-001';
  await f.seed('batch-image-001',{batchId:id,batchIndex:1,batchTotal:2});await f.seed('batch-image-002',{batchId:id,batchIndex:2,batchTotal:2});await f.seed('outside-image-003');
  const directory=f.app.batches.directory(id);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'001.jpg'),'first');await fs.writeFile(path.join(directory,'002.jpg'),'second');
  await f.app.batches.create(null,{id,state:'submitted',name:'测试批次',input,files:[{id:'001',name:'first.jpg',previewFile:'001.jpg'},{id:'002',name:'second.jpg',previewFile:'002.jpg'}],taskIds:['batch-image-001','batch-image-002']});return {...f,batchId:id};
}
test('删除批次内单条历史后同步更新计数和预览，删除最后一条后移除空批次',async t=>{
  const {request,batchId}=await batchFixture(t);
  assert.equal((await request('tasks/batch-image-001','DELETE')).status,200);
  let batch=await(await request('batches/'+batchId)).json();assert.equal(batch.counts.total,1);assert.equal(batch.counts.completed,1);assert.deepEqual(batch.taskIds,['batch-image-002']);assert.equal(batch.files.length,1);
  assert.equal((await request('batches/'+batchId+'/preview/001')).status,404);assert.equal((await request('batches/'+batchId+'/preview/002')).status,200);
  assert.equal((await request('tasks/batch-image-002','DELETE')).status,200);assert.equal((await request('batches/'+batchId)).status,404);assert.deepEqual(await(await request('batches')).json(),[]);
  assert.equal((await request('tasks/outside-image-003')).status,200);
});
test('删除整批历史只移除该批次，模板与其他任务保留',async t=>{
  const {app,request,batchId}=await batchFixture(t);
  await request('templates','POST',{...input,name:'保留模板'});const before=await(await request('templates')).json();assert.equal(before.length,1);
  const response=await request('batches/'+batchId,'DELETE');assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);
  assert.equal((await request('batches/'+batchId)).status,404);assert.equal((await request('tasks/batch-image-001')).status,404);assert.equal((await request('tasks/batch-image-002')).status,404);
  assert.equal((await request('tasks/outside-image-003')).status,200);assert.deepEqual(await(await request('templates')).json(),before);assert.ok(app.batches.isDeleted(batchId));
});
test('批次仍有任务运行时整批删除失败，不会先删除其他记录',async t=>{
  const {app,request,batchId}=await batchFixture(t);await app.store.patch('batch-image-002',{state:'queued'});
  assert.equal((await request('batches/'+batchId,'DELETE')).status,409);assert.ok(app.store.get('batch-image-001'));assert.ok(app.store.get('batch-image-002'));assert.ok(app.batches.get(batchId));
});
test('删除资源暂停的旧记录不会放开后续队列，确认恢复后也不会重跑已删除任务',async t=>{
  const {app,request,seed}=await fixture(t);await seed('paused-delete-001',{state:'failed',resourcePause:{status:'paused',message:'资源暂停'}});await seed('queued-keep-002',{state:'queued'});await app.runner.restore();
  assert.equal((await request('tasks/paused-delete-001','DELETE')).status,200);assert.ok(app.runner.info().resourceError);
  const restored=new TaskRunner(app.store,{enabled:false,resourceCheck:async()=>null});await restored.restore();assert.ok(restored.info().resourceError);assert.deepEqual(restored.queue,['queued-keep-002']);
  await restored.resumeLogin();assert.equal(restored.info().resourceError,null);assert.deepEqual(restored.queue,['queued-keep-002']);
  const again=new TaskRunner(app.store,{enabled:false});await again.restore();assert.equal(again.info().resourceError,null);assert.equal(app.store.get('paused-delete-001'),null);
});
test('删除已停止的登录受阻记录后，登录屏障经确认清除且重启不复活',async t=>{
  const {app,request,seed}=await fixture(t);await seed('login-delete-001',{state:'cancelled',loginBarrier:true});await app.runner.restore();
  assert.equal((await request('tasks/login-delete-001','DELETE')).status,200);
  const restored=new TaskRunner(app.store,{enabled:false});await restored.restore();assert.equal(restored.info().blockedForLogin,'login-delete-001');await restored.resumeLogin();
  const again=new TaskRunner(app.store,{enabled:false});await again.restore();assert.equal(again.info().blockedForLogin,null);assert.deepEqual(again.queue,[]);
});
test('删除导入历史后再次导入不会复活或阻止服务启动',async t=>{
  const {root,app,request}=await fixture(t),stem='a5227f190a9eeb07_挂画_US_亚马逊竞品与Sif流量词_2026-11-09',research=path.join(root,'research'),images=path.join(research,stem+'_images');
  await fs.mkdir(images,{recursive:true});for(const file of ['design_thumb.jpg','design_original.jpg'])await fs.writeFile(path.join(images,file),'fixture');
  await fs.writeFile(path.join(research,stem+'.md'),'B0F6ND1QZH\n# 测试报告');await fs.writeFile(path.join(images,'B0F6ND1QZH_evidence.json'),JSON.stringify({titleArea:'Bunny Wall Art',selectedVariant:'已核实',main:{src:'https://example.test/image.jpg'}}));await fs.writeFile(path.join(images,'sif_status.json'),JSON.stringify({queries:[],selected_keywords:[],weekly_volumes:{}}));
  await importHistory(app.store,root);assert.ok(app.store.get('history-bunny-20261109'));assert.equal((await request('tasks/history-bunny-20261109','DELETE')).status,200);
  const restored=await new TaskStore(path.join(root,'jobs')).init();await importHistory(restored,root);assert.equal(restored.get('history-bunny-20261109'),null);assert.ok(restored.isDeleted('history-bunny-20261109'));
});
test('同时继续和删除同一任务，只有一方成功，已删除记录不会进入执行队列',async t=>{
  const {app,request,seed}=await fixture(t);await seed('racing-delete-001');
  const [removed,resumed]=await Promise.all([request('tasks/racing-delete-001','DELETE'),request('tasks/racing-delete-001/resume','POST')]);
  assert.ok(removed.status===200&&resumed.status===404||removed.status===409&&resumed.status===200);
  if(removed.status===200){assert.equal(app.store.get('racing-delete-001'),null);assert.ok(!app.runner.queue.includes('racing-delete-001'));}
});
test('删除接口校验来源，外站请求不得移除历史',async t=>{
  const {app,request,seed}=await fixture(t);await seed('origin-delete-001');
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/qa/api/tasks/origin-delete-001',{method:'DELETE',headers:{'content-type':'application/json','origin':'https://other.invalid'},body:'{}'});
  assert.equal(response.status,403);assert.equal((await request('tasks/origin-delete-001')).status,200);
});
