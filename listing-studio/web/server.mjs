import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore } from './lib/store.mjs';
import { TemplateStore } from './lib/templates.mjs';
import { TaskRunner } from './lib/runner.mjs';
import { TaskRestarter } from './lib/restart.mjs';
import {KeywordManager} from './lib/keywords.mjs';
import { BatchManager,prepareArchive } from './lib/batches.mjs';
import { importHistory } from './lib/import-history.mjs';
import { validateInput,detectImage } from './lib/domain.mjs';
import { realFile,publicFile,renderMarkdown,escapeHtml,packageReport } from './lib/reports.mjs';
import {enforceBrowserPageLimit} from './lib/browser-cleanup.mjs';

const runFile=promisify(execFile),ROOT=path.dirname(fileURLToPath(import.meta.url));
const mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.json':'application/json','.md':'text/markdown; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.html':'text/html; charset=utf-8'};
const BROWSER='http://127.0.0.1:9223';
function reply(res,status,body,type='application/json; charset=utf-8',headers={}){res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin',...headers});res.end(Buffer.isBuffer(body)?body:type.startsWith('application/json')?JSON.stringify(body):body);}
async function readBody(req,maxBytes=64*1024){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Object.assign(new Error('请求格式应为JSON'),{status:415});
  if(Number(req.headers['content-length'])>maxBytes)throw Object.assign(new Error('请求内容过大'),{status:413});
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>maxBytes)throw Object.assign(new Error('请求内容过大'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Error('请求内容不是有效JSON');}
}
function publicTask(task){
  const {events,...rest}=task;return {...rest,events:events.slice(-20),counts:{competitors:task.result?.competitors?.length||0,keywords:task.result?.keywords?.length||0,titles:task.result?.titles?.length||0}};
}
export async function createApp({dataRoot=path.join(ROOT,'data','jobs'),basePath='/listing-app/',importExisting=true,runnerEnabled=true,browserUrl=BROWSER,browserWatchdogEnabled=runnerEnabled}={}){
  if(!basePath.startsWith('/')||!basePath.endsWith('/'))throw new Error('basePath 必须以斜线起止');
  const store=await new TaskStore(dataRoot).init();
  const templates=await new TemplateStore(path.join(dataRoot,'templates.json')).init();
  if(importExisting)await importHistory(store,path.dirname(ROOT));
  const runner=new TaskRunner(store,{browserUrl,enabled:false});
  const restarter=new TaskRestarter(store,runner);
  const keywordManager=new KeywordManager(store,runner);
  const batches=await new TaskStore(path.join(dataRoot,'_batches')).init();
  const batchManager=new BatchManager(store,batches,runner);
  await runner.restore();await batchManager.restore();runner.enabled=runnerEnabled;if(runnerEnabled)void runner.drain();
  let archiveUploads=0,imageUploads=0,reportDownloads=0,activeRequests=0;
  let healthCache=null,healthTime=0;
  async function health(){
    if(healthCache&&Date.now()-healthTime<15000)return healthCache;
    const [browser,executor]=await Promise.all([
      fetch(browserUrl+'/json/version',{signal:AbortSignal.timeout(2000)}).then(r=>r.ok).catch(()=>false),
      runFile('codex',['login','status'],{timeout:5000}).then(()=>true).catch(()=>false)
    ]);
    healthTime=Date.now();return healthCache={browserConnected:browser,executorReady:executor,site:'美国站',browserUrl:'/listing-browser/vnc.html?autoconnect=1&resize=scale&path=listing-browser%2Fwebsockify'};
  }
  const server=http.createServer({requestTimeout:120000,headersTimeout:15000,connectionsCheckingInterval:1000},async(req,res)=>{
    if(activeRequests>=16)return reply(res,429,{error:'当前请求较多，请稍后重试'},undefined,{'retry-after':'1','connection':'close'});
    activeRequests++;
    let released=false;const release=()=>{if(!released){released=true;activeRequests--;}};
    res.once('finish',release);res.once('close',release);
    try{
      const url=new URL(req.url,'http://localhost');
      if(!url.pathname.startsWith(basePath))return reply(res,404,{error:'页面不存在'});
      const route=url.pathname.slice(basePath.length);
      if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.headers.origin){
        let same=false;try{same=new URL(req.headers.origin).host===req.headers.host;}catch{}
        if(!same)return reply(res,403,{error:'请从本站提交任务'});
      }
      if(req.method==='GET'&&route==='api/bootstrap')return reply(res,200,{tasks:store.list().map(publicTask),batches:batchManager.list(),queue:runner.info(),templates:templates.list(),health:await health()});
      if(req.method==='GET'&&route==='api/queue')return reply(res,200,runner.info());
      if(req.method==='POST'&&route==='api/queue/resume-all'){await readBody(req);return reply(res,200,await runner.resumeAll());}
      if(req.method==='POST'&&route==='api/queue/resume'){await readBody(req);await runner.resumeLogin();return reply(res,200,runner.info());}
      if(req.method==='GET'&&route==='api/batches')return reply(res,200,batchManager.list());
      if(req.method==='POST'&&route==='api/batches/preview'){
        if(archiveUploads||imageUploads)return reply(res,429,{error:'正在处理其他图片或压缩包，请稍后上传'});
        if(!String(req.headers['content-type']||'').startsWith('application/zip'))return reply(res,415,{error:'请上传ZIP压缩包'});
        const id=randomUUID(),directory=batches.directory(id);archiveUploads++;
        try{
          await fs.mkdir(directory,{recursive:true,mode:0o700});
          const archive=path.join(directory,'upload.zip'),handle=await fs.open(archive,'wx',0o600);let size=0;
          try{for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024)throw Object.assign(new Error('ZIP文件不能超过100MB'),{status:413});await handle.writeFile(chunk);}}finally{await handle.close();}
          const prepared=await prepareArchive(archive,directory);await fs.rm(archive,{force:true});
          const name=decodeURIComponent(String(req.headers['x-file-name']||'商品图片.zip')).replace(/[\/\x00-\x1f]/g,'').slice(0,160);
          const batch=await batches.create(null,{id,name,state:'draft',files:prepared.files,skipped:prepared.skipped,taskIds:[]});
          return reply(res,201,batchManager.view(batch));
        }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}finally{archiveUploads--;}
      }
      const batchRoute=route.match(/^api\/batches\/([a-zA-Z0-9-]{5,80})(?:\/(start|cancel|preview)(?:\/([0-9]{3}))?)?$/);
      if(batchRoute){
        const [,id,action,fileId]=batchRoute,batch=batches.get(id);if(!batch)return reply(res,404,{error:'批次不存在'});
        if(req.method==='GET'&&!action)return reply(res,200,batchManager.view(batch));
        if(req.method==='DELETE'&&!action){await readBody(req);return reply(res,200,await batchManager.remove(id));}
        if(req.method==='GET'&&action==='preview'){
          const index=batch.files.findIndex(x=>x.id===fileId),file=batch.files[index];if(!file||batch.taskIds?.[index]&&store.isDeleted(batch.taskIds[index]))return reply(res,404,{error:'图片不存在'});
          return reply(res,200,await fs.readFile(await realFile(batches.directory(id),file.previewFile)),'image/jpeg');
        }
        if(req.method==='POST'&&action==='start')return reply(res,200,await batchManager.start(id,await readBody(req)));
        if(req.method==='POST'&&action==='cancel'){await readBody(req);return reply(res,200,await batchManager.cancel(id));}
      }
      if(req.method==='GET'&&route==='api/templates')return reply(res,200,templates.list());
      if(req.method==='POST'&&route==='api/templates')return reply(res,201,await templates.create(await readBody(req)));
      const templateRoute=route.match(/^api\/templates\/([a-zA-Z0-9-]{5,80})$/);
      if(templateRoute&&req.method==='PUT')return reply(res,200,await templates.update(templateRoute[1],await readBody(req)));
      if(templateRoute&&req.method==='DELETE'){await readBody(req);await templates.remove(templateRoute[1]);return reply(res,200,{deleted:true});}
      if(req.method==='GET'&&route==='api/tasks')return reply(res,200,store.list().map(publicTask));
      if(req.method==='POST'&&route==='api/tasks'){
        if(imageUploads||archiveUploads)return reply(res,429,{error:'正在处理其他图片或压缩包，请稍后上传'});
        imageUploads++;
        try{
        const body=await readBody(req,23*1024*1024),input=validateInput(body);
        if(typeof body.imageData!=='string')throw new Error('请上传商品参考图');
        const data=body.imageData.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
        if(!data)throw new Error('图片格式无效，请重新选择图片');
        const buffer=Buffer.from(data[1],'base64'),format=detectImage(buffer),id=randomUUID(),directory=store.directory(id),imageFile='design.'+format.ext;
        if(buffer.length>15*1024*1024)throw Object.assign(new Error('单张图片不能超过15MB'),{status:413});
        await fs.mkdir(directory,{recursive:true,mode:0o700});
        try{
          await fs.writeFile(path.join(directory,imageFile),buffer);
          await runFile('convert',['-limit','memory','64MiB','-limit','map','128MiB',path.join(directory,imageFile)+'[0]','-auto-orient','-resize','1200x1200>',path.join(directory,'preview.jpg')],{timeout:20000});
        }catch{await fs.rm(directory,{recursive:true,force:true});throw new Error('图片无法解码，请换一张有效图片');}
        const name=String(body.imageName||input.category+'商品调研').replace(/[\\/\x00-\x1f]/g,'').slice(0,80);
        const task=await store.create(input,{id,name,imageFile,previewFile:'preview.jpg',mode:'full'});await runner.enqueue(task.id);
        return reply(res,201,publicTask(store.get(task.id)));
        }finally{imageUploads--;}
      }
      const match=route.match(/^api\/tasks\/([a-zA-Z0-9-]{5,80})(?:\/(resume|restart|keywords|cancel|file|report|report\.md|download))?$/);
      if(match){
        const [,id,action]=match,task=store.get(id);if(!task)return reply(res,404,{error:'任务不存在'});
        const directory=store.directory(id);
        if(req.method==='GET'&&!action)return reply(res,200,publicTask(task));
        if(req.method==='POST'&&action==='keywords')return reply(res,200,publicTask(await keywordManager.change(id,await readBody(req))));
        if(req.method==='POST'&&action==='restart'){await readBody(req);return reply(res,200,publicTask(await restarter.start(id)));}
        if(req.method==='DELETE'&&!action){await readBody(req);return reply(res,200,await batchManager.removeTask(id));}
        if(req.method==='POST'&&action==='cancel'){await readBody(req);await runner.cancel(id);return reply(res,200,publicTask(store.get(id)));}
        if(req.method==='POST'&&action==='resume')return reply(res,200,publicTask(await runner.resumeTask(id,await readBody(req))));
        if(req.method==='GET'&&action==='file'){
          const relative=url.searchParams.get('path')||'';
          let filename;try{filename=await publicFile(directory,relative);}catch{return reply(res,404,{error:'文件不存在或不可公开'});}
          return reply(res,200,await fs.readFile(filename),mime[path.extname(filename).toLowerCase()]||'application/octet-stream');
        }
        if(req.method==='GET'&&['report','report.md','download'].includes(action)){
          if(!task.result?.reportFile)return reply(res,404,{error:'当前尚未生成报告'});
          const filename=await realFile(directory,task.result.reportFile);
          if(action==='download'){
            if(reportDownloads)return reply(res,429,{error:'正在打包其他报告，请稍后下载'});
            reportDownloads++;let done=false;const release=()=>{if(!done){done=true;reportDownloads--;}};res.once('finish',release);res.once('close',release);
            return reply(res,200,await packageReport(directory,task.result.reportFile),'application/zip',{'content-disposition':`attachment; filename=listing-report-${id.slice(0,8)}.zip`});
          }
          const md=await fs.readFile(filename,'utf8');
          if(action==='report.md')return reply(res,200,md,'text/markdown; charset=utf-8',{'content-disposition':'attachment; filename=report.md'});
          const content=renderMarkdown(md,target=>{
            const relative=path.isAbsolute(target)?path.relative(directory,target):path.relative(directory,path.resolve(path.dirname(filename),target));
            if(relative.startsWith('..'))return '';
            return basePath+`api/tasks/${id}/file?path=`+encodeURIComponent(relative);
          });
          const html=`<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>${escapeHtml(task.name)} · 联合报告</title><style>body{font:15px/1.8 system-ui,sans-serif;color:#243b37;max-width:1050px;margin:40px auto;padding:0 24px 80px}h1{font-size:28px}h2{margin-top:42px;border-bottom:1px solid #dce5df;padding-bottom:10px}h3{margin-top:32px}a{color:#267663}img{max-width:100%;max-height:620px;display:block;margin:24px auto;border:1px solid #e7ebe8;border-radius:10px}pre{background:#f1f5f3;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px}code{font-size:13px}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #dde5df;padding:10px 12px;text-align:left;min-width:80px}th{background:#f1f5f3}li{margin:6px 0}</style><body>${content}</body></html>`;
          return reply(res,200,html,'text/html; charset=utf-8',{'content-security-policy':"default-src 'none'; img-src 'self' https:; style-src 'unsafe-inline'; frame-ancestors 'self'"});
        }
      }
      if(req.method==='GET'&&['','index.html','app.js','template-form.js','styles.css','favicon.svg'].includes(route)){
        const file=path.join(ROOT,'public',route||'index.html');return reply(res,200,await fs.readFile(file),mime[path.extname(file)]);
      }
      return reply(res,404,{error:'页面不存在'});
    }catch(error){if(!res.headersSent)reply(res,error.status||400,{error:error.message||'请求未完成'});else res.end();}
  });
  if(browserWatchdogEnabled){
    let timer,busy=false;
    const check=async()=>{if(busy)return;busy=true;try{await enforceBrowserPageLimit(browserUrl);}catch{}finally{busy=false;}};
    server.once('listening',()=>{void check();timer=setInterval(()=>void check(),1000);timer.unref();});
    server.once('close',()=>clearInterval(timer));
  }
  server.once('close',()=>runner.dispose());
  return {server,store,runner,batches,batchManager,basePath};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const runtimeFile=path.join(ROOT,'.runtime.json');let config;
  try{config=JSON.parse(await fs.readFile(runtimeFile,'utf8'));}catch{config={basePath:'/listing-app/'+randomBytes(16).toString('hex')+'/'};await fs.writeFile(runtimeFile,JSON.stringify(config),{mode:0o600});}
  const app=await createApp({basePath:process.env.APP_BASE_PATH||config.basePath});
  app.server.listen(Number(process.env.PORT||7350),'127.0.0.1',()=>console.log('Listing Studio 已启动于本机7350端口'));
}
