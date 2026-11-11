import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateInput} from './domain.mjs';

const fault=(message,status=400)=>Object.assign(new Error(message),{status});
function normalise(raw){
  const name=String(raw.name||'').trim();
  if(!name||name.length>80||/[\u0000-\u001f]/.test(name))throw fault('请填写80字以内的模板名称');
  const category=String(raw.category||'').trim();
  const input=validateInput({...raw,category:category||'通用'});
  return {name,category,templateOne:input.templateOne,templateTwo:input.templateTwo,ranges:structuredClone(input.ranges)};
}
function sameName(a,b){return a.category===b.category&&a.name.toLocaleLowerCase()===b.name.toLocaleLowerCase();}
export class TemplateStore {
  constructor(file){this.file=file;this.items=[];this.pending=Promise.resolve();}
  async init(){
    await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(data))throw new Error('模板库格式错误');this.items=data;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    return this;
  }
  list(){return structuredClone(this.items).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));}
  mutate(change){
    const operation=this.pending.catch(()=>{}).then(async()=>{
      const items=structuredClone(this.items),result=change(items);
      const temporary=this.file+'.'+randomUUID()+'.tmp';
      await fs.writeFile(temporary,JSON.stringify(items,null,2),{mode:0o600});
      await fs.rename(temporary,this.file);this.items=items;
      return structuredClone(result);
    });this.pending=operation;return operation;
  }
  async create(raw){
    const value=normalise(raw);
    return this.mutate(items=>{
      if(items.some(x=>sameName(x,value)))throw fault('该类目已有同名模板，请选中后更新，或换一个名称',409);
      const now=new Date().toISOString(),item={id:randomUUID(),...value,createdAt:now,updatedAt:now};items.push(item);return item;
    });
  }
  async update(id,raw){
    const value=normalise(raw);
    return this.mutate(items=>{
      const index=items.findIndex(x=>x.id===id);if(index<0)throw fault('模板不存在，可能已被删除，请刷新',404);
      const previous=items[index];
      // A rename must not rewrite a legacy body's formatting.
      for(const key of ['templateOne','templateTwo'])if(raw[key]===previous[key])value[key]=previous[key];
      if(raw.expectedUpdatedAt&&raw.expectedUpdatedAt!==previous.updatedAt)throw fault('模板已在其他页面修改，请刷新后再保存',409);
      if(items.some(x=>x.id!==id&&sameName(x,value)))throw fault('该类目已有同名模板，请换一个名称',409);
      const updatedAt=new Date(Math.max(Date.now(),Date.parse(previous.updatedAt)+1)).toISOString();
      items[index]={...previous,...value,updatedAt};return items[index];
    });
  }
  remove(id){
    return this.mutate(items=>{const index=items.findIndex(x=>x.id===id);if(index<0)throw fault('模板不存在，可能已被删除',404);const [item]=items.splice(index,1);return item;});
  }
}
