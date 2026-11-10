import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server.mjs';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';

const input={category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]]};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-restart-'));
  const app=await createApp({dataRoot:root,basePath:'/qa/',importExisting:false,runnerEnabled:false});
  app.runner.resourceCheck=async()=>null;app.runner.recycleBrowser=async()=>({restarted:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port+'/qa/api/';
  const request=(id,headers={})=>fetch(base+'tasks/'+id+'/restart',{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'});
  const seed=async(extras={})=>{
    const task=await app.store.create(input,{id:'restart-source',name:'原商品',imageFile:'design.png',previewFile:'preview.jpg',state:'completed',stage:'done',mode:'titles_only',result:{reportFile:'report.md',competitors:[{asin:'B012345678'}],keywords:[{term:'bunny decor'}],titles:[{text:'旧标题'}]},...extras});
    for(const file of ['design.png','preview.jpg','report.md','progress.json','research.json','result.json'])await fs.writeFile(path.join(app.store.directory(task.id),file),'old-'+file);
    await fs.mkdir(path.join(app.store.directory(task.id),'artifacts'));await fs.writeFile(path.join(app.store.directory(task.id),'artifacts/old.json'),'old evidence');
    return task;
  };
  return {...app,root,request,seed};
}

test('重新开始只带原图和模板进入新目录，从完整调研开始，旧报告和来源数据保留',async t=>{
  const f=await fixture(t),before=await f.seed({batchId:'original-batch',batchIndex:2,batchTotal:3});
  const response=await f.request(before.id);assert.equal(response.status,200);const next=await response.json();
  assert.notEqual(next.id,before.id);assert.equal(next.restartedFrom,before.id);assert.equal(next.mode,'full');assert.equal(next.state,'queued');assert.deepEqual(next.input,input);
  for(const key of ['result','resourcePause','browserCleanup','loginBarrier','batchId','batchIndex','startedAt','finishedAt'])assert.equal(next[key],undefined,key);
  assert.deepEqual((await fs.readdir(f.store.directory(next.id))).sort(),['design.png','preview.jpg','task.json']);
  assert.equal(await fs.readFile(path.join(f.store.directory(next.id),'design.png'),'utf8'),'old-design.png');
  for(const file of ['report.md','progress.json','research.json','result.json'])assert.equal(await fs.readFile(path.join(f.store.directory(before.id),file),'utf8'),'old-'+file);
  assert.deepEqual(f.store.get(before.id).result,before.result);assert.equal(f.store.get(before.id).state,'completed');assert.equal(f.store.get(before.id).latestRestartId,next.id);
  assert.deepEqual(f.runner.queue,[next.id]);const restored=await new TaskStore(f.root).init();assert.equal(restored.get(next.id).restartedFrom,before.id);
});

test('同时或紧接着重复点击，只创建一个正在排队的新任务',async t=>{
  const f=await fixture(t);await f.seed();
  const responses=await Promise.all([f.request('restart-source'),f.request('restart-source')]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
  const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.equal(a.id,b.id);
  const again=await(await f.request('restart-source')).json();assert.equal(again.id,a.id);assert.equal(f.store.list().length,2);assert.deepEqual(f.runner.queue,[a.id]);
});

test('运行、排队、等待登录和正在收尾的原任务要先停止，不能生成并行副本',async t=>{
  const f=await fixture(t);await f.seed();
  for(const state of ['running','queued','cancelling','needs_login','staged']){
    await f.store.patch('restart-source',{state});assert.equal((await f.request('restart-source')).status,409);assert.equal(f.store.list().length,1);
  }
  await f.store.patch('restart-source',{state:'completed'});f.runner.active='restart-source';assert.equal((await f.request('restart-source')).status,409);
});

test('删除、模板缺失或原图缺失的任务不能重启，不留下空任务目录',async t=>{
  const f=await fixture(t);await f.seed();
  await f.store.patch('restart-source',{input:{...input,templateOne:''}});assert.equal((await f.request('restart-source')).status,400);assert.equal(f.store.list().length,1);
  await f.store.patch('restart-source',{input});await fs.rm(path.join(f.store.directory('restart-source'),'design.png'));
  assert.equal((await f.request('restart-source')).status,400);assert.equal(f.store.list().length,1);
  assert.deepEqual((await fs.readdir(f.root,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name),['restart-source','_batches'].sort());
  await f.store.remove('restart-source');assert.equal((await f.request('restart-source')).status,404);
});

test('新记录写入失败时旧记录不变、没有幽灵任务或遗留目录',async t=>{
  const f=await fixture(t),before=await f.seed(),write=f.store.write.bind(f.store);
  f.store.write=task=>task.id===before.id?write(task):Promise.reject(Error('磁盘写入失败'));
  assert.equal((await f.request(before.id)).status,400);assert.deepEqual(f.store.get(before.id),before);assert.equal(f.store.list().length,1);
  assert.deepEqual((await fs.readdir(f.root,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name).sort(),['_batches','restart-source']);
});

test('资源暂停时新任务仍等待资源恢复，继续队列只跑新任务而不重跑被替代的旧尝试',async t=>{
  const f=await fixture(t);await f.seed({state:'failed',resourcePause:{status:'paused',message:'资源不足'}});await f.runner.restore();f.runner.resourceCheck=async()=>'资源仍不足';
  const response=await f.request('restart-source');assert.equal(response.status,200);const next=await response.json();assert.ok(f.runner.resourceError);assert.deepEqual(f.runner.queue,[next.id]);
  f.runner.resourceCheck=async()=>null;await f.runner.resumeAll();assert.equal(f.runner.resourceError,null);assert.deepEqual(f.runner.queue,[next.id]);assert.equal(f.store.get('restart-source').state,'failed');
});

test('重启已停止的登录受阻尝试不会绕过验证，确认登录后只恢复新任务',async t=>{
  const f=await fixture(t);await f.seed({state:'cancelled',loginBarrier:true});await f.runner.restore();
  const response=await f.request('restart-source');assert.equal(response.status,200);const next=await response.json();assert.equal(f.runner.blockedForLogin,'restart-source');
  await f.runner.resumeAll();assert.equal(f.runner.blockedForLogin,null);assert.deepEqual(f.runner.queue,[next.id]);assert.equal(f.store.get('restart-source').state,'cancelled');
  const restored=new TaskRunner(f.store,{enabled:false});await restored.restore();assert.deepEqual(restored.queue,[next.id]);assert.equal(restored.blockedForLogin,null);
});

test('新任务完成后可再次从头开始，原记录不加入批量暂停恢复',async t=>{
  const f=await fixture(t);await f.seed({state:'failed'});const first=await(await f.request('restart-source')).json();await f.runner.cancel(first.id);await f.store.patch(first.id,{state:'completed'});
  const second=await(await f.request('restart-source')).json();assert.notEqual(second.id,first.id);await f.runner.resumeAll();assert.deepEqual(f.runner.queue,[second.id]);assert.equal(f.store.get('restart-source').state,'failed');
});

test('跨站请求不得重新开始用户任务',async t=>{
  const f=await fixture(t);await f.seed();assert.equal((await f.request('restart-source',{origin:'https://other.invalid'})).status,403);assert.equal(f.store.list().length,1);
});

test('停止首次重跑后再次从原记录重开，批量继续不会复活已被替代的尝试',async t=>{
  const f=await fixture(t);await f.seed({state:'failed'});const first=await(await f.request('restart-source')).json();await f.runner.cancel(first.id);
  const second=await(await f.request('restart-source')).json();assert.notEqual(second.id,first.id);
  await f.runner.resumeAll();assert.deepEqual(f.runner.queue,[second.id]);assert.equal(f.store.get(first.id).state,'cancelled');assert.equal(f.store.get(first.id).latestRestartId,second.id);
});

test('新任务准备完成后服务意外重启，保留新任务并暂停等待确认，不遗留无法继续的准备记录',async t=>{
  const f=await fixture(t);await f.seed();
  await f.store.create(input,{id:'restart-prepared',state:'staged',restartedFrom:'restart-source',mode:'full',imageFile:'design.png',previewFile:'preview.jpg'});
  const restored=new TaskRunner(f.store,{enabled:false,resourceCheck:async()=>null});await restored.restore();
  assert.equal(f.store.get('restart-prepared').state,'queued');assert.deepEqual(restored.queue,['restart-prepared']);assert.ok(restored.resourceError);
  assert.equal(f.store.get('restart-source').latestRestartId,'restart-prepared');assert.equal(f.store.get('restart-source').state,'completed');
  await restored.resumeLogin();assert.equal(restored.resourceError,null);assert.deepEqual(restored.queue,['restart-prepared']);
});
