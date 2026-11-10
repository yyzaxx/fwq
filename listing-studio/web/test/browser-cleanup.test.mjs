import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {resetBrowserPages,enforceBrowserPageLimit} from '../lib/browser-cleanup.mjs';

async function browser(t,{newFails=false,closeFails=false,blank=false,closeDelayMs=0,pageCount=2}={}){
 let pages=[{id:'amazon',type:'page',url:'https://amazon.test/'},{id:'sif',type:'page',url:'https://sif.test/'}].slice(0,pageCount);pages.push({id:'worker',type:'service_worker',url:'https://sif.test/sw.js'});if(blank)pages.push({id:'existing-blank',type:'page',url:'about:blank'});
 while(pages.filter(p=>p.type==='page').length<pageCount)pages.push({id:'extra-'+pages.length,type:'page',url:'https://example.test/extra'});
 let peak=pages.filter(p=>p.type==='page').length;
 const calls=[],server=http.createServer((req,res)=>{calls.push({method:req.method,url:req.url});res.setHeader('content-type','application/json');
 if(req.url==='/json/list')return res.end(JSON.stringify(pages));
 if(req.url==='/json/new?about:blank'&&req.method==='PUT'){if(newFails){res.statusCode=500;return res.end('{}')}const target={id:'new-blank',type:'page',url:'about:blank'};pages.push(target);peak=Math.max(peak,pages.filter(p=>p.type==='page').length);return res.end(JSON.stringify(target))}
 if(req.url.startsWith('/json/close/')){if(closeFails){res.statusCode=500;return res.end('{}')}const id=req.url.split('/').at(-1);const close=()=>{pages=pages.filter(p=>p.id!==id)};if(closeDelayMs)setTimeout(close,closeDelayMs);else close();return res.end('{}')}
 res.statusCode=400;res.end('{"error":"unexpected API"}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return {url:'http://127.0.0.1:'+server.address().port,calls,pages:()=>pages,peak:()=>peak};
}
test('关闭任务页面，只保留空白页，不调用Cookie或存储清理接口',async t=>{const b=await browser(t);const result=await resetBrowserPages(b.url);assert.equal(result.closed,2);assert.deepEqual(b.pages().filter(p=>p.type==='page').map(p=>p.url),['about:blank']);assert.equal(b.pages().some(p=>p.id==='worker'),true);assert.ok(b.calls.every(c=>c.url==='/json/list'||c.url==='/json/new?about:blank'||c.url.startsWith('/json/close/')))});
test('已有空白页直接复用',async t=>{const b=await browser(t,{blank:true});await resetBrowserPages(b.url);assert.deepEqual(b.pages().filter(p=>p.type==='page').map(p=>p.id),['existing-blank']);assert.equal(b.calls.some(c=>c.url.startsWith('/json/new')),false)});
test('未达上限但无法创建空白页时保留所有原页面',async t=>{const b=await browser(t,{newFails:true,pageCount:1});await assert.rejects(resetBrowserPages(b.url),/浏览器|空白|HTTP/);assert.equal(b.pages().filter(p=>p.type==='page').length,1);assert.equal(b.calls.some(c=>c.url.startsWith('/json/close')),false)});
test('关闭失败不能声称清理成功',async t=>{const b=await browser(t,{closeFails:true});await assert.rejects(resetBrowserPages(b.url),/浏览器|HTTP|清理/);assert.equal(b.pages().filter(p=>p.url==='https://amazon.test/').length,1)});
test('Chrome先确认关闭、页面稍后消失时等待实际回收完成',async t=>{const b=await browser(t,{closeDelayMs:80});const result=await resetBrowserPages(b.url);assert.equal(result.closed,2);assert.deepEqual(b.pages().filter(p=>p.type==='page').map(p=>p.url),['about:blank'])});
test('已有两个页面时收尾与后台限额检查互不干扰，过程也不创建第三页',async t=>{
 const b=await browser(t,{pageCount:2,closeDelayMs:80}),pending=[];
 const timer=setInterval(()=>pending.push(enforceBrowserPageLimit(b.url).catch(()=>{})),20);
 try{await resetBrowserPages(b.url);}finally{clearInterval(timer);await Promise.all(pending);}
 assert.deepEqual(b.pages().filter(p=>p.type==='page').map(p=>p.url),['about:blank']);assert.equal(b.peak(),2);
});
