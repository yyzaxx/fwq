import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskStore} from '../lib/store.mjs';
import {KeywordTranslationManager} from '../lib/keyword-translations.mjs';
import {createApp} from '../server.mjs';

async function fixture(t,translate){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-translation-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=await new TaskStore(root).init();
 const task=await store.create({category:'挂画'},{id:'translation-task',state:'completed',result:{keywords:[{term:'frog wall art',seed:'original'},{term:'funny frog decor'}],titles:[{text:'original title'}],reportFile:'report.md'}});
 const manager=await new KeywordTranslationManager(store,{translate}).init();return {root,store,task,manager};
}
test('只补充中文意思，不改变英文原词、顺序、来源、标题或报告位置；缓存重启可复用',async t=>{
 let calls=0;const f=await fixture(t,async terms=>{calls++;return terms.map(term=>({term,translationZh:term==='frog wall art'?'青蛙主题墙面艺术':'趣味青蛙装饰'}))});
 const next=await f.manager.enrich(f.task.id);assert.equal(next.result.keywords[0].translationZh,'青蛙主题墙面艺术');
 const original=structuredClone(next);for(const w of original.result.keywords)delete w.translationZh;assert.deepEqual(original.result,f.task.result);
 const another=await f.store.create({}, {id:'translation-other',result:{keywords:[{term:'frog wall art'}]}});
 const restored=await new KeywordTranslationManager(f.store,{translate:async()=>{throw Error('不应重新请求')}}).init();assert.equal((await restored.enrich(another.id)).result.keywords[0].translationZh,'青蛙主题墙面艺术');assert.equal(calls,1);
});
test('同任务并发只翻译一次；期间换词及修改任务状态不能被旧响应覆盖',async t=>{
 let calls=0,release;const gate=new Promise(r=>release=r);const f=await fixture(t,async terms=>{calls++;await gate;return terms.map(term=>({term,translationZh:'青蛙装饰'}))});
 const one=f.manager.enrich(f.task.id),two=f.manager.enrich(f.task.id);await new Promise(r=>setTimeout(r,10));
 await f.store.patch(f.task.id,{state:'cancelled',result:{...f.task.result,keywords:[{term:'new keyword'},{term:'frog wall art'}]}});release();await Promise.all([one,two]);
 const next=f.store.get(f.task.id);assert.equal(calls,1);assert.equal(next.state,'cancelled');assert.equal(next.result.keywords[0].term,'new keyword');assert.equal(next.result.keywords[0].translationZh,undefined);assert.equal(next.result.keywords[1].translationZh,'青蛙装饰');
});
test('翻译失败、缺词、英文冒充中文和篡改词条均不修改任务结果，可再次重试',async t=>{
 for(const translate of [async()=>{throw Error('超时')},async()=>[],async terms=>terms.map(term=>({term,translationZh:'English only'})),async()=>[{term:'changed',translationZh:'假词'}]]){
 const f=await fixture(t,translate);await assert.rejects(f.manager.enrich(f.task.id));assert.deepEqual(f.store.get(f.task.id).result,f.task.result);
 }
});
test('没有流量词时不启动翻译，已删除任务不能回写',async t=>{
 const empty=await fixture(t,async()=>{throw Error('空词库不应启动翻译')});await empty.store.patch(empty.task.id,{result:{keywords:[]}});assert.deepEqual((await empty.manager.enrich(empty.task.id)).result.keywords,[]);
 let release;const gate=new Promise(r=>release=r),f=await fixture(t,async terms=>{await gate;return terms.map(term=>({term,translationZh:'青蛙装饰'}))});
 const operation=f.manager.enrich(f.task.id);await new Promise(r=>setTimeout(r,10));await f.store.remove(f.task.id);release();await assert.rejects(operation);
});
test('任务翻译接口可用，返回原英文和中文，跨站写入继续拒绝',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-translation-http-'));
 const app=await createApp({dataRoot:root,basePath:'/qa/',importExisting:false,runnerEnabled:false,keywordTranslator:async terms=>terms.map(term=>({term,translationZh:'青蛙墙画'}))});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true})});
 await app.store.create({}, {id:'translation-http',result:{keywords:[{term:'frog wall art'}]}});
 const url='http://127.0.0.1:'+app.server.address().port+'/qa/api/tasks/translation-http/keyword-translations';
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);assert.deepEqual((await response.json()).result.keywords,[{term:'frog wall art',translationZh:'青蛙墙画'}]);
 assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:'https://other.example'},body:'{}'})).status,403);
});
