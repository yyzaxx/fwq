import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApp} from '../server.mjs';
async function app(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-request-limits-'));const a=await createApp({dataRoot:root,basePath:'/test/',importExisting:false,runnerEnabled:false});await new Promise(resolve=>a.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{a.server.closeAllConnections();await new Promise(resolve=>a.server.close(resolve));await fs.rm(root,{recursive:true,force:true});});return {a,base:'http://127.0.0.1:'+a.server.address().port+'/test/'};}
test('模板等普通JSON请求过大时在解析前返回413',async t=>{const {base}=await app(t);const r=await fetch(base+'api/templates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'a'.repeat(70*1024)})});assert.equal(r.status,413);assert.match((await r.json()).error,/过大/)});
test('同一时刻只接收一份图片或ZIP，上传断开后正确释放位置',async t=>{
  const {base}=await app(t);const slow=http.request(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json','content-length':100}});slow.on('error',()=>{});slow.write('{');
  await new Promise(resolve=>setTimeout(resolve,50));
  let r=await fetch(base+'api/batches/preview',{method:'POST',headers:{'content-type':'application/zip'},body:'not a zip'});assert.equal(r.status,429);
  r=await fetch(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,429);
  slow.destroy();await new Promise(resolve=>setTimeout(resolve,50));
  r=await fetch(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,400);
});
test('声明超大图片请求立即拒绝，不等待读取或分配整个请求体',async t=>{
  const {base}=await app(t);
  const status=await new Promise((resolve,reject)=>{const req=http.request(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json','content-length':24*1024*1024}},res=>{res.resume();resolve(res.statusCode);req.destroy();});req.on('error',error=>{if(error.code!=='ECONNRESET')reject(error)});req.setTimeout(1500,()=>{req.destroy();reject(Error('没有及时拒绝超大请求'))});req.write('{');});
  assert.equal(status,413);
});
test('并发请求超过16个时拒绝超额请求，连接断开后可恢复服务',async t=>{
  const {base}=await app(t),requests=[];
  try{
    for(let i=0;i<16;i++){const req=http.request(base+'api/queue/resume',{method:'POST',headers:{'content-type':'application/json','content-length':100}});req.on('error',()=>{});req.write('{');requests.push(req);}
    await new Promise(resolve=>setTimeout(resolve,80));assert.equal((await fetch(base)).status,429);
  }finally{for(const req of requests)req.destroy();}
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal((await fetch(base)).status,200);
});
test('慢速报告下载占位期间拒绝重复打包，断开后可再次下载',async t=>{
  const {base,a}=await app(t),task=await a.store.create({category:'挂画'},{id:'report-limit-test',state:'completed',result:{reportFile:'report.md'}}),directory=a.store.directory(task.id);
  await fs.writeFile(path.join(directory,'report.md'),'# 测试报告\n![测试](large.jpg)');await fs.writeFile(path.join(directory,'large.jpg'),Buffer.alloc(8*1024*1024));
  const url=base+'api/tasks/'+task.id+'/download';
  const response=await new Promise((resolve,reject)=>{http.get(url,res=>{res.pause();resolve(res);}).on('error',reject)});
  assert.equal(response.statusCode,200);assert.equal((await fetch(url)).status,429);response.destroy();
  await new Promise(resolve=>setTimeout(resolve,80));const next=await fetch(url);assert.equal(next.status,200);await next.arrayBuffer();
});
