import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './support/keywords-fixture.mjs';

async function execute(f){
 const file=path.join(f.root,'current-sif-executor');
 await fs.writeFile(file,`#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{fs.writeFileSync('captured-prompt.txt',prompt);fs.writeFileSync('result.json',JSON.stringify(${JSON.stringify({...f.task.result,status:'partial',titles:[]})}));});`,{mode:0o700});f.runner.executor=file;await f.runner.drain();
}
function assertCurrentOnly(prompt){
 assert.match(prompt,/只使用当前反查/);
 assert.match(prompt,/禁止.{0,20}历史反查/);
 assert.match(prompt,/节庆|旺季/);
 assert.match(prompt,/新增.{0,20}ASIN|新增.{0,20}竞品/);
 assert.match(prompt,/优先于.{0,40}旧|旧.{0,40}优先/);
}
test('新调研和历史会员受阻续作都使用当前反查，旧检查点不能要求历史月份',async t=>{
 const f=await fixture(t);await f.store.patch(f.task.id,{state:'needs_login',message:'最近7天无结果，2026年3月历史反查受会员限制',mode:'full'});
 assert.equal((await f.resume({})).status,200);await execute(f);
 const prompt=await fs.readFile(path.join(f.store.directory(f.task.id),'captured-prompt.txt'),'utf8');assertCurrentOnly(prompt);
});
test('单词替换和全部重采使用同一当前反查规则',async t=>{
 for(const action of ['replace','refresh']){
 const f=await fixture(t);await f.request({action,term:'funny frog decor'});await execute(f);
 const job=f.store.get(f.task.id).keywordJob;const prompt=await fs.readFile(path.join(f.store.directory(f.task.id),'keyword-runs',job.id,'captured-prompt.txt'),'utf8');assertCurrentOnly(prompt);
 }
});
