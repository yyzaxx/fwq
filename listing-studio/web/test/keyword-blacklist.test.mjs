import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,kw} from './support/keywords-fixture.mjs';
import {KeywordBlacklist} from '../lib/keyword-blacklist.mjs';

async function executor(f,output){
 const file=path.join(f.root,'blacklist-executor');
 await fs.writeFile(file,`#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{fs.writeFileSync('prompt.txt',prompt);fs.writeFileSync('report.md','report');fs.writeFileSync('result.json',JSON.stringify(${JSON.stringify(output)}));});`,{mode:0o700});f.runner.executor=file;
}
const request=(f,body,headers={})=>fetch(f.base+'keyword-blacklist',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('拉黑同步当前词表及报告、清除旧标题，黑名单重启后保留且只匹配完整词',async t=>{
 const f=await fixture(t),r=await f.request({action:'blacklist',term:'funny frog decor'});assert.equal(r.status,200);
 const next=await r.json();assert.equal(next.result.keywords.length,2);assert.deepEqual(next.result.titles,[]);
 const report=await(await fetch(f.base+'tasks/'+f.task.id+'/report.md')).text();assert.doesNotMatch(report,/funny frog decor/);
 const list=await new KeywordBlacklist(f.root).init();assert.equal(list.has(' ＦＵＮＮＹ  frog DECOR '),true);assert.equal(list.has('cute funny frog decor'),false);
 assert.deepEqual(await(await fetch(f.base+'keyword-blacklist')).json(),['funny frog decor']);
});
test('并发加入不丢词、归一后去重，解除全局拉黑不会抹掉原任务排除记录',async t=>{
 const f=await fixture(t);await f.request({action:'blacklist',term:'funny frog decor'});
 await Promise.all(['Frog decor','frog wall decor','ＦＲＯＧ  decor'].map(term=>f.store.blacklist.change('add',term)));
 assert.equal(f.store.blacklist.list().length,3);
 assert.equal((await request(f,{action:'remove',term:' FUNNY frog decor '})).status,200);
 assert.equal(f.store.blacklist.has('funny frog decor'),false);assert.ok(f.store.get(f.task.id).excludedKeywords.includes('funny frog decor'));
});
test('换词执行在排队后读取最新黑名单，拒绝被拉黑完整词，更长词可采用',async t=>{
 for(const [term,blocked] of [['frog bathroom decor',true],['cute frog bathroom decor',false]]){
 const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});
 await f.store.blacklist.change('add','FROG bathroom decor');
 await executor(f,{status:'completed',keywords:[kw(term)]});await f.runner.drain();
 const next=f.store.get(f.task.id);assert.equal(next.state,blocked?'failed':'partial');
 if(blocked)assert.deepEqual(next.result,f.task.result);else assert.ok(next.result.keywords.some(w=>w.term===term));
 const prompt=await fs.readFile(path.join(f.store.directory(f.task.id),'keyword-runs',next.keywordJob.id,'prompt.txt'),'utf8');assert.match(prompt,/FROG bathroom decor/);
 }
});
test('已有任务后续生成标题前移除全局黑名单词，保留其他历史任务原件',async t=>{
 const f=await fixture(t);await f.store.blacklist.change('add','funny frog decor');await f.resume({});await f.store.patch(f.task.id,{mode:'titles_only'});
 const output={...f.task.result,keywords:f.task.result.keywords.filter(w=>w.term!=='funny frog decor')};
 await executor(f,output);await f.runner.drain();const next=f.store.get(f.task.id);
 assert.equal(next.result.keywords.some(w=>w.term==='funny frog decor'),false);assert.equal(next.result.titles.length,2);
 assert.equal(await fs.readFile(path.join(f.store.directory(f.task.id),'report.md'),'utf8'),'original report frog wall art');
});
test('首次完整调研及标题槽值也由服务端拦截黑名单，不能绕过前端',async t=>{
 for(const mode of ['full','titles_only']){
 const f=await fixture(t);await f.store.blacklist.change('add',mode==='full'?'funny frog decor':'Frog');
 await f.store.patch(f.task.id,{mode,state:'queued'});f.runner.queue=[f.task.id];
 await executor(f,f.task.result);await f.runner.drain();assert.equal(f.store.get(f.task.id).state,'failed');
 }
});
test('非法词及跨站修改拒绝，损坏黑名单不能静默忽略',async t=>{
 const f=await fixture(t);for(const term of ['',null,'x\ny','x'.repeat(251)])assert.equal((await request(f,{action:'add',term})).status,400);
 assert.equal((await request(f,{action:'add',term:'frog'},{origin:'https://other.example'})).status,403);
 await fs.writeFile(path.join(f.root,'keyword-blacklist.json'),'{broken');await assert.rejects(new KeywordBlacklist(f.root).init());
});
