import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

const input={category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]]};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-resume-all-'));
  const app=await createApp({dataRoot:root,basePath:'/qa/',importExisting:false,runnerEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  app.runner.resourceCheck=async()=>null;
  app.runner.resetBrowser=async()=>({closed:0});
  app.runner.recycleBrowser=async()=>({restarted:false});
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port+'/qa/';
  const resume=()=>fetch(base+'api/queue/resume-all',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  return {...app,resume,base};
}
async function settled(runner){for(let i=0;i<150&&runner.draining;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(runner.draining,false);}

test('一键恢复中断和手动停止的任务，保留文件，跳过已完成、部分完成、缺资料及已删除记录',async t=>{
  const {store,runner,resume}=await fixture(t);
  for(const [i,state] of ['failed','cancelled','completed','partial','needs_input','failed','queued'].entries()){
    await store.create(input,{id:'bulk-task-'+i,state,queueOrder:i+1,mode:'full',result:{competitors:[{asin:'B012345678'}],keywords:[],titles:[{text:'old title'}],reportFile:'report.md'}});
    await fs.writeFile(path.join(store.directory('bulk-task-'+i),'report.md'),'saved evidence '+i);
  }
  await store.remove('bulk-task-5');await runner.restore();
  const untouched=['bulk-task-2','bulk-task-3','bulk-task-4','bulk-task-5'].map(id=>store.get(id,{includeDeleted:true}));
  const responses=await Promise.all([resume(),resume()]);
  assert.deepEqual(responses.map(r=>r.status),[200,200]);
  const results=await Promise.all(responses.map(r=>r.json()));assert.equal(results.reduce((n,r)=>n+r.resumedCount,0),2);
  assert.deepEqual(runner.queue,['bulk-task-6','bulk-task-0','bulk-task-1']);
  for(const id of ['bulk-task-0','bulk-task-1']){
    assert.equal(store.get(id).state,'queued');assert.equal(store.get(id).mode,'full');
    assert.deepEqual(store.get(id).result.titles,[]);
    assert.equal(await fs.readFile(path.join(store.directory(id),'report.md'),'utf8'),'saved evidence '+id.at(-1));
  }
  assert.deepEqual(['bulk-task-2','bulk-task-3','bulk-task-4','bulk-task-5'].map(id=>store.get(id,{includeDeleted:true})),untouched);
});

test('资源仍不足时不启动任务，恢复后仍串行执行并可从磁盘重建队列',async t=>{
  const {store,runner,resume}=await fixture(t);
  await store.create(input,{id:'paused-resource',state:'failed',queueOrder:1,resourcePause:{status:'paused',message:'交换空间接近硬上限'}});
  await store.create(input,{id:'paused-manual',state:'cancelled',queueOrder:2});
  await runner.restore();runner.resourceCheck=async()=>'交换空间接近硬上限';runner.enabled=true;
  let response=await resume();assert.equal(response.status,200);assert.ok((await response.json()).resourceError);
  assert.equal(runner.active,null);assert.equal(store.get('paused-resource').resourcePause.status,'paused');
  assert.deepEqual(runner.queue,['paused-resource','paused-manual']);
  runner.queue=[];await runner.restore();assert.deepEqual(runner.queue,['paused-resource','paused-manual']);
  runner.run=async id=>{
    assert.equal(store.list().filter(t=>t.state==='running').length,0);
    await store.patch(id,{state:'running'});await new Promise(resolve=>setTimeout(resolve,15));await store.patch(id,{state:'completed'});
  };
  runner.resourceCheck=async()=>null;
  response=await resume();assert.equal(response.status,200);await settled(runner);
  assert.equal(runner.info().resourceError,null);assert.equal(store.get('paused-resource').resourcePause.status,'resolved');
  assert.equal(store.get('paused-resource').state,'completed');assert.equal(store.get('paused-manual').state,'completed');
});

test('等待登录的任务可一键重试，验证仍未完成时继续保留登录屏障和页面',async t=>{
  const {store,runner,resume}=await fixture(t);
  await store.create(input,{id:'paused-login',state:'needs_login',loginBarrier:true,mode:'full'});
  await store.create(input,{id:'paused-after-login',state:'cancelled'});
  await runner.restore();let cleanups=0;runner.resetBrowser=async()=>{cleanups++;return {closed:0}};
  runner.run=id=>store.patch(id,{state:'needs_login',loginBarrier:true});runner.enabled=true;
  const response=await resume();assert.equal(response.status,200);await settled(runner);
  assert.equal(store.get('paused-login').state,'needs_login');assert.equal(runner.blockedForLogin,'paused-login');
  assert.deepEqual(runner.queue,['paused-after-login']);assert.equal(store.get('paused-after-login').state,'queued');assert.equal(cleanups,0);
});

test('批量恢复不会改动正在运行或收尾的任务，也不会重复加入队列',async t=>{
  const {store,runner,resume}=await fixture(t);
  await store.create(input,{id:'paused-active',state:'failed'});runner.active='paused-active';
  await store.create(input,{id:'paused-current',state:'running'});
  await store.create(input,{id:'paused-ready',state:'cancelled'});
  const response=await resume();assert.equal(response.status,200);assert.equal((await response.json()).resumedCount,1);
  assert.equal(runner.active,'paused-active');assert.equal(store.get('paused-active').state,'failed');assert.equal(store.get('paused-current').state,'running');
  assert.deepEqual(runner.queue,['paused-ready']);
});
