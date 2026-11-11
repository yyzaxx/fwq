import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {TaskRunner} from '../lib/runner.mjs';
import {fixture,kw} from './support/keywords-fixture.mjs';

async function researchFixture(t,count=13){
 const f=await fixture(t),competitors=Array.from({length:5},(_,i)=>({...f.task.result.competitors[0],asin:'B00000000'+i,url:'https://www.amazon.com/dp/B00000000'+i}));
 const result={...f.task.result,status:'partial',competitors,keywords:Array.from({length:count},(_,i)=>kw('frog wall art '+i))};
 await f.store.patch(f.task.id,{state:'partial',result});f.task=f.store.get(f.task.id);return f;
}
async function fake(f,outputs){
 const script=path.join(f.root,'executor'),counter=path.join(f.root,'attempt-count');
 await fs.writeFile(script,`#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{const counter=${JSON.stringify(counter)},i=fs.existsSync(counter)?Number(fs.readFileSync(counter)):0;fs.writeFileSync(counter,String(i+1));fs.writeFileSync('captured-prompt.txt',prompt);fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/new-comp.jpg','fixture');fs.writeFileSync('report.md','executor report');const outputs=${JSON.stringify(outputs)};const output=outputs[Math.min(i,outputs.length-1)];fs.writeFileSync('artifacts/evidence.json',output._evidenceText||'evidence');if(i===0&&output._symlinkResearch){fs.unlinkSync('research.json');fs.symlinkSync('../../artifacts/comp.jpg','research.json');}fs.writeFileSync('result.json',JSON.stringify(output));});`,{mode:0o700});f.runner.executor=script;return counter;
}
test('已有13词补采可扩充竞品并合并新词，保留全部旧词及原标题，达到15才完成',async t=>{
 const f=await researchFixture(t),base=f.task.result;await f.resume({});
 assert.equal(f.store.get(f.task.id).result.titles.length,2);
 const extra={...base.competitors[0],asin:'B099999999',imageFile:'artifacts/new-comp.jpg'};
 const counter=await fake(f,[{...base,competitors:[extra],keywords:[kw('frog bathroom decor'),kw('frog pond print')],titles:[],reportFile:'report.md'}]);await f.runner.drain();const task=f.store.get(f.task.id);
 assert.equal(task.state,'completed');assert.equal(task.result.keywords.length,15);assert.deepEqual(task.result.keywords.slice(0,13),base.keywords);assert.deepEqual(task.result.competitors.slice(0,5),base.competitors);assert.equal(task.result.competitors.length,6);assert.equal(task.result.titles.length,2);assert.equal(await fs.readFile(counter,'utf8'),'1');
 const report=await(await fetch(f.base+'tasks/'+task.id+'/report.md')).text();assert.match(report,/frog pond print/);assert.match(report,/Frog Print/);
});
test('一轮仍不足会自动继续，已保存的新词不会丢失，报告与最终15词一致',async t=>{
 const f=await researchFixture(t);await f.resume({});const b=f.task.result;
 const counter=await fake(f,[{...b,keywords:[kw('frog bathroom decor')],titles:[],reportFile:'report.md'},{...b,keywords:[kw('frog pond print')],titles:[],reportFile:'report.md'}]);await f.runner.drain();const task=f.store.get(f.task.id);
 assert.equal(task.state,'completed');assert.equal(task.result.keywords.length,15);assert.equal(await fs.readFile(counter,'utf8'),'2');assert.equal(task.keywordCollection.status,'completed');
});
test('连续没有新增词或新增竞品时保留未达标状态，不能标记为完成或无限空转',async t=>{
 const f=await researchFixture(t);await f.resume({});const count=await fake(f,[{...f.task.result,titles:[],reportFile:'report.md'}]);await f.runner.drain();const task=f.store.get(f.task.id);assert.equal(task.state,'needs_input');assert.equal(task.result.keywords.length,13);assert.match(task.message,/15|不足|缺/);assert.equal(await fs.readFile(count,'utf8'),'2');
});
test('补词期间遇登录停下保留已有13词和原标题，不触发自动重试',async t=>{
 const f=await researchFixture(t);await f.resume({});const count=await fake(f,[{...f.task.result,status:'needs_login',keywords:[],titles:[],reportFile:'report.md'}]);await f.runner.drain();const task=f.store.get(f.task.id);assert.equal(task.state,'needs_login');assert.equal(task.result.keywords.length,13);assert.equal(task.result.titles.length,2);assert.equal(await fs.readFile(count,'utf8'),'1');assert.equal(f.runner.blockedForLogin,task.id);
});
test('整组重采不足15词时只保存候选，继续找新ASIN，攒满后一次替换原词库',async t=>{
 const f=await fixture(t);await f.request({action:'refresh'});
 const first={status:'partial',keywords:[kw('frog bathroom decor')],searchedAsins:['B099999999']};
 const terms=Array.from({length:14},(_,i)=>kw('frog pond decor '+i));
 const counter=await fake(f,[first,{status:'completed',keywords:terms,searchedAsins:['B088888888']}]);await f.runner.drain();const task=f.store.get(f.task.id);assert.equal(task.keywordJob.status,'completed');assert.equal(task.result.keywords.length,15);assert.equal(task.result.keywords[0].term,'frog bathroom decor');assert.equal(await fs.readFile(counter,'utf8'),'2');assert.deepEqual(task.result.competitors,f.task.result.competitors);
});
test('整组重采累计词的证据在后续轮次重用同名文件后仍保持原内容',async t=>{
 const f=await fixture(t);await f.request({action:'refresh'});await fake(f,[{status:'partial',keywords:[{...kw('frog bathroom decor'),evidenceFile:'artifacts/evidence.json'}],_evidenceText:'first verified evidence'},{status:'completed',keywords:Array.from({length:14},(_,i)=>kw('frog pond '+i)),_evidenceText:'later unrelated evidence'}]);await f.runner.drain();const word=f.store.get(f.task.id).result.keywords[0];assert.equal(await fs.readFile(path.join(f.store.directory(f.task.id),word.evidenceFile),'utf8'),'first verified evidence');
});
test('暂停补采后继续使用同一工作目录，保留未完成查询和进度',async t=>{
 const f=await researchFixture(t);await f.resume({});await fake(f,[{...f.task.result,status:'needs_login',reportFile:'report.md'}]);await f.runner.drain();const first=f.store.get(f.task.id);assert.ok(first.keywordCollection.runId);
 const dir=path.join(f.store.directory(f.task.id),'collection-runs',first.keywordCollection.runId);await fs.writeFile(path.join(dir,'artifacts/unfinished-query.json'),'saved unfinished query');await f.resume({});await fake(f,[{...f.task.result,status:'needs_login',reportFile:'report.md'}]);await f.runner.drain();const second=f.store.get(f.task.id);assert.equal(second.keywordCollection.runId,first.keywordCollection.runId);assert.equal(await fs.readFile(path.join(dir,'artifacts/unfinished-query.json'),'utf8'),'saved unfinished query');
});
test('补采重试不跟随执行器遗留的research.json符号链接覆盖原竞品图片',async t=>{
 const f=await fixture(t);await f.request({action:'refresh'});await fake(f,[{status:'partial',keywords:[kw('frog bathroom decor')],_symlinkResearch:true},{status:'completed',keywords:Array.from({length:14},(_,i)=>kw('frog pond '+i))}]);await f.runner.drain();assert.equal(f.store.get(f.task.id).keywordJob.status,'completed');assert.equal(await fs.readFile(path.join(f.store.directory(f.task.id),'artifacts/comp.jpg'),'utf8'),'fixture');
});
test('自动补采排到其他任务之后，持久化队列顺序在恢复后保持一致',async t=>{
 const f=await researchFixture(t);await f.resume({});const other=await f.store.create(f.task.input,{id:'goal-second',state:'staged'});await f.runner.enqueue(other.id);let checks=0;f.runner.resourceCheck=async()=>++checks>1?'测试暂停':null;
 await fake(f,[{...f.task.result,titles:[],reportFile:'report.md'}]);await f.runner.drain();assert.deepEqual(f.runner.queue,[other.id,f.task.id]);const restored=new TaskRunner(f.store,{enabled:false});await restored.restore();assert.deepEqual(restored.queue,[other.id,f.task.id]);
});
test('首次完整调研也不能用空白大小写变体将1个词算成15个',async t=>{
 const f=await researchFixture(t);await f.store.patch(f.task.id,{result:null,state:'partial'});await f.runner.enqueue(f.task.id);
 await fake(f,[{...f.task.result,status:'completed',keywords:Array.from({length:15},(_,i)=>kw((i%2?'FROG WALL ART':'frog wall art')+' '.repeat(i))),reportFile:'report.md'}]);await f.runner.drain();const task=f.store.get(f.task.id);assert.equal(task.state,'needs_input');assert.equal(task.result.keywords.length,1);assert.equal(task.keywordCollection.status,'pending');
});
