import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../../server.mjs';
import {TaskRunner} from '../../lib/runner.mjs';

const input={category:'挂画',templateOne:'{主体} Art',templateTwo:'{主体} Print',ranges:[[1,80],[1,80]]};
export const kw=term=>({term,seed:'B012345678',queryUrl:'https://www.sif.com/traffic?asin=B012345678',period:'2026-11 第1周 周搜索量',volume:100,volumeStatus:'已展示',sourcePosition:'第2行'});
export async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-keywords-'));
 const app=await createApp({dataRoot:root,basePath:'/qa/',importExisting:false,runnerEnabled:false});
 app.runner.resourceCheck=async()=>null; app.runner.resetBrowser=async()=>({closed:0});app.runner.recycleBrowser=async()=>({restarted:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{if(app.runner.active)await app.runner.cancel(app.runner.active);app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port+'/qa/api/';
 const task=await app.store.create(input,{id:'keyword-source',imageFile:'design.png',previewFile:'preview.jpg',state:'completed',stage:'done',mode:'full',result:{status:'completed',message:'原结果',keywords:[kw('frog wall art'),kw('funny frog decor'),kw('green frog painting')],competitors:[{asin:'B012345678',title:'Frog Wall Art Funny Green Painting',imageFile:'artifacts/comp.jpg',url:'https://www.amazon.com/dp/B012345678'}],titles:[{text:'Frog Art',slots:[{name:'主体',value:'Frog'}]},{text:'Frog Print',slots:[{name:'主体',value:'Frog'}]}],reportFile:'report.md'}});
 await fs.mkdir(path.join(app.store.directory(task.id),'artifacts'));
 for(const file of ['design.png','preview.jpg','artifacts/comp.jpg','report.md'])await fs.writeFile(path.join(app.store.directory(task.id),file),file==='report.md'?'original report frog wall art':'fixture');
 const request=(body,headers={})=>fetch(base+'tasks/'+task.id+'/keywords',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const resume=body=>fetch(base+'tasks/'+task.id+'/resume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 return {...app,root,task,request,resume,base};
}
