import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('真实HTTP上传、状态查询、取消持久化；私人入口和来源检查阻止外站提交',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-http-'));
  const app=await createApp({dataRoot:root,basePath:'/private-test/',importExisting:false,runnerEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`,base=origin+'/private-test/';
  try{
    assert.equal((await fetch(origin+'/api/tasks')).status,404);
    assert.equal((await fetch(base)).status,200);
    const payload={category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]],imageData:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'};
    let response=await fetch(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json','origin':'https://evil.invalid'},body:JSON.stringify(payload)});
    assert.equal(response.status,403);
    response=await fetch(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,imageData:'data:image/png;base64,PHN2Zz4='})});
    assert.equal(response.status,400);
    response=await fetch(base+'api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(response.status,201);const task=await response.json();assert.equal(task.state,'queued');
    response=await fetch(base+'api/tasks/'+task.id);assert.equal((await response.json()).input.category,'挂画');
    response=await fetch(base+'api/tasks/'+task.id+'/cancel',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);
    assert.equal(app.store.get(task.id).state,'cancelled');
    await app.store.patch(task.id,{state:'partial',result:{competitors:[{asin:'B0F6ND1QZH'}],keywords:[{term:'bunny decor'}],titles:[{text:'上一轮旧标题'}]}});
    response=await fetch(base+'api/tasks/'+task.id+'/resume',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,200);
    assert.equal(app.store.get(task.id).mode,'full','数据不足时直接继续应补查，而不是只重写标题');
    assert.deepEqual(app.store.get(task.id).result.titles,[],'新一轮不能把旧标题作为当前结果展示');
    await app.runner.cancel(task.id);
    await app.store.patch(task.id,{state:'needs_input'});
    response=await fetch(base+'api/tasks/'+task.id+'/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({templateOne:'Brand {主体} Wall Art'})});
    assert.equal(response.status,200);
    assert.equal(app.store.get(task.id).mode,'titles_only','明确修改模板应复用当次现有词源');
    await app.runner.cancel(task.id);await app.store.patch(task.id,{state:'needs_input'});
    response=await fetch(base+'api/tasks/'+task.id+'/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({category:'马克杯',templateOne:'Brand {主体} Wall Art'})});
    assert.equal(response.status,400,'不能把挂画报告作为马克杯词源继续使用');
    assert.equal(app.store.get(task.id).input.category,'挂画');
    assert.equal((await fetch(base+'api/tasks/'+task.id+'/file?path=../../etc/passwd')).status,404);
  }finally{await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});
