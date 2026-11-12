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

test('Amazon验证后关闭页面、保存进度并阻止整个队列提前继续',async t=>{
 const f=await fixture(t),saved=f.store.get('cooldown-task-001').result;await hit(f);assert.equal(f.closed(),1);assert.equal(f.runner.info().cooldown.site,'amazon');assert.equal(Date.parse(f.runner.info().cooldown.until)-Date.parse('2026-11-12T12:00:00Z'),30*60000);assert.deepEqual(f.store.get('cooldown-task-001').result,saved);
 let started=0;f.runner.run=async()=>started++;await f.runner.resumeLogin();await f.runner.drain();assert.equal(started,0);f.advance(30*60000-1);await f.runner.expireCooldown();assert.ok(f.runner.info().cooldown);assert.equal(started,0);
});
test('到期后只恢复一次，先继续受阻任务再继续原队列',async t=>{
 const f=await fixture(t);await hit(f);f.advance(30*60000);await Promise.all([f.runner.expireCooldown(),f.runner.expireCooldown()]);assert.equal(f.runner.info().cooldown,null);const order=[];f.runner.run=async id=>{order.push(id);await f.store.patch(id,{state:'partial'})};await f.runner.drain();assert.deepEqual(order,['cooldown-task-001','cooldown-task-002']);
});
test('重启保留原截止时间和受阻任务顺序',async t=>{
 const f=await fixture(t);await hit(f);const until=f.runner.info().cooldown.until;f.advance(10*60000);const r=new TaskRunner(f.store,f.options);t.after(()=>r.dispose());await r.restore();assert.equal(r.info().cooldown.until,until);await r.resumeLogin();assert.ok(r.info().cooldown);f.advance(20*60000);await r.expireCooldown();assert.equal(r.info().cooldown,null);assert.deepEqual(r.queue,['cooldown-task-001','cooldown-task-002']);
});
test('停止受阻任务不会自动重启它，剩余任务仍等到期',async t=>{
 const f=await fixture(t);await hit(f);await f.runner.cancel('cooldown-task-001');f.advance(30*60000);await f.runner.expireCooldown();const order=[];f.runner.run=async id=>{order.push(id);await f.store.patch(id,{state:'partial'})};await f.runner.drain();assert.deepEqual(order,['cooldown-task-002']);assert.equal(f.store.get('cooldown-task-001').state,'cancelled');
});
test('删除已经停止的任务也不影响全局等待与剩余队列',async t=>{
 const f=await fixture(t);await hit(f);await f.runner.cancel('cooldown-task-001');await f.runner.deleteHistory(['cooldown-task-001']);f.advance(30*60000);await f.runner.expireCooldown();assert.equal(f.store.get('cooldown-task-001'),null);assert.deepEqual(f.runner.queue,['cooldown-task-002']);
});
test('再次验证会从新页面关闭时重新等待30分钟',async t=>{
 const f=await fixture(t);await hit(f);f.advance(30*60000);await f.runner.expireCooldown();await hit(f);assert.equal(Date.parse(f.runner.info().cooldown.until),Date.parse('2026-11-12T13:00:00Z'));assert.equal(f.closed(),2);
});
test('Sif登录、普通Amazon账号页、一般失败不进入等待重试',async t=>{
 const f=await fixture(t);for(const message of ['Sif需要登录','Amazon已核实，Sif需要人机验证','Amazon普通账号登录页面','Amazon公开页面页脚Sign in']){await f.store.patch('cooldown-task-001',{state:'needs_login',loginBarrier:true,browserBlock:null,message});assert.equal(await f.runner.maybeStartCooldown('cooldown-task-001'),false)}assert.equal(f.closed(),0);assert.equal(f.runner.info().cooldown,null);
});
test('旧版明确Amazon验证码说明可识别，人工停止不自动复活',async t=>{
 const f=await fixture(t);await hit(f,'cooldown-task-001',{browserBlock:null,message:'Amazon核验第4款时出现人机验证，已保存3款竞品'});assert.ok(f.runner.info().cooldown);await f.runner.cancel('cooldown-task-001');f.advance(30*60000);await f.runner.expireCooldown();assert.equal(await f.runner.maybeStartCooldown('cooldown-task-001'),false);
});
test('关闭页面失败时安全暂停，成功关闭后才从零计算30分钟',async t=>{
 const f=await fixture(t),reset=f.runner.resetBrowser;f.runner.resetBrowser=async()=>{throw Error('CDP不可用')};await hit(f);assert.match(f.runner.info().browserCleanupError,/CDP/);assert.ok(f.runner.info().cooldown.closeError);f.advance(30*60000);f.runner.resetBrowser=reset;await f.runner.expireCooldown();assert.equal(Date.parse(f.runner.info().cooldown.until),Date.parse('2026-11-12T13:00:00Z'));assert.equal(f.runner.info().browserCleanupError,null);
});
test('等待结束仍遵守资源保护，不启动执行器',async t=>{
 const f=await fixture(t);await hit(f);f.advance(30*60000);f.runner.resourceCheck=async()=> '内存不足';await f.runner.expireCooldown();let started=0;f.runner.run=async()=>started++;await f.runner.drain();assert.equal(started,0);assert.match(f.runner.info().resourceError,/内存/);
});
test('关键词专用任务保留换词操作、现有词库和运行模式',async t=>{
 const f=await fixture(t),job={id:'swap-keyword',status:'pending',action:'replace',term:'frog decor'};await f.store.patch('cooldown-task-001',{mode:'keywords_only',keywordJob:job});await hit(f);f.advance(30*60000);await f.runner.expireCooldown();const task=f.store.get('cooldown-task-001');assert.equal(task.mode,'keywords_only');assert.deepEqual(task.keywordJob,job);assert.equal(task.result.keywords.length,0);
});
test('损坏的持久化等待记录必须暂停而非忽略',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'browser-cooldown.json'),'{broken');const r=new TaskRunner(f.store,f.options);t.after(()=>r.dispose());await r.restore();assert.match(r.info().resourceError,/等待记录/);
});

test('真实drain链路自动挂起并通过单个到期回调唤醒，不需要用户点击',async t=>{
 const f=await fixture(t),pending=new Set();f.runner.enabled=true;f.runner.setTimer=(callback,ms)=>{const handle={callback,ms,unref(){}};pending.add(handle);return handle};f.runner.clearTimer=handle=>pending.delete(handle);const order=[];let first=true;
 f.runner.run=async id=>{order.push(id);await f.store.patch(id,first?{state:'needs_login',loginBarrier:true,browserBlock:marker,message:'Amazon 人机验证'}:{state:'partial'});first=false};await f.runner.drain();assert.deepEqual(order,['cooldown-task-001']);assert.equal(pending.size,1);assert.equal([...pending][0].ms,30*60000);
 await f.runner.resumeAll();await f.runner.drain();assert.deepEqual(order,['cooldown-task-001']);f.advance(30*60000);const callback=[...pending][0].callback;pending.clear();callback();
 for(let i=0;i<100&&order.length<3;i++)await new Promise(r=>setTimeout(r,5));assert.deepEqual(order,['cooldown-task-001','cooldown-task-001','cooldown-task-002']);
 for(let i=0;i<100&&f.runner.draining;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.runner.info().cooldown,null);assert.equal(pending.size,0);
});
test('服务关闭后迟到的定时回调不能恢复任务',async t=>{
 const f=await fixture(t);await hit(f);f.advance(30*60000);f.runner.dispose();await f.runner.expireCooldown();assert.ok(f.runner.info().cooldown);let starts=0;f.runner.run=async()=>starts++;await f.runner.drain();assert.equal(starts,0);
});
test('已经过期的等待记录在恢复后不会额外再等30分钟',async t=>{
 const f=await fixture(t);await hit(f);const until=f.runner.info().cooldown.until;f.advance(31*60000);const r=new TaskRunner(f.store,f.options);t.after(()=>r.dispose());await r.restore();assert.equal(r.info().cooldown.until,until);await r.expireCooldown();assert.equal(r.info().cooldown,null);assert.equal(f.closed(),1);
});

test('完整调研和换词执行器的结构化验证结果都进入统一等待',async t=>{
 for(const mode of ['full','keywords_only']){
  const f=await fixture(t),id='cooldown-task-001',dir=f.store.directory(id),executor=path.join(f.root,'executor');
  await f.store.patch(id,{imageFile:'design.jpg',mode,...(mode==='keywords_only'?{keywordJob:{id:'keyword-cooldown-run',action:'refresh',status:'pending',excludedTerms:[]}}:{})});
  await fs.writeFile(path.join(dir,'preview.jpg'),'fixture');await fs.writeFile(path.join(dir,'design.jpg'),'fixture');
  await fs.writeFile(executor,'#!/usr/bin/env node\nconst fs=require("fs");process.stdin.resume();process.stdin.on("end",()=>fs.writeFileSync("result.json",JSON.stringify({status:"needs_login",message:"暂停",browserBlock:{site:"amazon",kind:"human_verification"},titles:[],keywords:[],competitors:[],reportFile:""})));\n',{mode:0o700});
  f.runner.executor=executor;await f.runner.drain();assert.equal(f.closed(),1);assert.ok(f.runner.info().cooldown);assert.equal(f.store.get(id).state,'queued');assert.equal(f.store.get(id).mode,mode);assert.equal(f.store.get('cooldown-task-002').state,'queued');
 }
});

test('兼容旧规则无需账号登录的验证码说明，不混淆普通账号登录',()=>{
 assert.equal(isAmazonVerification({status:'needs_login',message:'Amazon 人机验证，无需账号登录'}),true);
 assert.equal(isAmazonVerification({status:'needs_login',message:'Amazon只是普通账号登录，不是人机验证'}),false);
});

test('等待到期后尚未启动时服务重启，受阻任务仍排在后续任务之前',async t=>{
 const f=await fixture(t);f.runner.run=async id=>f.store.patch(id,{state:'needs_login',loginBarrier:true,browserBlock:marker,message:'Amazon人机验证'});await f.runner.drain();f.advance(30*60000);await f.runner.expireCooldown();const restored=new TaskRunner(f.store,f.options);t.after(()=>restored.dispose());await restored.restore();assert.deepEqual(restored.queue,['cooldown-task-001','cooldown-task-002']);
});
