import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareArchive,BatchManager} from '../lib/batches.mjs';
import {TaskStore} from '../lib/store.mjs';
import {TaskRunner} from '../lib/runner.mjs';

const run=promisify(execFile);
export async function makeZip(directory,mode='valid'){
  const filename=path.join(directory,mode+'.zip');
  await run('python3',['-c',`import zipfile,sys,base64,stat
p=sys.argv[1];mode=sys.argv[2]
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC')
with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
 if mode=='valid':
  z.writestr('10.png',png);z.writestr('2.png',png);z.writestr('说明.txt','ignored');z.writestr('__MACOSX/._2.png',b'ignored');z.writestr('bad.png',b'not an image')
 elif mode=='traversal': z.writestr('../escape.png',png)
 elif mode=='symlink':
  i=zipfile.ZipInfo('link.png');i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,'/etc/passwd')
 elif mode=='too-many':
  for i in range(101):z.writestr(str(i)+'.png',png)
 elif mode=='empty':z.writestr('readme.txt','no images')
`,filename,mode]);return filename;
}
test('ZIP只接收可解码图片，保留顺序清单与跳过原因；危险路径和链接不能解压',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-zip-'));
  try{
    const target=path.join(root,'ready');await fs.mkdir(target);
    const prepared=await prepareArchive(await makeZip(root),target);
    assert.deepEqual(prepared.files.map(x=>x.name),['2.png','10.png']);
    assert.equal(prepared.skipped.length,3);
    for(const f of prepared.files){await fs.access(path.join(target,f.imageFile));await fs.access(path.join(target,f.previewFile));}
    for(const mode of ['traversal','symlink','too-many','empty']){
      const folder=path.join(root,mode);await fs.mkdir(folder);
      await assert.rejects(prepareArchive(await makeZip(root,mode),folder),/路径|链接|100|图片/);
    }
    await assert.rejects(fs.access(path.join(root,'escape.png')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('一批生成独立任务并固定模板快照，重复点击不重复创建',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-batch-'));
  try{
    const tasks=await new TaskStore(path.join(root,'jobs')).init(),batches=await new TaskStore(path.join(root,'batches')).init();
    const runner=new TaskRunner(tasks,{enabled:false}),manager=new BatchManager(tasks,batches,runner);
    const id='test-batch-001',dir=batches.directory(id);await fs.mkdir(dir,{recursive:true});
    const prepared=await prepareArchive(await makeZip(root),dir);
    await batches.create(null,{id,name:'商品.zip',state:'draft',files:prepared.files,skipped:prepared.skipped,taskIds:[]});
    const input={category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[65,75],[115,125]]};
    const [a,b]=await Promise.all([manager.start(id,input),manager.start(id,input)]);
    assert.deepEqual(a.taskIds,b.taskIds);assert.equal(tasks.list().length,2);
    input.templateOne='Changed';input.ranges[0][0]=1;
    const [one,two]=a.taskIds.map(x=>tasks.get(x));
    assert.equal(one.name,'2.png');assert.equal(two.name,'10.png');assert.equal(one.batchIndex,1);assert.equal(two.batchIndex,2);
    assert.equal(one.input.templateOne,'Brand {主体} Wall Art');assert.equal(two.input.ranges[0][0],65);
    assert.notEqual(tasks.directory(one.id),tasks.directory(two.id));
    assert.deepEqual(runner.queue,a.taskIds);
    const restored=new TaskRunner(tasks,{enabled:false});await restored.restore();assert.deepEqual(restored.queue,a.taskIds);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('ZIP经真实HTTP预览后统一提交，可刷新读取批次及逐图任务，取消不删除已有资料',async()=>{
  const {createApp}=await import('../server.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-batch-http-'));
  const app=await createApp({dataRoot:path.join(root,'jobs'),basePath:'/batch-test/',importExisting:false,runnerEnabled:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port+'/batch-test/api/';
  try{
    const binary=await fs.readFile(await makeZip(root));
    let response=await fetch(base+'batches/preview',{method:'POST',headers:{'content-type':'application/zip','x-file-name':encodeURIComponent('商品图片.zip')},body:binary});
    assert.equal(response.status,201);const preview=await response.json();
    assert.equal(preview.name,'商品图片.zip');assert.equal(preview.files.length,2);assert.equal(preview.skipped.length,3);
    response=await fetch(base+'batches/'+preview.id+'/preview/'+preview.files[0].id);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.ok((await response.arrayBuffer()).byteLength>0);
    assert.equal((await fetch(base+'batches/'+preview.id+'/preview/999')).status,404);
    const input={category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]]};
    const submit=()=>fetch(base+'batches/'+preview.id+'/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
    response=await submit();assert.equal(response.status,200);const batch=await response.json();await submit();assert.equal(app.store.list().length,2);
    assert.deepEqual(batch.files.map(x=>x.taskId),batch.taskIds);assert.equal(batch.counts.queued,2);
    response=await fetch(base+'batches/'+batch.id+'/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,category:'马克杯'})});assert.equal(response.status,400);
    assert.deepEqual((await (await fetch(base+'batches')).json())[0].taskIds,batch.taskIds);
    response=await fetch(base+'batches/'+batch.id+'/cancel',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);
    assert.equal((await response.json()).counts.stopped,2);assert.ok(batch.taskIds.every(id=>app.store.get(id).state==='cancelled'));
    await app.store.patch(batch.taskIds[0],{state:'cancelled',loginBarrier:true});app.runner.blockedForLogin=batch.taskIds[0];
    response=await fetch(base+'tasks/'+batch.taskIds[0]+'/resume',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,200);assert.equal((await response.json()).state,'queued','明确继续已停止的受阻图片必须重新入队');
    assert.deepEqual(app.runner.queue,[batch.taskIds[0]]);assert.equal(app.runner.info().blockedForLogin,null);
    const restored=await new TaskStore(path.join(root,'jobs','_batches')).init();assert.deepEqual(restored.get(batch.id).taskIds,batch.taskIds);
  }finally{await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
});

test('批次正在准备时点击停止，不能在停止返回后重新入队',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-batch-stop-'));let release;
  try{
    const tasks=await new TaskStore(path.join(root,'jobs')).init(),batches=await new TaskStore(path.join(root,'batches')).init();
    const runner=new TaskRunner(tasks,{enabled:false}),manager=new BatchManager(tasks,batches,runner),id='batch-cancel-001';
    const directory=batches.directory(id);await fs.mkdir(directory,{recursive:true});const prepared=await prepareArchive(await makeZip(root),directory);
    await batches.create(null,{id,state:'draft',files:prepared.files,skipped:[],taskIds:[]});
    let entered;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),original=tasks.create.bind(tasks);
    tasks.create=async(...args)=>{const task=await original(...args);if(task.batchIndex===1){entered();await gate;}return task;};
    const starting=manager.start(id,{category:'挂画',templateOne:'{主体}',templateTwo:'{主体}',ranges:[[1,50],[1,50]]});await ready;
    const stopping=manager.cancel(id);release();await Promise.all([starting,stopping]);
    assert.ok(tasks.list().every(task=>task.state==='cancelled'));assert.deepEqual(runner.queue,[]);
  }finally{release?.();await fs.rm(root,{recursive:true,force:true});}
});

test('停止含重试图片的批次时先移除所有排队图片，再停止当前图片',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-stop-order-'));
  try{
    const tasks=await new TaskStore(path.join(root,'jobs')).init(),batches=await new TaskStore(path.join(root,'batches')).init(),stopped=[];
    await tasks.create(null,{id:'retry-image-001',state:'queued'});await tasks.create(null,{id:'active-image-002',state:'running'});
    await batches.create(null,{id:'batch-stop-order',files:[{id:'001'},{id:'002'}],taskIds:['retry-image-001','active-image-002']});
    const runner={async cancel(id){stopped.push(id);await tasks.patch(id,{state:'cancelled'});}};
    await new BatchManager(tasks,batches,runner).cancel('batch-stop-order');
    assert.deepEqual(stopped,['retry-image-001','active-image-002']);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
