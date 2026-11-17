import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';
import {isAmazonVerification} from '../lib/browser-cooldown.mjs';

const marker={site:'amazon',kind:'human_verification'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-cooldown-')),store=await new TaskStore(root).init();let time=Date.parse('2026-11-12T12:00:00Z'),closed=0;
 const options={enabled:false,now:()=>time,resourceCheck:async()=>null,resetBrowser:async()=>{closed++;return {closed:1}},recycleBrowser:async()=>({restarted:false})};
 const runner=new TaskRunner(store,options);t.after(async()=>{runner.dispose?.();await fs.rm(root,{recursive:true,force:true})});
 for(const id of ['cooldown-task-001','cooldown-task-002'])await store.create({category:'挂画'},{id,state:'queued',mode:'full',queueOrder:id.endsWith('1')?1:2,result:{status:'partial',competitors:[],keywords:[],titles:[]}});
 runner.queue=['cooldown-task-001','cooldown-task-002'];
 return {root,store,runner,options,advance:ms=>time+=ms,closed:()=>closed};
}
async function hit(f,id='cooldown-task-001',extra={}){await f.store.patch(id,{state:'needs_login',loginBarrier:true,browserBlock:marker,message:'Amazon 人机验证',...extra});return f.runner.maybeStartCooldown(id)}

test('Amazon验证不再创建倒计时，保留页面、资料并暂停队列',async t=>{
 const f=await fixture(t),saved=f.store.get('cooldown-task-001').result;
 f.runner.run=async id=>{await hit(f,id)};
 await f.runner.drain();
 assert.equal(f.runner.info().cooldown,null);
 assert.equal(f.runner.info().blockedForLogin,'cooldown-task-001');
 assert.equal(f.closed(),0);
 assert.deepEqual(f.store.get('cooldown-task-001').result,saved);
 assert.deepEqual(f.runner.queue,['cooldown-task-002']);
});
test('旧等待记录迁移为可立即手动恢复的验证暂停，停止任务不复活',async t=>{
 for(const state of ['queued','cancelled']){
 const f=await fixture(t);await f.store.patch('cooldown-task-001',{state,browserCooldown:'2099-01-01T00:00:00Z'});
 await fs.writeFile(path.join(f.root,'browser-cooldown.json'),JSON.stringify({version:1,active:{taskId:'cooldown-task-001',site:'amazon',kind:'human_verification',startedAt:'2026-11-12T12:00:00Z',until:'2099-01-01T00:00:00Z',closedAt:'2026-11-12T12:00:00Z'}}));
 const r=new TaskRunner(f.store,f.options);t.after(()=>r.dispose());await r.restore();
 assert.equal(r.info().cooldown,null);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'browser-cooldown.json'),'utf8')).active,null);
 assert.equal(f.store.get('cooldown-task-001').state,state==='queued'?'needs_login':'cancelled');
 if(state==='queued'){
 const order=[];r.run=async id=>{order.push(id);await f.store.patch(id,{state:'partial',loginBarrier:false})};
 r.resetBrowser=async()=>({closed:0});await r.resumeLogin({retryTask:true});await r.drain();
 assert.deepEqual(order,['cooldown-task-001','cooldown-task-002']);
 }
 }
});
