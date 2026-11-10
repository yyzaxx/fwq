import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createBrowserRecycler} from '../lib/browser-recycle.mjs';
const MiB=1024*1024;
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-recycle-')),procRoot=path.join(root,'proc'),cgroupRoot=path.join(root,'cgroup'),directory=path.join(cgroupRoot,'listing.slice/listing-browser.service');
 await fs.mkdir(path.join(procRoot,'self'),{recursive:true});await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(procRoot,'self/cgroup'),'0::/listing.slice/listing-web.service\n');
 const usage=async(swap=180,working=100)=>{await fs.writeFile(path.join(directory,'memory.current'),String((working+100)*MiB));await fs.writeFile(path.join(directory,'memory.swap.current'),String(swap*MiB));await fs.writeFile(path.join(directory,'memory.stat'),'anon '+working*MiB+'\nshmem 0\nfile '+100*MiB+'\n')};await usage();
 const state={ready:true,page:'about:blank',denied:false,reset:false};
 const browser=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(!state.ready){res.statusCode=503;return res.end('{}')}if(req.url==='/json/version')return res.end('{"Browser":"Chrome/Test"}');if(req.url==='/json/list')return res.end(JSON.stringify([{id:'page',type:'page',url:state.page},{id:'ui',type:'browser_ui',url:'chrome://ui/'}]));res.statusCode=404;res.end('{}')});await new Promise(resolve=>browser.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{browser.closeAllConnections();await new Promise(resolve=>browser.close(resolve));await fs.rm(root,{recursive:true,force:true})});
 const browserUrl='http://127.0.0.1:'+browser.address().port;
 const runCommand=async(command,args)=>{
  assert.equal(command,'systemctl');assert.equal(args[1],'listing-browser.service');
  if(state.denied)throw Error('permission denied');
  if(args[0]==='reset-failed'){state.reset=true;return {stdout:''}}assert.equal(args[0],'restart');assert.ok(state.reset,'有意回收必须先重置故障启动计数');state.reset=false;state.ready=false;
  setTimeout(()=>{void usage(0,64).then(()=>{state.ready=true})},40);return {stdout:''};
 };
 const recycle=createBrowserRecycler({procRoot,cgroupRoot,managedBrowserOrigin:browserUrl,runCommand});return {state,usage,recycle,browserUrl,procRoot,directory};
}
test('回收释放旧交换占用，并等浏览器真正就绪才返回',async t=>{const f=await fixture(t),r=await f.recycle({browserUrl:f.browserUrl});assert.equal(r.restarted,true);assert.equal(r.before.swapBytes,180*MiB);assert.equal(r.after.swapBytes,0);assert.equal(f.state.ready,true)});
test('连续有意回收不会耗尽故障重启额度',async t=>{const f=await fixture(t);for(let i=0;i<4;i++){await f.usage(180);const r=await f.recycle({browserUrl:f.browserUrl,force:true});assert.equal(r.after.swapBytes,0);assert.ok(r.ready)}});
test('占用较低或仍有用户页面时保留浏览器会话',async t=>{const f=await fixture(t);await f.usage(0,100);assert.equal((await f.recycle({browserUrl:f.browserUrl})).restarted,false);await f.usage(180);f.state.page='https://example.test/login';const r=await f.recycle({browserUrl:f.browserUrl});assert.equal(r.restarted,false);assert.equal(Number(await fs.readFile(path.join(f.directory,'memory.swap.current'),'utf8')),180*MiB)});
test('回收命令失败会明确拒绝，不返回虚假的成功',async t=>{const f=await fixture(t);f.state.denied=true;await assert.rejects(f.recycle({browserUrl:f.browserUrl}),/回收未能完成/);assert.equal(Number(await fs.readFile(path.join(f.directory,'memory.swap.current'),'utf8')),180*MiB)});
test('不在工作台资源组中的进程不操作生产浏览器',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.procRoot,'self/cgroup'),'0::/system.slice/other.service\n');const r=await f.recycle({browserUrl:f.browserUrl});assert.equal(r.restarted,false);assert.equal(Number(await fs.readFile(path.join(f.directory,'memory.swap.current'),'utf8')),180*MiB)});
