import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const MiB=1024*1024,runFile=promisify(execFile);
export function createBrowserRecycler({procRoot='/proc',cgroupRoot='/sys/fs/cgroup',managedBrowserOrigin='http://127.0.0.1:9223',runCommand=runFile}={}){
  let flight=null,lastRestart=0;
  const json=async(browserUrl,route)=>{
    const response=await fetch(new URL(route,browserUrl),{signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw Error('浏览器尚未就绪');return response.json();
  };
  return function recycle({browserUrl='http://127.0.0.1:9223',force=false}={}){
    if(flight)return flight;
    flight=(async()=>{
      const membership=(await fs.readFile(path.join(procRoot,'self/cgroup'),'utf8')).split('\n').find(line=>line.startsWith('0::'))?.slice(3)||'';
      const index=membership.indexOf('/listing.slice/');
      if(index<0||new URL(browserUrl).origin!==managedBrowserOrigin)return {restarted:false,reason:'not-managed'};
      const directory=path.join(cgroupRoot,membership.slice(0,index+'/listing.slice'.length),'listing-browser.service');
      const usage=async()=>{
        const [memory,swap,stat]=await Promise.all(['memory.current','memory.swap.current','memory.stat'].map(file=>fs.readFile(path.join(directory,file),'utf8')));
        return {memoryBytes:Number(memory.trim()),swapBytes:Number(swap.trim()),workingBytes:Number(stat.match(/^anon\s+(\d+)/m)?.[1]||0)+Number(stat.match(/^shmem\s+(\d+)/m)?.[1]||0)};
      };
      let before;
      try{before=await usage();}catch(error){if(error.code!=='ENOENT')throw error;before={memoryBytes:0,swapBytes:0,workingBytes:0,unavailable:true};}
      if(!force&&!before.unavailable&&before.swapBytes<64*MiB&&before.workingBytes<384*MiB)return {restarted:false,before,reason:'within-budget'};
      if(!force&&Date.now()-lastRestart<10000)return {restarted:false,before,reason:'just-recycled'};
      if(!before.unavailable){
        const targets=await json(browserUrl,'/json/list');
        if(!Array.isArray(targets))throw Error('浏览器页面列表无效');
        if(targets.some(target=>target.type==='page'&&target.url!=='about:blank'))return {restarted:false,before,reason:'pages-in-use'};
      }
      // 有意的任务间回收不消耗故障重启额度；真正的崩溃仍由原来的限速保护。
      try{
        await runCommand('systemctl',['reset-failed','listing-browser.service'],{timeout:5000,maxBuffer:16384});
        await runCommand('systemctl',['restart','listing-browser.service'],{timeout:20000,maxBuffer:16384});
      }catch{throw Error('专用浏览器资源回收未能完成');}
      const deadline=Date.now()+10000;
      while(true){
        try{
          const version=await json(browserUrl,'/json/version'),targets=await json(browserUrl,'/json/list');
          if(version.Browser&&Array.isArray(targets)&&targets.some(target=>target.type==='page'))break;
        }catch{}
        if(Date.now()>=deadline)throw Error('浏览器回收后未恢复连接，后续任务保持暂停');
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      const after=await usage();lastRestart=Date.now();return {restarted:true,before,after,ready:true};
    })().finally(()=>{flight=null;});
    return flight;
  };
}
