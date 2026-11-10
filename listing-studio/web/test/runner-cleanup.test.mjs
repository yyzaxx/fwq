import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {TaskStore} from '../lib/store.mjs';import {TaskRunner} from '../lib/runner.mjs';
async function tasks(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'listing-clean-run-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=await new TaskStore(dir).init();for(const id of ['image-001','image-002'])await store.create({category:'挂画'},{id,state:'staged'});return store}
async function settled(r){for(let n=0;n<200;n++){if(!r.draining)return;await new Promise(x=>setTimeout(x,10))}throw Error('未收尾')}
test('保存结果后、下一项启动前回收页面',async t=>{const store=await tasks(t),order=[];const r=new TaskRunner(store,{resetBrowser:async()=>{order.push('cleanup');return {closed:2}}});r.run=async id=>{order.push(id);await store.patch(id,{state:'completed',result:{reportFile:'report.md'}})};await r.enqueueMany(['image-001','image-002']);await settled(r);assert.deepEqual(order,['image-001','cleanup','image-002','cleanup']);assert.equal(store.get('image-001').result.reportFile,'report.md')});
test('登录暂停保留页面，用户恢复且任务结束后才清理',async t=>{const store=await tasks(t);let calls=0,first=true;const r=new TaskRunner(store,{resetBrowser:async()=>{calls++;return {closed:2}}});r.run=async id=>{await store.patch(id,{state:first?'needs_login':'partial',loginBarrier:first});first=false};await r.enqueue('image-001');await settled(r);assert.equal(calls,0);assert.equal(r.info().blockedForLogin,'image-001');await r.resumeLogin();await settled(r);assert.equal(calls,1)});
test('清理失败保留成果并暂停后续任务，重启后保留屏障，重试后继续',async t=>{const store=await tasks(t);const r=new TaskRunner(store,{resetBrowser:async()=>{throw Error('browser offline')}});r.run=id=>store.patch(id,{state:'completed',result:{reportFile:'report.md'}});await r.enqueueMany(['image-001','image-002']);await settled(r);assert.equal(store.get('image-001').state,'completed');assert.equal(store.get('image-002').state,'queued');assert.ok(r.info().browserCleanupError);const restored=new TaskRunner(store,{enabled:false,resetBrowser:async()=>({closed:1})});await restored.restore();assert.ok(restored.info().browserCleanupError);restored.run=r.run;restored.enabled=true;await restored.resumeLogin();await settled(restored);assert.equal(restored.info().browserCleanupError,null);assert.equal(store.get('image-002').state,'completed')});
test('已取消的登录受阻任务保留接管页面',async t=>{const store=await tasks(t);let calls=0;const r=new TaskRunner(store,{resetBrowser:async()=>{calls++;return {closed:1}}});r.run=id=>store.patch(id,{state:'cancelled',loginBarrier:true});await r.enqueueMany(['image-001','image-002']);await settled(r);assert.equal(calls,0);assert.equal(store.get('image-002').state,'queued');assert.equal(r.info().blockedForLogin,'image-001')});
test('整理成功后消除所有历史失败屏障，服务重启不会再次恢复旧错误',async t=>{const store=await tasks(t);for(const id of ['image-001','image-002'])await store.patch(id,{state:'completed',browserCleanup:{status:'failed',message:'旧清理错误',at:id}});const r=new TaskRunner(store,{enabled:false,resetBrowser:async()=>({closed:0})});await r.restore();await r.resumeLogin();const restored=new TaskRunner(store,{enabled:false});await restored.restore();assert.equal(restored.info().browserCleanupError,null)});
test('连续任务之间回收浏览器交换占用，下一项不会带着旧占用启动',async t=>{
 const store=await tasks(t);let swapped=0;
 const r=new TaskRunner(store,{resetBrowser:async()=>({closed:2}),recycleBrowser:async()=>{const before=swapped;swapped=0;return {restarted:before>0,before:{swapBytes:before},after:{swapBytes:0}}},resourceCheck:async()=>swapped>480?'交换空间接近硬上限':null});
 r.run=async id=>{await store.patch(id,{state:'completed'});if(id==='image-001')swapped=500};
 await r.enqueueMany(['image-001','image-002']);await settled(r);
 assert.equal(store.get('image-002').state,'completed');assert.equal(r.info().resourceError,null);assert.equal(store.get('image-001').browserCleanup.recycle.after.swapBytes,0);
});
test('浏览器进程资源回收失败时保留已有成果并暂停下一项',async t=>{
 const store=await tasks(t);let finished=false;
 const r=new TaskRunner(store,{resetBrowser:async()=>({closed:2}),recycleBrowser:async()=>{if(finished)throw Error('浏览器重启失败');return {restarted:false}},resourceCheck:async()=>null});
 r.run=async id=>{finished=true;await store.patch(id,{state:'completed',result:{reportFile:'report.md'}})};
 await r.enqueueMany(['image-001','image-002']);await settled(r);
 assert.equal(store.get('image-001').state,'completed');assert.equal(store.get('image-002').state,'queued');assert.ok(r.info().browserCleanupError);
});
test('登录接管中的页面不执行浏览器进程回收',async t=>{
 const store=await tasks(t);let browserAlive=true;
 const r=new TaskRunner(store,{resetBrowser:async()=>({closed:0}),recycleBrowser:async()=>{browserAlive=false;return {restarted:true}},resourceCheck:async()=>null});
 r.run=id=>store.patch(id,{state:'needs_login',loginBarrier:true});await r.enqueue('image-001');await settled(r);
 assert.equal(browserAlive,true);assert.equal(r.info().blockedForLogin,'image-001');
});
