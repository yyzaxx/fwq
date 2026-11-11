const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {verifyAccount,validDynamicId,requestBili,removeDynamic}=require('../src/bili-api.cjs');
test('账号核对要求配置、Cookie和站内登录者一致，数字动态ID保持字符串精度',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bili-api-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'env.js'),"module.exports={COOKIE:'DedeUserID=123; SESSDATA=fake; bili_jct=test;'}");
 const account=await verifyAccount(root,{uid:'123'},{request:async()=>({isLogin:true,mid:123})});assert.equal(account.uid,'123');assert.equal(account.signature.length,64);
 await assert.rejects(verifyAccount(root,{uid:'456'},{request:async()=>({isLogin:true,mid:123})}),/账号|UID|凭证/);await assert.rejects(verifyAccount(root,{uid:'123'},{request:async()=>({isLogin:true,mid:456})}),/账号|UID|核对/);
 assert.equal(validDynamicId('1267455947278647297'),true);for(const id of [1267455947278647297,'0','1e9','../123','00123'])assert.equal(validDynamicId(id),false);
});
test('站内接口请求仅允许固定官方主机，不将登录凭证发送到外站',async()=>{
 const fetch=global.fetch;let calls=0;global.fetch=async()=>{calls++;return {ok:true,json:async()=>({code:0,data:{ok:true}})}};
 try{assert.deepEqual(await requestBili('/x/web-interface/nav','test'),{ok:true});for(const url of ['https://example.com/','http://api.bilibili.com/','https://api.bilibili.com.evil.test/','//evil.test/','https://user:pass@api.bilibili.com/'])await assert.rejects(requestBili(url,'secret'),/地址|主机|接口/);assert.equal(calls,1);}finally{global.fetch=fetch;}
});
test('删除请求携带确切字符串ID与CSRF，异常响应不能当作成功',async()=>{
 const fetch=global.fetch;let request;global.fetch=async(url,options)=>{request={url,options};return {ok:true,json:async()=>({code:0})}};
 try{await removeDynamic('1267455947278647297','DedeUserID=123; SESSDATA=fake; bili_jct=csrf;',undefined);assert.equal(request.options.method,'POST');assert.deepEqual(JSON.parse(request.options.body),{dyn_id_str:'1267455947278647297'});assert.equal(new URL(request.url).searchParams.get('csrf'),'csrf');global.fetch=async()=>({ok:true,json:async()=>({code:-101})});await assert.rejects(removeDynamic('123','bili_jct=csrf;'),/登录|101/);}finally{global.fetch=fetch;}
});
