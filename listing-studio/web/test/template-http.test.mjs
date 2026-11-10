import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

test('模板API支持保存、跨页面读取、更新和删除，并纳入初始化数据',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-preset-http-'));
  const app=await createApp({dataRoot:root,basePath:'/test-presets/',importExisting:false,runnerEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}/test-presets/api/`;
  const body={name:'日常挂画',category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art for Living Room, {风格}',ranges:[[65,75],[115,125]]};
  const write=(method,data)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  try{
    assert.equal((await fetch(new URL('../template-form.js',base))).status,200);
    let response=await fetch(base+'templates',write('POST',body));assert.equal(response.status,201);
    const saved=await response.json();
    const list=await(await fetch(base+'templates')).json();assert.equal(list[0].id,saved.id);assert.equal(list[0].templateTwo,body.templateTwo);
    response=await fetch(base+'templates/'+saved.id,write('PUT',{...body,name:'改名后',expectedUpdatedAt:saved.updatedAt}));assert.equal(response.status,200);
    response=await fetch(base+'templates/'+saved.id,write('PUT',{...body,expectedUpdatedAt:saved.updatedAt}));assert.equal(response.status,409);
    response=await fetch(base+'templates',{...write('POST',{...body,name:'外站写入'}),headers:{'content-type':'application/json',origin:'https://other.invalid'}});assert.equal(response.status,403);
    const bootstrap=await(await fetch(base+'bootstrap')).json();assert.equal(bootstrap.templates[0].name,'改名后');
    response=await fetch(base+'templates/'+saved.id,write('DELETE',{}));assert.equal(response.status,200);
    assert.deepEqual(await(await fetch(base+'templates')).json(),[]);
    response=await fetch(base+'templates/'+saved.id,write('DELETE',{}));assert.equal(response.status,404);
  }finally{await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});
