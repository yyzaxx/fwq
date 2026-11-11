const crypto=require('node:crypto');
const {extractCookie,DEFAULT_UA}=require('./config.cjs');
const HOSTS=new Set(['api.bilibili.com','api.vc.bilibili.com','message.bilibili.com']);
const validDynamicId=id=>typeof id==='string'&&/^[1-9]\d{0,21}$/.test(id);
function endpointUrl(endpoint){
 if(typeof endpoint!=='string'||endpoint.startsWith('//'))throw Error('站内接口地址无效');
 const url=new URL(endpoint,'https://api.bilibili.com');
 if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.port||url.username||url.password)throw Error('不允许的站内接口地址');
 return url;
}
function errorFor(code){const error=Error(code===-101?'B站登录已失效，请重新扫码登录':[-352,-412,412,429].includes(code)?`B站要求验证或限制请求（${code}），任务已停止`:`B站接口返回 ${code}，任务已停止`);error.code=code;return error;}
async function send(url,cookie,signal,options={}){
 signal?.throwIfAborted();
 const response=await fetch(url,{...options,headers:{'User-Agent':DEFAULT_UA,Referer:'https://www.bilibili.com/',Cookie:cookie,...options.headers},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 if(!response.ok)throw errorFor(response.status);
 let result;try{result=await response.json()}catch{throw Error('B站接口未返回有效数据，请检查登录或验证状态')}
 if(result?.code!==0)throw errorFor(result?.code??'unknown');
 return result.data??{};
}
async function requestBili(endpoint,cookie,signal){return send(endpointUrl(endpoint),cookie,signal);}
async function verifyAccount(runtime,settings,options={}){
 const cookie=extractCookie(runtime),uid=String(settings.uid||'').trim(),local=cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/i)?.[1];
 if(!/^[1-9]\d{0,21}$/.test(uid))throw Error('请先填写并保存账号UID');
 if(local!==uid||!/(?:^|;\s*)SESSDATA=[^;]+/i.test(cookie))throw Error('当前账号与本地登录凭证不一致，请重新登录');
 const account=await (options.request||requestBili)('/x/web-interface/nav',cookie,options.signal);
 if(!account?.isLogin||String(account.mid)!==uid)throw Error('B站登录账号核对失败，请重新登录');
 return {uid,cookie,signature:crypto.createHash('sha256').update(cookie).digest('hex')};
}
async function removeDynamic(id,cookie,signal){
 if(!validDynamicId(id))throw Error('删除动态ID无效');
 const csrf=cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/i)?.[1];if(!csrf)throw Error('登录凭证缺少CSRF，无法删除动态');
 const url=endpointUrl('/x/dynamic/feed/operate/remove?platform=web');url.searchParams.set('csrf',csrf);
 await send(url,cookie,signal,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dyn_id_str:id})});
}
module.exports={requestBili,verifyAccount,validDynamicId,removeDynamic};
