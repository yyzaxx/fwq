const {chromium}=require('playwright');
const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const outputDir=path.resolve(__dirname,'../test-results');fs.mkdirSync(outputDir,{recursive:true});
(async()=>{const base=process.env.QINGDAN_BASE_URL;if(!base)throw Error('请显式设置 QINGDAN_BASE_URL，脚本会创建并删除测试任务');const prefix='[上线验证-'+Date.now()+']';const log=[];let id;
const b=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
const api=async(path='',method='GET',body)=>{const r=await fetch(base+'/api/tasks'+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(r.status+' '+await r.text());return r.json()};
try{const a=await b.newPage(),p=await b.newPage();for(const x of [a,p]){x.setDefaultTimeout(8000);await x.goto(base);await x.waitForFunction(()=>document.querySelector('#saved').textContent.includes('已同步到服务器'))}
let dropped=false;
await a.route('**/api/tasks',async route=>{if(!dropped&&route.request().method()==='POST'){dropped=true;const saved=await route.fetch();assert.equal(saved.status(),201);id=(await saved.json()).task.id;await route.abort('failed')}else await route.continue()});
await a.locator('#task-input').fill(prefix+'新增');await a.locator('#add-form button').click();await a.waitForFunction(()=>document.querySelector('#saved').textContent.includes('失败'));await a.locator('#add-form button').click();await a.waitForFunction(()=>document.querySelector('#task-input').value==='');await a.getByRole('button',{name:'编辑：'+prefix+'新增',exact:true}).waitFor();assert.equal((await api()).tasks.filter(t=>t.title===prefix+'新增').length,1);log.push('公网模拟新增回执丢失，前端重试后服务器仅一条任务');
await p.getByRole('button',{name:'编辑：'+prefix+'新增',exact:true}).waitFor();await p.getByRole('button',{name:'编辑：'+prefix+'新增',exact:true}).click();await p.locator('#edit-input').fill(prefix+'跨设备修改');await p.getByRole('button',{name:'保存修改',exact:true}).click();await a.getByRole('button',{name:'完成：'+prefix+'跨设备修改',exact:true}).waitFor();log.push('两个独立浏览器实时同步新增与修改');
if(process.env.QINGDAN_RESTART_SERVICE==='yes')execFileSync('systemctl',['restart','qingdan']);for(let n=0;n<30;n++){try{const r=await fetch(base+'/api/health');if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
await a.reload();await a.getByRole('button',{name:'编辑：'+prefix+'跨设备修改',exact:true}).waitFor();assert.equal((await api()).tasks.find(t=>t.id===id).title,prefix+'跨设备修改');log.push(process.env.QINGDAN_RESTART_SERVICE==='yes'?'后端服务重启后服务器数据及页面任务仍保留':'页面刷新后服务器数据仍保留');
await a.getByRole('button',{name:'完成：'+prefix+'跨设备修改',exact:true}).click();await p.getByRole('button',{name:'标为待办：'+prefix+'跨设备修改',exact:true}).waitFor();log.push('完成状态跨浏览器同步');
await a.screenshot({path:path.join(outputDir,'server-live.png'),fullPage:true});
}finally{if(id){const task=(await api()).tasks.find(t=>t.id===id);if(task&&task.title.startsWith(prefix))await api('/'+id+'?version='+task.version,'DELETE');log.push('仅清理本次验证任务，未清空共享清单')}await b.close();fs.writeFileSync(path.join(outputDir,'server-live-smoke.json'),JSON.stringify({base,time:new Date().toISOString(),log},null,2));console.log(log.join('\n'))}
})().catch(e=>{console.error(e);process.exitCode=1});
