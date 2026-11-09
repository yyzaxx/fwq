const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const Module=require('node:module');
const target='/opt/bililottery/app/engine/LotteryAutoScript/lib/core/monitor.js';
function fixture(t,{partition=1,attention=0,relay=0}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-monitor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const history=path.join(dir,'dyid.txt');fs.writeFileSync(history,'');const effects=[];
 const config={partition_id:'partition',is_not_create_partition:false,check_if_duplicated:3,is_copy_chat:false,is_repost_then_chat:false,minfollower:0,wait:0,filter_wait:0};
 const bili={sendChatWithOcr:async()=>{effects.push('comment');return 0},autoAttention:async()=>{effects.push('follow');return attention},movePartition:async()=>{effects.push('group');return partition},autolike:async()=>{effects.push('like');return 0},autoRelay:async()=>{effects.push('repost');return relay}};
 const deps={
 '../utils':{log:{debug(){},info(){},warn(){},error(){}},hasEnv:()=>false,shuffle:x=>x,getRandomOne:x=>x,delay:async()=>{},try_for_each:async(xs,fn)=>{for(const x of xs)if(await fn(x))break},retryfn:async(_n,_codes,fn)=>fn()},
 '../net/http':{},'../net/bili':bili,'../helper/notify':{},'../helper/event_bus':{},'../helper/randomDynamic':{},'./searcher':{Searcher:class{}},'../data/global_var':{get:key=>key==='myUID'?'123':''},'../data/config':config,
 '../helper/d_storage':{updateDyid:id=>{fs.appendFileSync(history,id+',');return Promise.resolve()}}
 };
 const mod=new Module(target,module);mod.filename=target;mod.paths=Module._nodeModulePaths(path.dirname(target));mod.require=name=>{if(!Object.hasOwn(deps,name))throw Error('未隔离的依赖 '+name);return deps[name]};mod._compile(fs.readFileSync(target,'utf8'),target);
 const monitor=Object.create(mod.exports.Monitor.prototype);monitor.lottery_param=['APIs','file://fixture'];monitor.tagid='partition';const item={uid:['456'],dyid:'1267455947278647297',chat_type:17,rid:'12345',chat:'测试评论',relay_chat:'测试转发',ctrl:'[]',isOfficialLottery:false};monitor.filterLotteryInfo=async()=>[item];return {monitor,item,effects,history};
}
test('分组失败不会阻断点赞转发，成功后写入去重记录',async t=>{const f=fixture(t);assert.equal(await f.monitor.startLottery(),0);assert.deepEqual(f.effects,['comment','follow','group','like','repost']);assert.equal(fs.readFileSync(f.history,'utf8'),'1267455947278647297,')});
test('遗留3001错误保留失败状态且不会被写成已处理',async t=>{const f=fixture(t);f.monitor.go=async()=>3001;assert.equal(await f.monitor.startLottery(),3001);assert.equal(fs.readFileSync(f.history,'utf8'),'')});
test('关注失败仍停止，不会继续分组、点赞或转发',async t=>{const f=fixture(t,{attention:1});assert.equal(await f.monitor.startLottery(),2001);assert.deepEqual(f.effects,['comment','follow']);assert.equal(fs.readFileSync(f.history,'utf8'),'')});
test('分组成功的正常任务仍按原步骤执行',async t=>{const f=fixture(t,{partition:0});assert.equal(await f.monitor.startLottery(),0);assert.deepEqual(f.effects,['comment','follow','group','like','repost']);assert.equal(fs.readFileSync(f.history,'utf8'),'1267455947278647297,')});
