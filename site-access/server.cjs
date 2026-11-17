'use strict';
// Optional per-site access control. Upstreams must listen only on loopback.
const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs');
const sites=[['clawchat',8795,18795,'ClawChat'],['listing',8796,18796,'Listing Studio'],['workbuddy',8600,18600,'WorkBuddy'],['octop',13947,23947,'Octop'],['bili',8790,8787,'BiliLottery']];
const octopKey=fs.readFileSync('/opt/site-access/octop.key','utf8').trim();
const file=process.env.STATE_FILE||'/opt/site-access/state.json';
let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
function save(){fs.writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(file+'.tmp',file)}
const sessions=new Map(), failures=new Map();
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
function check(p,c){if(!c)return true;const h=hash(p,c.salt);return crypto.timingSafeEqual(Buffer.from(h),Buffer.from(c.hash))}
const cookie=(req,key)=>{const m=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='));return m?m.slice(key.length+1):''};
function session(req,id){const token=cookie(req,'site_access_'+id);let s=sessions.get(token);if(!s||s.id!==id||s.expires<Date.now())return null;return s}
function authorized(req,id){return !state[id]||session(req,id)?.version===state[id].version}
function issue(req,res,id){const token=crypto.randomBytes(32).toString('hex');const s={id,csrf:crypto.randomBytes(32).toString('hex'),version:state[id]?.version,expires:Date.now()+86400000};sessions.set(token,s);res.setHeader('Set-Cookie','site_access_'+id+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');return s}
function reply(res,status,data,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(typeof data==='string'?data:JSON.stringify(data))}
const page=(title,body)=>'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><style>body{font:16px system-ui;background:#f4f6f9;color:#18202d;max-width:520px;margin:8vh auto;padding:24px}main{background:white;padding:28px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;font:inherit}button{cursor:pointer}a{color:#2563eb}p{line-height:1.7}#msg{white-space:pre-wrap}</style><main>'+body+'</main></html>';
const injection=id=>'<script src="/_access/ui.js" data-site="'+id+'" defer></script>';
async function body(req){let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>8192)throw Error('请求过大');chunks.push(c)}return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
function originOK(req){return req.headers.origin==='http://'+req.headers.host && !['cross-site'].includes(req.headers['sec-fetch-site'])}
for(const [id,port,upstream,name] of sites){
 const server=http.createServer(async(req,res)=>{
  try{
   const path=req.url.split('?')[0];
   // Listing's legacy entry is also reachable through ClawChat; enforce both gates.
   if(id==='clawchat'&&(path.startsWith('/listing-app/')||path.startsWith('/listing-browser/'))&&!authorized(req,'listing'))return reply(res,401,{error:'请先在 Listing Studio 登录',login:'http://'+req.headers.host.replace(/:\d+$/,':8796')+'/_access/settings'});
   if(path==='/_access/login'&&req.method==='POST'){
    if(!originOK(req))return reply(res,403,{error:'来源校验失败'});
    const key=id+':'+req.socket.remoteAddress, f=failures.get(key);
    if(f&&f.count>=10&&f.until>Date.now())return reply(res,429,{error:'尝试过多，请十分钟后重试'});
    const b=await body(req);
    if(typeof b.password!=='string'||b.password.length>256||!check(b.password,state[id])){failures.set(key,{count:f&&f.until>Date.now()?f.count+1:1,until:Date.now()+600000});return reply(res,401,{error:'密码错误'})}
    failures.delete(key);issue(req,res,id);return reply(res,200,{ok:true});
   }
   if(!authorized(req,id)){
    if(req.method!=='GET')return reply(res,401,{error:'请先登录',login:'/_access/settings'});
    return reply(res,200,page(name+' · 登录','<h1>'+name+'</h1><p>此网站已启用访问密码。</p><form id="form"><input id="pwd" type="password" autocomplete="current-password" required placeholder="访问密码"><button>进入网站</button></form><p id="msg"></p><script>form.onsubmit=async e=>{e.preventDefault();try{let r=await fetch("/_access/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pwd.value})});let d=await r.json();if(!r.ok)throw Error(d.error);location.href="/"}catch(e){msg.textContent=e.message}}</script>'),'text/html; charset=utf-8');
   }
   if(path==='/_access/settings'&&req.method==='GET'){
    const s=session(req,id)||issue(req,res,id);
    return reply(res,200,page(name+' · 访问密码设置','<h1>'+name+' · 访问密码</h1><p>当前：<strong>'+(state[id]?'已开启密码保护':'免密码访问')+'</strong></p><p>密码仅控制本网站入口，不修改业务账号或 API 密钥。免密时任何访问者都能操作网站及此设置。当前使用 HTTP，密码在传输中未加密。</p><form id="form"><input id="old" type="password" autocomplete="current-password" placeholder="当前密码（已启用时必填）"><input id="pwd" type="password" autocomplete="new-password" minlength="8" maxlength="256" placeholder="新密码（至少 8 位）"><input id="repeatPwd" type="password" autocomplete="new-password" placeholder="再次输入新密码"><button type="submit">设置 / 修改密码</button><button type="button" id="disable">关闭密码，恢复免密</button></form><p id="msg"></p><a href="/" id="back">返回网站</a><script>if(new URLSearchParams(location.search).has("embedded")){back.remove();document.querySelector("h1").remove();document.body.style.cssText="font:14px system-ui;background:transparent;color:#18202d;margin:0;padding:0;max-width:none";document.querySelector("main").style.cssText="padding:16px;border-radius:8px"}const csrf='+JSON.stringify(s.csrf)+';async function change(disable){try{if(!disable&&(pwd.value.length<8||pwd.value!==repeatPwd.value))throw Error("新密码至少 8 位，两次输入须一致");const r=await fetch("/_access/config",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({current:old.value,password:pwd.value,disable})});const d=await r.json();if(!r.ok)throw Error(d.error);location.reload()}catch(e){msg.textContent=e.message}}form.onsubmit=e=>{e.preventDefault();change(false)};disable.onclick=()=>{if(window.confirm("关闭密码后，任何能访问网站的人都可操作。确认关闭？"))change(true)}</script>'),'text/html; charset=utf-8');
   }
   if(path==='/_access/config'&&req.method==='POST'){
    const s=session(req,id);if(!originOK(req)||!s||req.headers['x-csrf-token']!==s.csrf)return reply(res,403,{error:'请刷新设置页重试'});
    const b=await body(req);if(state[id]&&(typeof b.current!=='string'||b.current.length>256||!check(b.current,state[id])))return reply(res,403,{error:'当前密码错误'});
    if(b.disable!==true&&(typeof b.password!=='string'||b.password.length<8||b.password.length>256))return reply(res,400,{error:'密码长度须为 8–256 位'});
    if(b.disable===true)delete state[id];else{const salt=crypto.randomBytes(16).toString('hex');state[id]={salt,hash:hash(b.password,salt),version:crypto.randomBytes(16).toString('hex')}}
    save();for(const [key,value]of sessions)if(value.id===id)sessions.delete(key);issue(req,res,id);return reply(res,200,{ok:true});
   }
   if(path==='/_access/ui.js'&&req.method==='GET')return reply(res,200,fs.readFileSync('/opt/site-access/settings-ui.js','utf8'),'application/javascript; charset=utf-8');
   if(path.startsWith('/_access/'))return reply(res,404,{error:'Not found'});
   const headers={...req.headers};delete headers['accept-encoding'];delete headers['x-site-access-key'];
   if(id==='octop'&&path==='/api/auth/site-access-session')headers['x-site-access-key']=octopKey;
   if(id==='bili'){headers.host='127.0.0.1:8787';delete headers.origin;delete headers.referer;delete headers['x-forwarded-for'];delete headers['x-real-ip'];}
   const up=http.request({host:'127.0.0.1',port:upstream,path:req.url,method:req.method,headers},r=>{
    const h={...r.headers};const html=(h['content-type']||'').includes('text/html')&&!h['content-encoding']&&req.method!=='HEAD';
    if(html){delete h['content-length'];delete h.etag;delete h['content-md5'];h['cache-control']='no-store'}
    res.writeHead(r.statusCode,h);
    if(html&&id==='octop'){
     const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{
      let doc=Buffer.concat(chunks).toString('utf8').replace(/type="module"/g,'type="site-access-module"');
      doc+='<script>(async()=>{try{const r=await fetch("/api/auth/site-access-session",{cache:"no-store"});if(!r.ok)throw Error("登录初始化失败");const d=await r.json();localStorage.removeItem("auth_token");sessionStorage.setItem("auth_token",d.access_token);if(location.pathname==="/login")history.replaceState(null,"","/");for(const old of document.querySelectorAll(\'script[type="site-access-module"]\')){const s=document.createElement("script");for(const a of old.attributes)s.setAttribute(a.name,a.value);s.type="module";s.textContent=old.textContent;old.replaceWith(s)}}catch(e){document.body.insertAdjacentHTML("afterbegin","<p>登录初始化失败，请刷新页面重试。</p>")}})()</script>';
      res.end(doc+injection(id));
     });
    }else{r.pipe(res,{end:!html});if(html)r.on('end',()=>res.end(injection(id)));}
   });up.on('error',()=>{if(!res.headersSent)reply(res,502,{error:'网站暂时不可用'});else res.destroy()});req.on('aborted',()=>up.destroy());res.on('close',()=>up.destroy());req.pipe(up);
  }catch(e){if(!res.headersSent)reply(res,400,{error:'请求无效'});else res.destroy()}
 });
 server.requestTimeout=0;
 server.on('upgrade',(req,socket,head)=>{
  if((id==='clawchat'&&(req.url.startsWith('/listing-app/')||req.url.startsWith('/listing-browser/'))&&!authorized(req,'listing'))||!authorized(req,id)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
  if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return}
  const up=http.request({host:'127.0.0.1',port:upstream,path:req.url,headers:req.headers});
  up.on('upgrade',(r,s,h)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(head.length)s.write(head);if(h.length)socket.write(h);socket.pipe(s).pipe(socket);socket.on('error',()=>s.destroy());s.on('error',()=>socket.destroy())});
  up.on('response',r=>{socket.end('HTTP/1.1 '+r.statusCode+' Rejected\r\nConnection: close\r\n\r\n');r.resume()});up.on('error',()=>socket.destroy());up.end();
 });
 server.listen(port,'0.0.0.0',()=>console.log(name+': '+port+' -> '+upstream));
}
setInterval(()=>{const now=Date.now();for(const [k,v] of sessions)if(v.expires<now)sessions.delete(k);for(const [k,v]of failures)if(v.until<now)failures.delete(k)},60000).unref();
