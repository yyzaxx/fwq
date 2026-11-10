import fs from 'node:fs/promises';
import path from 'node:path';
import {MAX_BROWSER_PAGES,enforceBrowserPageLimit} from './browser-cleanup.mjs';

const MiB=1024*1024;
export function resourceProblem(s,phase='running'){
  if(!Number.isFinite(s.memoryMax)||s.memoryMax<=0||!Number.isFinite(s.swapMax))return '服务器资源上限尚未生效，请检查配置后继续';
  if(s.oomIncreased)return '工作台已发生内存超限，任务已暂停，请检查后继续';
  if(s.pageCount>MAX_BROWSER_PAGES)return `浏览器超过${MAX_BROWSER_PAGES}个标签页且未能自动整理，任务已暂停；检查浏览器后再继续`;
  if(s.memoryCurrent>=s.memoryMax*0.9)return '工作台内存已接近上限，任务已暂停，已有资料保留';
  if(s.swapMax>0){
    const reserve=Math.min(32*MiB,s.swapMax*0.1);
    if(s.swapCurrent>=s.swapMax-reserve)return '工作台交换空间接近硬上限，任务已暂停，已有资料保留';
    const pressure=(s.memorySomeAvg10||0)>=20||(s.memoryFullAvg10||0)>=5||s.availableBytes<256*MiB;
    if(s.swapCurrent>=s.swapMax*0.75&&pressure)return '工作台交换空间占用较高且出现内存压力，任务已暂停，已有资料保留';
  }
  if(s.availableBytes<128*MiB)return '服务器可用内存不足，任务已暂停，已有资料保留';
  if(phase==='before'&&(s.memoryCurrent+192*MiB>s.memoryMax||s.availableBytes<256*MiB))return '服务器暂时没有足够内存开始下一项，请释放资源后继续';
  return null;
}

export function createResourceChecker({procRoot='/proc',cgroupRoot='/sys/fs/cgroup',requireLimits=process.env.NODE_ENV==='production',readBrowserTargets=async url=>{
  const response=await fetch(url+'/json/list',{signal:AbortSignal.timeout(1500)});
  if(!response.ok)throw Error('浏览器未连接');
  const targets=await response.json();if(!Array.isArray(targets))throw Error('浏览器页面列表无效');return targets;
}}={}){
  let lastOOMKills=null;
  return async({phase='running',browserUrl='http://127.0.0.1:9223'}={})=>{
    try{
      const membership=(await fs.readFile(path.join(procRoot,'self/cgroup'),'utf8')).split('\n').find(row=>row.startsWith('0::'))?.slice(3)||'';
      const index=membership.indexOf('/listing.slice/');
      if(index<0)return requireLimits?'工作台尚未处于资源保护范围内，已暂停启动任务':null;
      const root=path.join(cgroupRoot,membership.slice(0,index+'/listing.slice'.length));
      const [current,max,swap,swapMax,meminfo,events,pressure]=await Promise.all([
        ...['memory.current','memory.max','memory.swap.current','memory.swap.max'].map(file=>fs.readFile(path.join(root,file),'utf8')),
        fs.readFile(path.join(procRoot,'meminfo'),'utf8'),fs.readFile(path.join(root,'memory.events'),'utf8'),
        fs.readFile(path.join(root,'memory.pressure'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})
      ]);
      const oomKills=Number(events.match(/^oom_kill\s+(\d+)/m)?.[1]||0);
      const oomIncreased=lastOOMKills!==null&&oomKills>lastOOMKills;lastOOMKills=oomKills;
      const snapshot={memoryCurrent:Number(current.trim()),memoryMax:Number(max.trim()),swapCurrent:Number(swap.trim()),swapMax:Number(swapMax.trim()),availableBytes:Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]||0)*1024,oomIncreased,memorySomeAvg10:Number(pressure.match(/^some .*?avg10=([\d.]+)/m)?.[1]||0),memoryFullAvg10:Number(pressure.match(/^full .*?avg10=([\d.]+)/m)?.[1]||0)};
      const problem=resourceProblem(snapshot,phase);if(problem)return problem;
      let targets;try{targets=await readBrowserTargets(browserUrl);}catch{return '浏览器连接中断，任务已暂停；恢复浏览器后再继续';}
      if(targets.filter(t=>t.type==='page').length>MAX_BROWSER_PAGES){
        try{await enforceBrowserPageLimit(browserUrl);targets=await readBrowserTargets(browserUrl);}
        catch{return `浏览器超过${MAX_BROWSER_PAGES}个标签页且自动关闭失败，任务已暂停；检查浏览器后再继续`;}
      }
      return resourceProblem({...snapshot,pageCount:targets.filter(t=>t.type==='page').length},phase);
    }catch{return '暂时无法核实服务器资源余量，任务已暂停，请检查后继续';}
  };
}
