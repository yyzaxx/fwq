import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class TaskStore {
  constructor(root){this.root=path.resolve(root);this.tasks=new Map();this.locks=new Map();}
  async init(){
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    for (const entry of await fs.readdir(this.root,{withFileTypes:true})) {
      if (!entry.isDirectory()||!/^[a-zA-Z0-9-]{5,80}$/.test(entry.name)) continue;
      try {const task=JSON.parse(await fs.readFile(path.join(this.root,entry.name,'task.json'),'utf8'));if(task.id===entry.name)this.tasks.set(task.id,task);}catch{}
    }
    return this;
  }
  directory(id){if(!/^[a-zA-Z0-9-]{5,80}$/.test(id))throw new Error('任务编号无效');return path.join(this.root,id);}
  get(id,{includeDeleted=false}={}){const task=this.tasks.get(id);return task&&(includeDeleted||!task.deletedAt)?structuredClone(task):null;}
  isDeleted(id){return !!this.tasks.get(id)?.deletedAt;}
  list({includeDeleted=false}={}){return [...this.tasks.values()].filter(task=>includeDeleted||!task.deletedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>structuredClone(x));}
  async write(task){
    const directory=this.directory(task.id);await fs.mkdir(directory,{recursive:true,mode:0o700});
    const temporary=path.join(directory,`.task-${randomUUID()}.tmp`);
    await fs.writeFile(temporary,JSON.stringify(task,null,2),{mode:0o600});await fs.rename(temporary,path.join(directory,'task.json'));
  }
  async create(input,extras={}){
    const task={id:extras.id||randomUUID(),input,state:'queued',stage:'queued',message:'等待开始',events:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...extras};
    if(this.tasks.has(task.id))throw new Error('任务已存在');
    this.tasks.set(task.id,task);await this.write(task);return structuredClone(task);
  }
  patch(id,patch,{includeDeleted=false}={}){
    const operation=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const current=this.tasks.get(id);if(!current||current.deletedAt&&!includeDeleted)throw Object.assign(new Error('任务不存在或已删除'),{status:404});
      const next={...current,...(typeof patch==='function'?patch(structuredClone(current)):patch),updatedAt:new Date().toISOString()};
      await this.write(next);this.tasks.set(id,next);return structuredClone(next);
    });
    this.locks.set(id,operation);return operation;
  }
  async remove(id){await this.patch(id,{deletedAt:new Date().toISOString()});return {id,deleted:true};}
}
