import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApp} from '../server.mjs';

async function fixture(t,{count=7,failClose=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-two-tabs-'));
  let pages=Array.from({length:count},(_,i)=>({id:'page-'+i,type:'page',url:i===1?'about:blank':'https://example.test/'+i}));
  pages.push({id:'browser-ui',type:'browser_ui',url:'chrome://omnibox-popup/'},{id:'worker',type:'worker',url:'https://example.test/worker.js'});
  const state={failClose,pages:()=>pages,add:target=>pages.unshift(target)};
  const browser=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/json/list')return res.end(JSON.stringify(pages));
    if(req.url.startsWith('/json/close/')){
      if(state.failClose){res.statusCode=500;return res.end('{}')}
      const id=decodeURIComponent(req.url.split('/').at(-1));setTimeout(()=>{pages=pages.filter(p=>p.id!==id)},40);return res.end('{}');
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>browser.listen(0,'127.0.0.1',resolve));
  const browserUrl='http://127.0.0.1:'+browser.address().port;
  const app=await createApp({dataRoot:root,basePath:'/qa/',importExisting:false,runnerEnabled:false,browserUrl,browserWatchdogEnabled:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));browser.closeAllConnections();await new Promise(resolve=>browser.close(resolve));await fs.rm(root,{recursive:true,force:true})});
  return Object.assign(state,{browserUrl,app,base:'http://127.0.0.1:'+app.server.address().port+'/qa/'});
}
async function atMostTwo(state){
  const deadline=Date.now()+2500;
  while(Date.now()<deadline&&state.pages().filter(p=>p.type==='page').length>2)await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(state.pages().filter(p=>p.type==='page').length,2);
}
test('空闲时也自动限制两个业务标签，优先关闭空白和多余旧页',async t=>{
  const b=await fixture(t);await atMostTwo(b);
  assert.deepEqual(b.pages().filter(p=>p.type==='page').map(p=>p.id),['page-0','page-2']);
  assert.ok(b.pages().some(p=>p.id==='browser-ui'));assert.ok(b.pages().some(p=>p.id==='worker'));
  b.add({id:'new-a',type:'page',url:'https://example.test/new-a'});b.add({id:'new-b',type:'page',url:'https://example.test/new-b'});await atMostTwo(b);
  assert.ok(b.pages().some(p=>p.id==='new-a'));assert.ok(b.pages().some(p=>p.id==='new-b'));
});
test('未超过两个时保留全部页面，不把内部界面或线程算作标签',async t=>{
  const b=await fixture(t,{count:2});await new Promise(resolve=>setTimeout(resolve,180));assert.equal(b.pages().length,4);assert.equal(b.pages().filter(p=>p.type==='page').length,2);
});
test('关闭接口暂时失败后继续重试，网站仍可访问',async t=>{
  const b=await fixture(t,{failClose:true});await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await fetch(b.base)).status,200);
  b.failClose=false;await atMostTwo(b);
});
