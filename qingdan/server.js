import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

class HttpError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const fail=(status,message)=>{throw new HttpError(status,message)};
const priorities=['high','normal','low'];
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
const validVersion=v=>Number.isSafeInteger(v)&&v>0;
const taskRow=r=>({...r,done:Boolean(r.done)});
function titleValue(title){
  if(typeof title!=='string'||!title.trim()||title.trim().length>200)fail(400,'任务内容需为 1 至 200 字');
  return title.trim();
}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'请求格式不正确');return value;}
function keys(value,allowed){if(Object.keys(value).some(k=>!allowed.includes(k)))fail(400,'包含不支持的字段');}
async function readBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'请使用 JSON 请求');
  const limit=2_000_000;
  if(Number(req.headers['content-length'])>limit){req.resume();fail(413,'请求数据过大');}
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size<=limit)chunks.push(chunk);}
  if(size>limit)fail(413,'请求数据过大');
  try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){if(e instanceof HttpError)throw e;fail(400,'JSON 格式不正确');}
}

export function createApp({dbPath=process.env.DB_PATH||'/var/lib/qingdan/tasks.sqlite',staticDir=join(dirname(fileURLToPath(import.meta.url)),'dist')}={}){
  mkdirSync(dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL, created INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS deleted_tasks (id TEXT PRIMARY KEY, deleted INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS create_requests (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, priority TEXT NOT NULL);`);
  const list=()=>db.prepare('SELECT * FROM tasks ORDER BY created,id').all().map(taskRow);
  const get=id=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const insert=db.prepare('INSERT INTO tasks(id,title,done,priority,created) VALUES(?,?,?,?,?)');
  const tombstone=db.prepare('INSERT OR IGNORE INTO deleted_tasks(id,deleted) VALUES(?,?)');
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}
  function matching(id,version){
    if(!validVersion(version))fail(400,'缺少有效的任务版本');
    const current=get(id);
    if(!current)fail(404,'任务已被其他设备删除，请刷新');
    if(current.version!==version)fail(409,'任务已被其他设备修改，请查看最新内容后重试');
    return current;
  }
  function remove(id){tombstone.run(id,Date.now());db.prepare('DELETE FROM tasks WHERE id=?').run(id);}
  const server=createServer(async(req,res)=>{
    const json=(status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url,'http://localhost');const path=decodeURIComponent(url.pathname);
      if(path.startsWith('/api/')){
        if(req.method!=='GET'){
          if(req.headers['sec-fetch-site']==='cross-site')fail(403,'不允许跨站修改清单');
          if(req.headers.origin){let originHost;try{originHost=new URL(req.headers.origin).host}catch{fail(403,'不允许跨站修改清单')}
            if(originHost!==req.headers.host)fail(403,'不允许跨站修改清单');}
        }
        if(path==='/api/health'&&req.method==='GET'){db.prepare('SELECT 1').get();return json(200,{ok:true});}
        if(path==='/api/tasks'&&req.method==='GET')return json(200,{tasks:list()});
        if(path==='/api/tasks'&&req.method==='POST'){
          const body=await readBody(req);keys(body,['title','priority','requestId']);
          const title=titleValue(body.title),priority=body.priority??'normal';
          if(!priorities.includes(priority))fail(400,'优先级不正确');
          if(Object.hasOwn(body,'requestId')&&!validId(body.requestId))fail(400,'新增请求标识不正确');
          const result=transaction(()=>{
            if(body.requestId){
              const previous=db.prepare('SELECT * FROM create_requests WHERE request_id=?').get(body.requestId);
              if(previous){
                if(previous.title!==title||previous.priority!==priority)fail(409,'新增请求标识已用于其他内容');
                const current=get(previous.task_id);
                if(!current)fail(409,'该次新增的任务已被删除，请重新添加');
                return {status:200,task:taskRow(current)};
              }
            }
            const id=randomUUID();insert.run(id,title,0,priority,Date.now());
            if(body.requestId)db.prepare('INSERT INTO create_requests(request_id,task_id,title,priority) VALUES(?,?,?,?)').run(body.requestId,id,title,priority);
            return {status:201,task:taskRow(get(id))};
          });
          return json(result.status,{task:result.task});
        }
        if(path==='/api/tasks/import'&&req.method==='POST'){
          const body=await readBody(req);keys(body,['tasks']);
          if(!Array.isArray(body.tasks)||body.tasks.length>10000)fail(400,'迁移任务数量不正确');
          const old=body.tasks.map(value=>{
            const t=object(value);if(!validId(t.id)||typeof t.done!=='boolean'||!priorities.includes(t.priority))fail(400,'旧任务格式不正确');
            return {id:t.id,title:titleValue(t.title),done:t.done,priority:t.priority,created:Number.isSafeInteger(t.created)&&t.created>=0?t.created:Date.now()};
          });
          transaction(()=>{for(const t of old){if(get(t.id)||db.prepare('SELECT id FROM deleted_tasks WHERE id=?').get(t.id))continue;insert.run(t.id,t.title,Number(t.done),t.priority,t.created);}});
          return json(200,{tasks:list()});
        }
        if(path==='/api/tasks/clear-completed'&&req.method==='POST'){
          const body=await readBody(req);keys(body,['tasks']);
          if(!Array.isArray(body.tasks)||body.tasks.length>10000)fail(400,'任务数量不正确');
          for(const t of body.tasks){object(t);if(!validId(t.id)||!validVersion(t.version))fail(400,'任务版本不正确');}
          transaction(()=>{for(const t of body.tasks){const row=matching(t.id,t.version);if(!row.done)fail(409,'部分任务已恢复待办，请刷新后重试');}for(const id of new Set(body.tasks.map(t=>t.id)))remove(id);});
          return json(200,{tasks:list()});
        }
        const match=path.match(/^\/api\/tasks\/([A-Za-z0-9_-]{1,128})$/);
        if(match&&req.method==='PATCH'){
          const body=await readBody(req);keys(body,['title','done','priority','version']);
          if(!['title','done','priority'].some(k=>Object.hasOwn(body,k)))fail(400,'没有需要修改的内容');
          if(Object.hasOwn(body,'done')&&typeof body.done!=='boolean')fail(400,'完成状态不正确');
          if(Object.hasOwn(body,'priority')&&!priorities.includes(body.priority))fail(400,'优先级不正确');
          const title=Object.hasOwn(body,'title')?titleValue(body.title):undefined;
          const task=transaction(()=>{const old=matching(match[1],body.version);db.prepare('UPDATE tasks SET title=?,done=?,priority=?,version=version+1 WHERE id=? AND version=?').run(title??old.title,body.done===undefined?old.done:Number(body.done),body.priority??old.priority,old.id,body.version);return taskRow(get(old.id));});
          return json(200,{task});
        }
        if(match&&req.method==='DELETE'){
          const version=Number(url.searchParams.get('version'));transaction(()=>{matching(match[1],version);remove(match[1]);});return json(200,{ok:true});
        }
        return json(404,{error:'接口不存在'});
      }
      if(!['GET','HEAD'].includes(req.method))return json(405,{error:'请求方式不支持'});
      if(path==='/favicon.ico'){res.writeHead(204);return res.end();}
      const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/tasks.js':'tasks.js','/style.css':'style.css'};
      if(!Object.hasOwn(assets,path))return json(404,{error:'页面不存在'});
      const file=assets[path],data=readFileSync(join(staticDir,file));
      const type=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
      res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    }catch(e){
      if(e instanceof HttpError)return json(e.status,{error:e.message});
      console.error('任务服务错误:',e.code||e.name,e.message);
      json(503,{error:req.method==='GET'?'服务器暂时无法读取，请稍后重试':'服务器保存失败，请稍后重试'});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,db};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const app=createApp();const port=Number(process.env.PORT||8767);
  app.server.listen(port,'127.0.0.1',()=>console.log('轻单服务已启动，端口 '+port));
  const shutdown=()=>{app.server.close(()=>{app.db.close();process.exit(0)});setTimeout(()=>process.exit(1),10000).unref()};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
