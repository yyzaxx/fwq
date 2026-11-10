import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
test('从任务详情继续被资源中止的图片时同步解除已恢复的资源屏障',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-resource-http-'));
  const app=await createApp({dataRoot:root,basePath:'/qa/',importExisting:false,runnerEnabled:false});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true})});
  const task=await app.store.create({category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]]},{id:'resume-resource-http',state:'failed',resourcePause:{status:'paused',message:'交换空间占用过高'}});
  await app.runner.restore();app.runner.resourceCheck=async()=>null;
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/qa/api/tasks/'+task.id+'/resume',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.equal(app.store.get(task.id).state,'queued');assert.equal(app.runner.info().resourceError,null);assert.deepEqual(app.runner.queue,[task.id]);
});
