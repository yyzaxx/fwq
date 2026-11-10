import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateInput} from './domain.mjs';
import {realFile} from './reports.mjs';

const busyStates=['staged','queued','running','cancelling','needs_login'];

export class TaskRestarter {
  constructor(store,runner){this.store=store;this.runner=runner;this.flights=new Map();}
  start(id){
    if(this.flights.has(id))return this.flights.get(id);
    const prepared=this.runner.queueOperation.catch(()=>{}).then(async()=>{
      const source=this.store.get(id);
      if(!source)throw Object.assign(Error('任务不存在或已删除'),{status:404});
      if(this.runner.active===id||this.runner.queue.includes(id)||busyStates.includes(source.state))throw Object.assign(Error('请先停止原任务，等待收尾后再重新开始'),{status:409});
      const existing=source.latestRestartId&&this.store.get(source.latestRestartId);
      if(existing&&busyStates.includes(existing.state))return existing;
      const input=validateInput(source.input),directory=this.store.directory(id);
      let image,preview;
      try{[image,preview]=await Promise.all([realFile(directory,source.imageFile),realFile(directory,source.previewFile)]);}
      catch{throw Error('原图或预览文件不可用，无法重新开始；请重新上传图片');}
      const nextId=randomUUID(),nextDirectory=this.store.directory(nextId),imageFile='design'+path.extname(source.imageFile);
      let created=false;
      try{
        await fs.mkdir(nextDirectory,{mode:0o700});
        await fs.copyFile(image,path.join(nextDirectory,imageFile));
        await fs.copyFile(preview,path.join(nextDirectory,'preview.jpg'));
        const next=await this.store.create(input,{id:nextId,name:source.name,imageFile,previewFile:'preview.jpg',state:'staged',mode:'full',restartedFrom:id});created=true;
        await this.store.patch(id,{latestRestartId:nextId});
        if(existing)await this.store.patch(existing.id,{latestRestartId:nextId});
        return next;
      }catch(error){
        if(created)await this.store.remove(nextId).catch(()=>{});
        else await fs.rm(nextDirectory,{recursive:true,force:true});
        throw error;
      }
    });
    this.runner.queueOperation=prepared;
    const result=prepared.then(async task=>{
      if(task.state==='staged')await this.runner.enqueue(task.id);
      if(this.runner.resourceError&&!this.runner.blockedForLogin)await this.runner.resumeLogin();
      return this.store.get(task.id);
    }).finally(()=>this.flights.delete(id));
    this.flights.set(id,result);return result;
  }
}
