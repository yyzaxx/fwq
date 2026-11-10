import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';

async function settled(runner){for(let i=0;i<250;i++){if(!runner.draining)return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('队列未停止');}
test('登录中断暂停后续图片，恢复时先处理受阻图片，再按原顺序继续',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-queue-'));
  try{
    const store=await new TaskStore(path.join(root,'jobs')).init(),log=path.join(root,'order.jsonl'),executor=path.join(root,'executor');
    await fs.writeFile(executor,'#!/usr/bin/env node\nconst fs=require("fs"),p=require("path"),id=p.basename(process.cwd());fs.appendFileSync('+JSON.stringify(log)+',id+"\\n");const first=id==="batch-image-001"&&!fs.existsSync("attempted");fs.writeFileSync("attempted","1");setTimeout(()=>{fs.writeFileSync("result.json",JSON.stringify({status:first?"needs_login":"partial",message:"fixture",titles:[],keywords:[],competitors:[],reportFile:""}));},30);\n',{mode:0o700});
    const input={category:'挂画',templateOne:'{主体}',templateTwo:'{主体}',ranges:[[1,80],[1,120]]};
    const ids=['batch-image-001','batch-image-002','batch-image-003'];
    for(const id of ids){await store.create(input,{id,imageFile:'design.jpg',state:'staged'});await fs.writeFile(path.join(store.directory(id),'preview.jpg'),'fixture');}
    const runner=new TaskRunner(store,{executor,resetBrowser:async()=>({closed:0})});await runner.enqueueMany(ids);await settled(runner);
    assert.equal(store.get(ids[0]).state,'needs_login');assert.equal(store.get(ids[1]).state,'queued');
    assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),[ids[0]]);
    await runner.resumeLogin();await settled(runner);
    assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),[ids[0],ids[0],ids[1],ids[2]]);
    assert.ok(ids.every(id=>store.get(id).state==='partial'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('服务重启后先继续中断的首图，排队图片保持提交顺序；登录屏障也会恢复',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-restore-'));
  try{
    const store=await new TaskStore(root).init();
    for(let i=1;i<=3;i++)await store.create({category:'挂画'},{id:'restart-image-00'+i,state:i===1?'running':'queued',queueOrder:i});
    const runner=new TaskRunner(store,{enabled:false});await runner.restore();
    assert.deepEqual(runner.queue,['restart-image-001','restart-image-002','restart-image-003']);
    await store.patch('restart-image-001',{state:'cancelled',loginBarrier:true});
    const again=new TaskRunner(store,{enabled:false});await again.restore();assert.equal(again.info().blockedForLogin,'restart-image-001');
    await Promise.all([again.resumeLogin(),again.resumeLogin()]);assert.equal(again.info().blockedForLogin,null);assert.deepEqual(again.queue,['restart-image-002','restart-image-003']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
