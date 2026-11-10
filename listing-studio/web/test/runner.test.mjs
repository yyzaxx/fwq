import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';

test('准备阶段取消后不得再启动任何执行器进程',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-cancel-'));
  let release;
  try{
    const store=await new TaskStore(path.join(root,'jobs')).init();
    const task=await store.create({category:'挂画',templateOne:'{主体}',templateTwo:'{主体}',ranges:[[1,50],[1,50]]},{imageFile:'design.jpg'});
    const fake=path.join(root,'executor');
    await fs.writeFile(fake,'#!/usr/bin/env node\nrequire("fs").writeFileSync("launched-marker","started");\n',{mode:0o700});
    const original=store.patch.bind(store);
    let entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    store.patch=async(id,update)=>{const result=await original(id,update);if(typeof update==='object'&&update.state==='running'){entered();await gate;}return result;};
    const runner=new TaskRunner(store,{executor:fake,resetBrowser:async()=>({closed:0})});
    await runner.enqueue(task.id);await started;await runner.cancel(task.id);release();
    for(let i=0;runner.draining&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(runner.draining,false);
    assert.equal(store.get(task.id).state,'cancelled');
    await assert.rejects(fs.access(path.join(store.directory(task.id),'launched-marker')));
  }finally{release?.();await fs.rm(root,{recursive:true,force:true});}
});
