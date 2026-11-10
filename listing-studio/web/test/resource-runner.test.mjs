import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-resource-'));
  const store=await new TaskStore(root).init();
  for(const id of ['guard-image-001','guard-image-002']){
    await store.create({category:'挂画',templateOne:'{主体}',templateTwo:'{主体}',ranges:[[1,80],[1,120]]},{id,state:'staged',imageFile:'design.jpg'});
    await fs.writeFile(path.join(store.directory(id),'preview.jpg'),'fixture');
  }
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,store};
}
async function waitFor(check,timeout=2500){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,10));}
  throw Error('等待测试状态超时');
}
const cleanup=async()=>({closed:0});
test('资源暂停恢复前先释放浏览器旧交换页，再检查并恢复原任务',async t=>{
  const {store}=await fixture(t);let swapped=500;
  await store.patch('guard-image-001',{state:'failed',resourcePause:{status:'paused',message:'交换空间接近硬上限'}});
  const r=new TaskRunner(store,{enabled:false,resetBrowser:cleanup,recycleBrowser:async()=>{swapped=0;return {restarted:true}},resourceCheck:async()=>swapped>=480?'交换空间接近硬上限':null});
  await r.restore();r.run=id=>store.patch(id,{state:'completed'});r.enabled=true;await r.resumeLogin();await waitFor(()=>!r.draining);
  assert.equal(store.get('guard-image-001').state,'completed');assert.equal(r.info().resourceError,null);
});
test('资源不足时不启动执行器，暂停屏障持久保存，恢复后才继续',async t=>{
  const {store}=await fixture(t);
  const runner=new TaskRunner(store,{resourceCheck:async()=> '服务器内存不足',resetBrowser:cleanup});
  const order=[];runner.run=async id=>{order.push(id);await store.patch(id,{state:'partial'})};
  await runner.enqueueMany(['guard-image-001','guard-image-002']);await waitFor(()=>!runner.draining);
  assert.deepEqual(order,[]);assert.ok(runner.info().resourceError);assert.equal(runner.queue.length,2);
  const restored=new TaskRunner(store,{enabled:false,resourceCheck:async()=>null,resetBrowser:cleanup});
  await restored.restore();assert.ok(restored.info().resourceError);
  restored.run=runner.run;restored.enabled=true;await restored.resumeLogin();await waitFor(()=>!restored.draining);
  assert.deepEqual(order,['guard-image-001','guard-image-002']);assert.equal(restored.info().resourceError,null);
});
test('继续队列会先恢复被资源保护中止的任务，保留资料并去掉重复排队',async t=>{
  const {store}=await fixture(t),id='guard-image-001';
  await fs.writeFile(path.join(store.directory(id),'saved-competitor.json'),'{"asin":"saved"}');
  await store.patch(id,{state:'failed',queueOrder:1,resourcePause:{status:'paused',message:'交换空间占用过高',at:'2026-11-10T04:28:00Z'}});
  await store.patch('guard-image-002',{state:'queued',queueOrder:2});
  const runner=new TaskRunner(store,{enabled:false,resourceCheck:async()=>null,resetBrowser:cleanup}),order=[];
  await runner.restore();runner.run=async taskId=>{order.push(taskId);await store.patch(taskId,{state:'partial'})};runner.enabled=true;
  await runner.resumeLogin();await waitFor(()=>!runner.draining);
  assert.deepEqual(order,['guard-image-001','guard-image-002']);assert.equal(runner.info().resourceError,null);
  assert.equal(await fs.readFile(path.join(store.directory(id),'saved-competitor.json'),'utf8'),'{"asin":"saved"}');
  assert.equal(store.get(id).resourcePause.status,'resolved');
});
test('恢复资源暂停不会重跑用户已经取消的任务',async t=>{
  const {store}=await fixture(t);await store.patch('guard-image-001',{state:'cancelled',resourcePause:{status:'paused',message:'资源不足'}});await store.patch('guard-image-002',{state:'queued'});
  const runner=new TaskRunner(store,{enabled:false,resourceCheck:async()=>null,resetBrowser:cleanup}),order=[];await runner.restore();runner.run=async id=>{order.push(id);await store.patch(id,{state:'partial'})};runner.enabled=true;
  await runner.resumeLogin();await waitFor(()=>!runner.draining);assert.deepEqual(order,['guard-image-002']);assert.equal(store.get('guard-image-001').state,'cancelled');
});
test('服务异常重启后保留中断任务顺序，未经确认不得自动重跑',async t=>{
  const {store}=await fixture(t);await store.patch('guard-image-001',{state:'running',queueOrder:1});await store.patch('guard-image-002',{state:'queued',queueOrder:2});
  const runner=new TaskRunner(store,{resourceCheck:async()=>null,resetBrowser:cleanup}),order=[];
  runner.run=async id=>{order.push(id);await store.patch(id,{state:'partial'})};
  await runner.restore();await waitFor(()=>!runner.draining);
  assert.deepEqual(order,[]);assert.ok(runner.info().resourceError);
  assert.deepEqual(runner.queue,['guard-image-001','guard-image-002']);
  await runner.resumeLogin();await waitFor(()=>!runner.draining);assert.deepEqual(order,['guard-image-001','guard-image-002']);
});
test('任务运行中资源超限会终止执行器并暂停后续图片',async t=>{
  const {root,store}=await fixture(t),executor=path.join(root,'executor');
  await fs.writeFile(executor,'#!/usr/bin/env node\nconst fs=require("fs");process.on("SIGTERM",()=>{});fs.writeFileSync("started","1");setInterval(()=>{},100);\n',{mode:0o700});
  const runner=new TaskRunner(store,{executor,resetBrowser:cleanup,resourceCheck:async({phase})=>phase==='running'&&await fs.access(path.join(store.directory('guard-image-001'),'started')).then(()=>true,()=>false)?'服务器内存不足':null,resourceIntervalMs:30,killGraceMs:40});
  t.after(async()=>{if(runner.child)await runner.cancel('guard-image-001')});
  await runner.enqueueMany(['guard-image-001','guard-image-002']);await waitFor(()=>!runner.draining);
  assert.equal(store.get('guard-image-001').state,'failed');assert.equal(store.get('guard-image-002').state,'queued');
  assert.equal(store.get('guard-image-001').resourcePause.status,'paused');assert.ok(runner.info().resourceError);
  await assert.rejects(fs.access(path.join(store.directory('guard-image-002'),'started')));
});
test('超时的执行器拒绝SIGTERM时仍会被强制终止，不会永久占住队列',async t=>{
  const {root,store}=await fixture(t),executor=path.join(root,'executor');
  await fs.writeFile(executor,'#!/usr/bin/env node\nconst fs=require("fs");process.on("SIGTERM",()=>fs.writeFileSync("term-seen","1"));fs.writeFileSync("started","1");setInterval(()=>{},100);\n',{mode:0o700});
  const runner=new TaskRunner(store,{executor,resetBrowser:cleanup,resourceCheck:async()=>null,runTimeoutMs:600,killGraceMs:40});
  t.after(async()=>{if(runner.child)await runner.cancel('guard-image-001')});
  await runner.enqueue('guard-image-001');await waitFor(()=>!runner.draining);
  assert.equal(store.get('guard-image-001').state,'failed');assert.match(store.get('guard-image-001').message,/超时|超过/);
  await fs.access(path.join(store.directory('guard-image-001'),'term-seen'));
});
test('等待资源检查期间取消队列，不得误启动下一项或写入不存在的任务',async t=>{
  const {store}=await fixture(t);let release,entered;
  const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
  const runner=new TaskRunner(store,{resourceCheck:async()=>{entered();await gate;return '内存不足'},resetBrowser:cleanup});
  const order=[];runner.run=async id=>order.push(id);
  await runner.enqueue('guard-image-001');await started;await runner.cancel('guard-image-001');release();await waitFor(()=>!runner.draining);
  assert.deepEqual(order,[]);assert.equal(runner.info().resourceError,null);assert.equal(store.get('guard-image-001').state,'cancelled');
});
test('资源检查自身失败时安全暂停，不让异步异常退出后端',async t=>{
  const {store}=await fixture(t),runner=new TaskRunner(store,{resourceCheck:async()=>{throw Error('unavailable')},resetBrowser:cleanup});
  runner.run=async()=>assert.fail('不应运行');await runner.enqueue('guard-image-001');await waitFor(()=>!runner.draining);assert.match(runner.info().resourceError,/检查/);
});
test('执行器启动失败或立刻退出时记录失败，不因管道错误崩溃',async t=>{
  const {root,store}=await fixture(t);
  for(const [id,executor] of [['guard-image-001','/bin/false'],['guard-image-002',path.join(root,'missing-executor')]]){
    const runner=new TaskRunner(store,{executor,resetBrowser:cleanup,resourceCheck:async()=>null});await runner.enqueue(id);await waitFor(()=>!runner.draining);assert.equal(store.get(id).state,'failed');
  }
});
test('执行器结束后回收它遗留的辅助进程，避免跨任务累积',async t=>{
  const {root,store}=await fixture(t),executor=path.join(root,'executor');
  await fs.writeFile(executor,'#!/usr/bin/env node\nconst fs=require("fs"),cp=require("child_process");const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync("helper-pid",String(child.pid));fs.writeFileSync("result.json",JSON.stringify({status:"partial",message:"fixture",titles:[],keywords:[],competitors:[],reportFile:""}));process.exit(0);\n',{mode:0o700});
  const runner=new TaskRunner(store,{executor,resetBrowser:cleanup,resourceCheck:async()=>null});await runner.enqueue('guard-image-001');await waitFor(()=>!runner.draining);
  assert.equal(store.get('guard-image-001').state,'partial');const pid=Number(await fs.readFile(path.join(store.directory('guard-image-001'),'helper-pid'),'utf8'));
  await waitFor(async()=>{try{return /^\d+ \(.+\) Z /.test(await fs.readFile('/proc/'+pid+'/stat','utf8'));}catch{return true;}});
});
