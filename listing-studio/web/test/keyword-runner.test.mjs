import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,kw} from './support/keywords-fixture.mjs';

async function executor(f,output,{delay=0}={}){
 const file=path.join(f.root,'executor');
 await fs.writeFile(file,`#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{fs.writeFileSync('prompt.txt',prompt);fs.writeFileSync('report.md','agent report');setTimeout(()=>{fs.writeFileSync('result.json',JSON.stringify(${JSON.stringify(output)}));},${delay});});\n`,{mode:0o700});f.runner.executor=file;
}
async function run(f,output){await executor(f,output);await f.runner.drain();return f.store.get(f.task.id);}
const result=terms=>({status:'completed',message:'实际查询结果',keywords:terms.map(kw)});

test('换词执行在独立目录，成功仅替换一个词且保留其余全部字段和原报告',async t=>{
 const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});const next=await run(f,result(['frog bathroom decor']));
 assert.deepEqual(next.result.keywords.map(w=>w.term),['frog wall art','frog bathroom decor','green frog painting']);assert.deepEqual(next.result.keywords[0],f.task.result.keywords[0]);assert.deepEqual(next.result.keywords[2],f.task.result.keywords[2]);assert.deepEqual(next.result.competitors,f.task.result.competitors);assert.equal(next.keywordJob.status,'completed');assert.equal(next.titlesStale,true);
 assert.equal(await fs.readFile(path.join(f.store.directory(f.task.id),'report.md'),'utf8'),'original report frog wall art');
 const dir=path.join(f.store.directory(f.task.id),'keyword-runs',next.keywordJob.id);const prompt=await fs.readFile(path.join(dir,'prompt.txt'),'utf8');assert.match(prompt,/funny frog decor/);assert.match(prompt,/Sif US/);assert.match(prompt,/最多 2 个/);
 assert.equal((await(await fetch(f.base+'tasks/'+f.task.id+'/download')).arrayBuffer()).byteLength>100,true);
});
test('全部重采使用全新词表，不复用旧词，15条不足时按实际数量交付',async t=>{
 const f=await fixture(t);await f.request({action:'refresh'});const next=await run(f,result(['frog bathroom decor','whimsical frog art']));assert.deepEqual(next.result.keywords.map(w=>w.term),['frog bathroom decor','whimsical frog art']);assert.equal(next.keywordJob.status,'completed');assert.match(next.message,/不足15/);assert.deepEqual(next.excludedKeywords,['frog wall art','funny frog decor','green frog painting']);
});
test('拒绝再次采到排除词、保留词、归一化重复词及来源不合法的词，原结果不变',async t=>{
 for(const output of [result(['  FUNNY  frog decor  ']),result(['green frog painting']),result(['frog bathroom decor',' Frog Bathroom Decor ']),{...result(['frog bathroom decor']),keywords:[{...kw('frog bathroom decor'),queryUrl:'https://example.com'}]},result(['frog bathroom decor','whimsical frog art'])]){
  const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});const next=await run(f,output);assert.equal(next.state,'failed');assert.deepEqual(next.result,f.task.result);assert.equal(next.keywordJob.status,'pending');
 }
});
test('零个合格词和等待登录均保留整个当前版本，继续时仍执行相同换词请求',async t=>{
 for(const status of ['partial','needs_input','needs_login']){
  const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});const next=await run(f,{status,keywords:[],message:'缺口'});assert.equal(next.state,status);assert.deepEqual(next.result,f.task.result);assert.equal(next.keywordJob.status,'pending');assert.equal(f.runner.blockedForLogin,status==='needs_login'?f.task.id:null);
  assert.equal((await f.resume({})).status,200);const saved=f.store.get(f.task.id);assert.equal(saved.mode,'keywords_only');assert.deepEqual(saved.result,f.task.result);
 }
});
test('采集被取消后迟到结果不会替换原词表或报告',async t=>{
 const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});await executor(f,result(['frog bathroom decor']),{delay:1000});const draining=f.runner.drain();
 for(let i=0;i<100&&!f.runner.child;i++)await new Promise(r=>setTimeout(r,10));await f.runner.cancel(f.task.id);await draining;const next=f.store.get(f.task.id);assert.equal(next.state,'cancelled');assert.deepEqual(next.result,f.task.result);assert.equal(next.keywordJob.status,'pending');
});
test('删除后按新词库重生成标题，保留原报告并正确打包跨目录图片',async t=>{
 const f=await fixture(t);assert.equal((await f.request({action:'delete',term:'funny frog decor'})).status,200);await f.resume({templateOne:f.task.input.templateOne,templateTwo:f.task.input.templateTwo});
 const task=f.store.get(f.task.id),output={...task.result,titles:f.task.result.titles};await executor(f,output);await f.runner.drain();const next=f.store.get(f.task.id);assert.equal(next.titlesStale,false);assert.equal(next.result.titles.length,2);assert.equal(await fs.readFile(path.join(f.store.directory(f.task.id),'report.md'),'utf8'),'original report frog wall art');
 const report=await(await fetch(f.base+'tasks/'+f.task.id+'/report.md')).text();assert.match(report,/Frog Print/);assert.doesNotMatch(report,/标题待重新生成/);
 const zip=Buffer.from(await(await fetch(f.base+'tasks/'+f.task.id+'/download')).arrayBuffer());assert.match(zip.toString(),/artifacts\/comp.jpg/);assert.match(zip.toString(),/design.png/);
});
test('准备复制资料期间取消，不得重新转为运行或启动执行器',async t=>{
 const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});await executor(f,result(['frog bathroom decor']));let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),copy=fs.copyFile;
 fs.copyFile=async(...args)=>{if(String(args[1]).includes('keyword-runs')){enter();await gate;}return copy(...args);};
 try{const draining=f.runner.drain();await entered;await f.runner.cancel(f.task.id);release();await draining;assert.equal(f.store.get(f.task.id).state,'cancelled');assert.deepEqual(f.store.get(f.task.id).result,f.task.result);await assert.rejects(fs.access(path.join(f.store.directory(f.task.id),'keyword-runs',f.store.get(f.task.id).keywordJob.id,'prompt.txt')));}
 finally{release();fs.copyFile=copy;}
});
test('仍需补充资料时即使带候选词也不采纳，保留原词表和具体缺口',async t=>{
 const f=await fixture(t);await f.request({action:'replace',term:'funny frog decor'});const next=await run(f,{...result(['frog bathroom decor']),status:'needs_input',message:'候选属性未确认，请先补充资料'});assert.equal(next.state,'needs_input');assert.deepEqual(next.result,f.task.result);assert.equal(next.keywordJob.status,'pending');assert.match(next.message,/候选属性未确认/);
});
