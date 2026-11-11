import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,kw} from './support/keywords-fixture.mjs';
async function execute(f,result){
 const file=path.join(f.root,'executor');await fs.writeFile(file,`#!/usr/bin/env node\nconst fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync('result.json',JSON.stringify(${JSON.stringify(result)}));fs.writeFileSync('report.md',${JSON.stringify('## 标题一\n\n'+(result.titles?.[0]?.text||''))});});`,{mode:0o700});
 f.runner.executor=file;await f.runner.enqueue(f.task.id);await f.runner.drain();return f.store.get(f.task.id);
}
const wrongTitles=[{text:'WRONG BRAND CANDIDATE',slots:[{name:'主体',value:'Frog'}]},{text:'Frog Print',slots:[{name:'主体',value:'Frog'}]}];
test('真正不合格的标题不会抹掉已核实调研，当前报告只交付资料、不交付错误候选',async t=>{
 const f=await fixture(t);await f.store.patch(f.task.id,{result:null});const output={...f.task.result,status:'partial',titles:wrongTitles};const task=await execute(f,output);
 assert.equal(task.state,'partial');assert.deepEqual(task.result.keywords,output.keywords);assert.equal(task.result.competitors.length,1);assert.deepEqual(task.result.titles,[]);assert.match(task.titleValidationError,/固定/);assert.equal(task.titlesStale,true);assert.equal(task.mode,'titles_only');
 const report=await(await fetch(f.base+'tasks/'+task.id+'/report.md')).text();assert.match(report,/frog wall art, funny frog decor, green frog painting/);assert.doesNotMatch(report,/WRONG BRAND CANDIDATE/);assert.match(report,/标题/);
 assert.equal((await f.resume({})).status,200);assert.equal(f.store.get(task.id).mode,'titles_only');
});
test('来源或图片无效时不能借标题恢复机制放行，已有结果保持原样',async t=>{
 for(const invalid of ['source','image']){
  const f=await fixture(t),output={...f.task.result,status:'partial',titles:wrongTitles};
  if(invalid==='source')output.keywords=[{...kw('frog wall art'),queryUrl:'https://example.com'}];else output.competitors=[{...output.competitors[0],imageFile:'artifacts/missing.jpg'}];
  const task=await execute(f,output);assert.equal(task.state,'failed');assert.deepEqual(task.result,f.task.result);
 }
});
test('历史任务末尾换行的结果可以直接保存，不重新联网、不删掉有效标题',async t=>{
 const f=await fixture(t);await f.store.patch(f.task.id,{input:{...f.task.input,templateOne:f.task.input.templateOne+'\n'},result:null});const task=await execute(f,{...f.task.result,status:'partial'});
 assert.equal(task.state,'partial');assert.equal(task.result.keywords.length,3);assert.equal(task.result.titles.length,2);assert.equal(task.result.titles[0].text,'Frog Art');assert.equal(task.result.titles[0].length,8);
});
test('隔离标题续作再次失败时，用本次执行目录报告恢复，旧资料仍可读取',async t=>{
 const f=await fixture(t);await execute(f,{...f.task.result,status:'partial',titles:wrongTitles});const previous=f.store.get(f.task.id).result;
 await fs.rm(path.join(f.store.directory(f.task.id),'report.md'));
 const next=await execute(f,{...f.task.result,status:'partial',titles:wrongTitles});assert.equal(next.state,'partial');assert.deepEqual(next.result.keywords,previous.keywords);assert.notEqual(next.result.reportFile,previous.reportFile);await fs.access(path.join(f.store.directory(f.task.id),previous.reportFile));
});
test('按已有资料成功生成后清除失败标记，报告同步归档合格标题',async t=>{
 const f=await fixture(t);await execute(f,{...f.task.result,status:'partial',titles:wrongTitles});const next=await execute(f,{...f.task.result,status:'partial'});
 assert.equal(next.titleValidationError,null);assert.equal(next.titlesStale,false);assert.equal(next.result.titles.length,2);const report=await(await fetch(f.base+'tasks/'+f.task.id+'/report.md')).text();assert.match(report,/Frog Print/);assert.doesNotMatch(report,/WRONG BRAND|标题校验未通过|标题校验说明/);
});
test('标题恢复仍锁定已保存词源，不接受执行器给自己补造词源',async t=>{
 const f=await fixture(t);await execute(f,{...f.task.result,status:'partial',titles:wrongTitles});const prior=f.store.get(f.task.id).result;
 const next=await execute(f,{...f.task.result,status:'partial',keywords:[...f.task.result.keywords,kw('invented frog word')],titles:wrongTitles});assert.equal(next.state,'failed');assert.deepEqual(next.result,prior);
});
test('执行器遗留的恢复目录符号链接不能导致写入任务目录之外',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside-task');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.store.directory(f.task.id),'title-validation'));
 const task=await execute(f,{...f.task.result,status:'partial',titles:wrongTitles});assert.equal(task.state,'failed');assert.deepEqual(await fs.readdir(outside),[]);assert.deepEqual(task.result,f.task.result);
});
