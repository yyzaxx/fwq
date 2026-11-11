import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server.mjs';
import {TaskRunner} from '../lib/runner.mjs';

import {fixture,kw} from './support/keywords-fixture.mjs';

test('删除一个词立即同步词表及报告，保留其他词、竞品和原报告，标题失效',async t=>{
 const f=await fixture(t),r=await f.request({action:'delete',term:'funny frog decor'});assert.equal(r.status,200);const next=await r.json();
 assert.deepEqual(next.result.keywords.map(w=>w.term),['frog wall art','green frog painting']);assert.deepEqual(next.result.competitors,f.task.result.competitors);assert.deepEqual(next.result.titles,[]);assert.equal(next.titlesStale,true);assert.equal(next.state,'partial');assert.equal(next.counts.keywords,2);
 assert.equal(await fs.readFile(path.join(f.store.directory(f.task.id),'report.md'),'utf8'),'original report frog wall art');
 const report=await(await fetch(f.base+'tasks/'+f.task.id+'/report.md')).text();assert.match(report,/frog wall art, green frog painting/);assert.doesNotMatch(report,/funny frog decor|Frog Print/);assert.match(report,/标题待重新生成/);
 assert.deepEqual(f.store.get(f.task.id).excludedKeywords,['funny frog decor']);assert.equal(f.runner.queue.length,0);
});
test('全部重采进入串行队列，当前词表、报告和标题在新词核验前仍保留',async t=>{
 const f=await fixture(t),r=await f.request({action:'refresh'});assert.equal(r.status,200);const next=await r.json();
 assert.equal(next.state,'queued');assert.equal(next.mode,'keywords_only');assert.equal(next.keywordJob.action,'refresh');assert.equal(next.keywordJob.status,'pending');assert.deepEqual(next.result,f.task.result);assert.deepEqual(f.runner.queue,[f.task.id]);
 assert.deepEqual(next.keywordJob.excludedTerms,['frog wall art','funny frog decor','green frog painting']);
});
test('单个换词只排除指定词，保留其他词作为不可更改的基线',async t=>{
 const f=await fixture(t),r=await f.request({action:'replace',term:'funny frog decor'});assert.equal(r.status,200);const next=await r.json();
 assert.equal(next.keywordJob.term,'funny frog decor');assert.deepEqual(next.keywordJob.excludedTerms,['funny frog decor']);assert.deepEqual(next.result,f.task.result);
});
test('忙碌、未知词、无竞品、空参数和跨站请求不会破坏已存结果',async t=>{
 const f=await fixture(t);assert.equal((await f.request(null)).status,400);assert.equal((await f.request({action:'other'})).status,400);assert.equal((await f.request({action:'delete',term:'missing'})).status,409);
 assert.equal((await f.request({action:'refresh'},{origin:'https://other.example'})).status,403);
 for(const state of ['running','queued','cancelling','needs_login','staged']){await f.store.patch(f.task.id,{state});assert.equal((await f.request({action:'refresh'})).status,409);}
 await f.store.patch(f.task.id,{state:'completed',result:{...f.task.result,competitors:[]}});assert.equal((await f.request({action:'refresh'})).status,400);
});
test('并发换词只创建一次操作，不会覆盖首个选择或重复入队',async t=>{
 const f=await fixture(t),responses=await Promise.all([f.request({action:'replace',term:'frog wall art'}),f.request({action:'replace',term:'green frog painting'})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.deepEqual(f.runner.queue,[f.task.id]);
});
test('删除已明确排除的词再次刷新时仍保持排除，删除所有词后也可重新采集',async t=>{
 const f=await fixture(t);for(const term of ['frog wall art','funny frog decor','green frog painting'])assert.equal((await f.request({action:'delete',term})).status,200);
 assert.deepEqual(f.store.get(f.task.id).result.keywords,[]);const r=await f.request({action:'refresh'});assert.equal(r.status,200);assert.equal((await r.json()).keywordJob.excludedTerms.length,3);
});
test('写入报告失败时删除不会改变词表、标题、排除项或任务状态',async t=>{
 const f=await fixture(t),write=f.store.write.bind(f.store);f.store.write=()=>Promise.reject(Error('磁盘写入失败'));
 assert.equal((await f.request({action:'delete',term:'frog wall art'})).status,400);assert.deepEqual(f.store.get(f.task.id),f.task);f.store.write=write;
});
test('换词任务暂停后单项继续和全部恢复均保留换词意图、原词表与标题',async t=>{
 const f=await fixture(t);assert.equal((await f.request({action:'replace',term:'funny frog decor'})).status,200);await f.runner.cancel(f.task.id);
 assert.equal((await f.resume({})).status,200);let next=f.store.get(f.task.id);assert.equal(next.mode,'keywords_only');assert.deepEqual(next.result,f.task.result);
 await f.runner.cancel(f.task.id);await f.runner.resumeAll();next=f.store.get(f.task.id);assert.equal(next.mode,'keywords_only');assert.deepEqual(next.result,f.task.result);
 const restored=new TaskRunner(f.store,{enabled:false});await restored.restore();assert.deepEqual(restored.queue,[f.task.id]);assert.equal(f.store.get(f.task.id).keywordJob.term,'funny frog decor');
});

test('删除词后普通继续使用已改词库生成标题，不因为少于15词而重做竞品和选词',async t=>{
 const f=await fixture(t);await f.request({action:'delete',term:'funny frog decor'});await f.resume({});assert.equal(f.store.get(f.task.id).mode,'titles_only');
});
test('历史任务另有重跑记录时，明确新建换词可暂停恢复；随后整项重新开始仍使旧尝试失效',async t=>{
 const f=await fixture(t);await f.store.patch(f.task.id,{latestRestartId:'older-restart'});await f.request({action:'replace',term:'funny frog decor'});const job=f.store.get(f.task.id).keywordJob;assert.equal(job.previousRestartId,'older-restart');
 await f.runner.cancel(f.task.id);await f.runner.resumeAll();assert.deepEqual(f.runner.queue,[f.task.id]);await f.runner.cancel(f.task.id);
 const response=await fetch(f.base+'tasks/'+f.task.id+'/restart',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);const restarted=await response.json();await f.runner.resumeAll();assert.deepEqual(f.runner.queue,[restarted.id]);
});
test('慢速继续请求不能用旧快照撤销期间已成功删除的词',async t=>{
 const http=await import('node:http');const f=await fixture(t);let signal;const entered=new Promise(r=>signal=r),get=f.store.get.bind(f.store);let watched=true;
 f.store.get=(id,...args)=>{const task=get(id,...args);if(watched&&id===f.task.id){watched=false;signal();}return task;};
 let request;const response=new Promise((resolve,reject)=>{request=http.request(f.base+'tasks/'+f.task.id+'/resume',{method:'POST',headers:{'content-type':'application/json','content-length':2}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});request.on('error',reject);request.write('{');});
 await entered;assert.equal((await f.request({action:'delete',term:'funny frog decor'})).status,200);request.end('}');const r=await response;assert.equal(r.status,200);assert.deepEqual(r.body.result.keywords.map(w=>w.term),['frog wall art','green frog painting']);assert.equal(r.body.mode,'titles_only');
});
