const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {createWebServer}=require('../web/server.cjs');
const ID='1267455947278647297';
async function fixture(t,control={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-web-features-')),runtime=path.join(dir,'runtime');fs.mkdirSync(runtime);fs.writeFileSync(path.join(runtime,'env.js'),"module.exports={COOKIE:'DedeUserID=123; SESSDATA=fake; bili_jct=csrf;'}");fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({uid:'123',dryRun:false,enginePath:path.resolve(__dirname,'../engine/LotteryAutoScript')}));
 const item={id_str:ID,type:'DYNAMIC_TYPE_FORWARD',orig:{id_str:'1167455947278647297'},modules:{module_author:{mid:123},module_dynamic:{desc:{text:'抽奖转发测试'}}}};const now=Date.now(),removed=[];
 const request=async endpoint=>{const u=new URL(endpoint,'https://api.bilibili.com');if(u.pathname==='/x/web-interface/nav')return {isLogin:true,mid:123};if(u.pathname.endsWith('/feed/space'))return {items:[item],has_more:false,offset:''};if(u.pathname.endsWith('/v1/detail'))return {item};if(u.hostname==='message.bilibili.com')return {system_notify_list:u.searchParams.has('cursor')?[]:[{id:321,cursor:42,notify_cursor:42,title:'互动抽奖中奖通知',content:'恭喜您在互动抽奖中中奖，请领取奖品。',time_at:new Date(now-3600000).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),card_link:'https://t.bilibili.com/'+ID}]};if(u.pathname.endsWith('/get_sessions'))return {session_list:[],has_more:0};if(u.pathname.includes('/x/msgfeed/'))return {items:[],cursor:{is_end:true}};throw Error('Unexpected test endpoint '+u.pathname)};
 let entered;const gate=new Promise(resolve=>entered=resolve);
 const hold=(signal)=>new Promise((resolve,reject)=>{entered();if(signal?.aborted)return reject(signal.reason);signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})});
 const winsRequest=async(endpoint,cookie,signal)=>{if(control.holdWins&&String(endpoint).includes('/x/sys-msg/')){control.holdWins=false;return hold(signal)}return request(endpoint,cookie,signal)};
 const dynamicRequest=async(endpoint,cookie,signal)=>{if(control.holdPreview&&String(endpoint).includes('/feed/space'))return hold(signal);return request(endpoint,cookie,signal)};
 const app=createWebServer({dataDir:dir,seedRoot:null,dynamicOptions:{request:dynamicRequest,remove:async id=>removed.push(id),interval:0},winOptions:{request:winsRequest,interval:0,now}});const base=await app.listen(0);const first=await(await fetch(base+'/api/bootstrap')).json();
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})});
 const post=(route,data,token=first.webToken)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-web-token':token},body:JSON.stringify(data)});
 const state=async()=>await(await fetch(base+'/api/bootstrap')).json();
 async function settled(){for(let i=0;i<100;i++){const s=await state();if(!s.process.running)return s;await new Promise(r=>setTimeout(r,10));}throw Error('Test job did not settle')}
 return {app,base,post,state,settled,removed,first,gate};
}
test('预览和确认删除分开，只有确认后的已核对转发被删除，后台任务可观察',async t=>{
 const f=await fixture(t);assert.equal((await f.post('/api/dynamics/preview',{scope:'reposts'},'wrong')).status,403);const p=await f.post('/api/dynamics/preview',{scope:'reposts'});assert.equal(p.status,202);let s=await f.settled();assert.equal(s.dynamicDeletion.count,1);assert.equal(s.dynamicDeletion.state,'preview');assert.deepEqual(f.removed,[]);
 assert.equal((await f.post('/api/dynamics/delete',{previewId:'not-the-preview'})).status,400);assert.deepEqual(f.removed,[]);
 assert.equal((await f.post('/api/dynamics/delete',{previewId:s.dynamicDeletion.previewId})).status,202);s=await f.settled();assert.equal(s.dynamicDeletion.deleted,1);assert.deepEqual(f.removed,[ID]);assert.doesNotMatch(JSON.stringify(s),/SESSDATA=|bili_jct=|"signature"/);
});
test('主页中奖字段首次未知，读取近7天站内通知后去重显示一次中奖',async t=>{
 const f=await fixture(t);assert.equal(f.first.wins.count,null);assert.equal((await f.post('/api/wins/refresh',{})).status,202);const s=await f.settled();assert.equal(s.wins.status,'ok');assert.equal(s.wins.count,1);assert.equal(s.wins.windowDays,7);
});
test('新增入口使用Web会话和同源校验，不能跨站触发删除',async t=>{
 const f=await fixture(t);const r=await fetch(f.base+'/api/dynamics/preview',{method:'POST',headers:{'content-type':'application/json','x-web-token':f.first.webToken,origin:'https://other.example'},body:JSON.stringify({scope:'all'})});assert.equal(r.status,403);assert.equal((await f.post('/api/dynamics/preview',{scope:'unknown'})).status,400);assert.deepEqual(f.removed,[]);
});
test('后台统计可被用户操作中止并让出任务位置，不阻塞动态预览',async t=>{
 const f=await fixture(t,{holdWins:true});assert.equal((await f.post('/api/wins/refresh',{})).status,202);await f.gate;assert.equal((await f.state()).process.action,'wins');assert.equal((await f.post('/api/dynamics/preview',{scope:'reposts'})).status,202);const s=await f.settled();assert.equal(s.dynamicDeletion.state,'preview');assert.equal(s.dynamicDeletion.count,1);assert.deepEqual(f.removed,[]);
});
test('动态任务占用时不能启动抽奖或切换账号，停止后才释放位置',async t=>{
 const f=await fixture(t,{holdPreview:true});assert.equal((await f.post('/api/dynamics/preview',{scope:'all'})).status,202);await f.gate;
 for(const [route,input]of [['/api/run',{action:'check'}],['/api/settings',{uid:'456'}]]){const r=await f.post(route,input);assert.equal(r.status,400);assert.match((await r.json()).error,/任务|运行/);}
 assert.equal((await f.state()).settings.uid,'123');assert.equal((await f.post('/api/stop',{})).status,200);const s=await f.settled();assert.equal(s.process.running,false);assert.equal(s.dynamicDeletion.state,'cancelled');assert.deepEqual(f.removed,[]);
});
