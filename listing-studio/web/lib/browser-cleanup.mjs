export const MAX_BROWSER_PAGES=2;
const pageLimitFlights=new Map();
const pageCleanupFlights=new Map();

// 并发的队列检查和后台检查共用一次回收，避免重复选择要关闭的页面。
export function enforceBrowserPageLimit(browserUrl){
  const origin=new URL(browserUrl);
  if(!['http:','https:'].includes(origin.protocol))return Promise.reject(new Error('浏览器地址无效'));
  const key=origin.origin;
  const cleanup=pageCleanupFlights.get(key);
  if(cleanup)return cleanup.catch(()=>{}).then(()=>enforceBrowserPageLimit(browserUrl));
  if(pageLimitFlights.has(key))return pageLimitFlights.get(key);
  const flight=(async()=>{
    const deadline=Date.now()+3000,requested=new Set();
    while(true){
      const response=await fetch(new URL('/json/list',origin),{signal:AbortSignal.timeout(1500)});
      if(!response.ok)throw Error('无法取得浏览器页面');
      const targets=await response.json();
      if(!Array.isArray(targets)||targets.some(t=>!t||typeof t.id!=='string'||typeof t.type!=='string'))throw Error('浏览器页面列表无效');
      const pages=targets.filter(t=>t.type==='page');
      if(pages.length<=MAX_BROWSER_PAGES)return {targets,closed:requested.size};
      if(Date.now()>=deadline)throw Error('多余浏览器页面未能及时关闭');
      const victims=[...pages.filter(t=>t.url==='about:blank'),...pages.toReversed().filter(t=>t.url!=='about:blank')].slice(0,pages.length-MAX_BROWSER_PAGES).filter(t=>!requested.has(t.id));
      await Promise.all(victims.map(async target=>{
        const closed=await fetch(new URL('/json/close/'+encodeURIComponent(target.id),origin),{signal:AbortSignal.timeout(1500)});
        if(!closed.ok&&closed.status!==404)throw Error('多余浏览器页面关闭失败');
        requested.add(target.id);
      }));
      await new Promise(resolve=>setTimeout(resolve,60));
    }
  })().finally(()=>pageLimitFlights.delete(key));
  pageLimitFlights.set(key,flight);return flight;
}

// 只回收专用浏览器的页面，不清 Cookie、缓存或其他登录数据。
export async function resetBrowserPages(browserUrl){
  const origin=new URL(browserUrl),key=origin.origin;
  if(pageCleanupFlights.has(key))return pageCleanupFlights.get(key);
  const prior=pageLimitFlights.get(key);
  const flight=(async()=>{if(prior)await prior.catch(()=>{});return resetPages(browserUrl);})().finally(()=>pageCleanupFlights.delete(key));
  pageCleanupFlights.set(key,flight);return flight;
}

async function resetPages(browserUrl){
  const origin=new URL(browserUrl);
  if(!['http:','https:'].includes(origin.protocol))throw new Error('浏览器地址无效');
  async function request(route,options={}){
    const response=await fetch(new URL(route,origin),{...options,signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('浏览器页面清理失败：HTTP '+response.status);
    return response;
  }
  const list=async()=>{
    const targets=await(await request('/json/list')).json();
    if(!Array.isArray(targets)||targets.some(t=>!t||typeof t.id!=='string'||typeof t.type!=='string'))throw new Error('浏览器页面列表无效');
    return targets;
  };
  let targets=await list(),keep=targets.find(t=>t.type==='page'&&t.url==='about:blank'),closed=0;
  if(!keep){
    // 先为收尾空白页腾出位置，保持过程中的标签数量也不超过上限。
    const pages=targets.filter(t=>t.type==='page');
    if(pages.length>=MAX_BROWSER_PAGES){
      for(const target of pages.toReversed().slice(0,pages.length-MAX_BROWSER_PAGES+1)){
        const response=await fetch(new URL('/json/close/'+encodeURIComponent(target.id),origin),{signal:AbortSignal.timeout(8000)});
        if(!response.ok&&response.status!==404)throw Error('浏览器页面清理失败：HTTP '+response.status);
        closed++;
      }
      const deadline=Date.now()+3000;
      while((await list()).filter(t=>t.type==='page').length>=MAX_BROWSER_PAGES){
        if(Date.now()>=deadline)throw Error('无法为收尾空白页释放位置');
        await new Promise(resolve=>setTimeout(resolve,60));
      }
    }
    keep=await(await request('/json/new?about:blank',{method:'PUT'})).json();
    if(!keep||typeof keep.id!=='string'||keep.type!=='page'||keep.url!=='about:blank')throw new Error('无法创建浏览器空白页');
  }
  // 先确保空白页存在，避免关掉最后一个标签后整个浏览器退出。
  targets=await list();
  if(!targets.some(t=>t.id===keep.id&&t.type==='page'))throw new Error('浏览器空白页未就绪');
  for(const target of targets){
    if(target.type!=='page'||target.id===keep.id)continue;
    const response=await fetch(new URL('/json/close/'+encodeURIComponent(target.id),origin),{signal:AbortSignal.timeout(8000)});
    if(!response.ok&&response.status!==404)throw new Error('浏览器页面清理失败：HTTP '+response.status);
    closed++;
  }
  // Chrome确认关闭请求时，目标可能仍短暂出现在列表中。
  const deadline=Date.now()+3000;
  while(true){
    const remaining=(await list()).filter(t=>t.type==='page');
    if(remaining.length===1&&remaining[0].id===keep.id)break;
    if(Date.now()>=deadline)throw new Error('浏览器仍有未回收页面，请重试');
    await new Promise(resolve=>setTimeout(resolve,75));
  }
  return {closed,remaining:1};
}
