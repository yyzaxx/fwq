import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resourceProblem,createResourceChecker} from '../lib/resources.mjs';

const MiB=1024*1024;
const healthy={memoryCurrent:400*MiB,memoryMax:1024*MiB,swapCurrent:0,swapMax:512*MiB,availableBytes:600*MiB,pageCount:2};
test('开始任务与运行中的资源阈值分别保护预留内存、交换空间和标签数量',()=>{
  assert.equal(resourceProblem(healthy,'before'),null);
  for(const patch of [{memoryCurrent:950*MiB},{swapCurrent:490*MiB},{availableBytes:80*MiB},{pageCount:3},{oomIncreased:true},{memoryMax:Infinity}])assert.ok(resourceProblem({...healthy,...patch}));
  assert.ok(resourceProblem({...healthy,availableBytes:200*MiB},'before'));
  assert.equal(resourceProblem({...healthy,availableBytes:200*MiB},'running'),null);
});
test('历史交换页占用较高但内存充足且无持续压力时允许任务继续',()=>{
  assert.equal(resourceProblem({...healthy,swapCurrent:400*MiB,memorySomeAvg10:0,memoryFullAvg10:0}),null);
  assert.equal(resourceProblem({...healthy,swapCurrent:400*MiB,memorySomeAvg10:0,memoryFullAvg10:0},'before'),null);
});
test('交换空间较高并出现持续内存阻塞或主机可用内存下降时暂停',()=>{
  assert.match(resourceProblem({...healthy,swapCurrent:400*MiB,memorySomeAvg10:25}),/交换空间/);
  assert.match(resourceProblem({...healthy,swapCurrent:400*MiB,memoryFullAvg10:8}),/交换空间/);
  assert.match(resourceProblem({...healthy,swapCurrent:400*MiB,availableBytes:200*MiB}),/交换空间/);
});
test('交换空间接近硬上限时即使主机空闲也提前暂停',()=>{
  assert.match(resourceProblem({...healthy,swapCurrent:490*MiB,memorySomeAvg10:0,memoryFullAvg10:0}),/交换空间/);
});
test('从当前进程所属的共同slice读取实际限制，检测OOM和浏览器断连',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-cgroup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const procRoot=path.join(root,'proc'),cgroupRoot=path.join(root,'cgroup'),slice=path.join(cgroupRoot,'listing.slice');
  await fs.mkdir(path.join(procRoot,'self'),{recursive:true});await fs.mkdir(slice,{recursive:true});
  await fs.writeFile(path.join(procRoot,'self/cgroup'),'0::/listing.slice/listing-web.service\n');await fs.writeFile(path.join(procRoot,'meminfo'),'MemAvailable: 614400 kB\n');
  for(const [file,value] of Object.entries({'memory.current':400*MiB,'memory.max':1024*MiB,'memory.swap.current':0,'memory.swap.max':512*MiB,'memory.events':'oom_kill 0\n'}))await fs.writeFile(path.join(slice,file),String(value));
  let disconnected=false;
  const check=createResourceChecker({procRoot,cgroupRoot,requireLimits:true,readBrowserTargets:async()=>{if(disconnected)throw Error('offline');return [{type:'page'},{type:'browser_ui'}]}});
  assert.equal(await check(),null);
  await fs.writeFile(path.join(slice,'memory.swap.current'),String(400*MiB));
  await fs.writeFile(path.join(slice,'memory.pressure'),'some avg10=0.00 avg60=0.00 avg300=0.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=50\n');
  assert.equal(await check(),null);
  await fs.writeFile(path.join(slice,'memory.pressure'),'some avg10=25.00 avg60=0.00 avg300=0.00 total=100\nfull avg10=8.00 avg60=0.00 avg300=0.00 total=50\n');
  assert.match(await check(),/交换空间/);
  await fs.writeFile(path.join(slice,'memory.swap.current'),'0');
  await fs.writeFile(path.join(slice,'memory.events'),'oom_kill 1\n');assert.match(await check(),/超限/);
  assert.equal(await check(),null);disconnected=true;assert.match(await check(),/连接中断/);
  await fs.writeFile(path.join(procRoot,'self/cgroup'),'0::/system.slice/unprotected.service\n');assert.match(await check(),/保护范围/);
});
