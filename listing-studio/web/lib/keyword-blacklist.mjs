import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const normaliseBlacklistTerm=term=>String(term).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export class KeywordBlacklist {
 constructor(root){this.file=path.join(root,'keyword-blacklist.json');this.terms=[];this.operation=Promise.resolve();}
 async init(){
  try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));if(data.version!==1||!Array.isArray(data.terms)||data.terms.some(t=>typeof t!=='string'))throw Error('流量词黑名单文件无效');this.terms=data.terms;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return this;
 }
 list(){return [...this.terms];}
 has(term){return this.terms.some(t=>normaliseBlacklistTerm(t)===normaliseBlacklistTerm(term));}
 filter(words=[]){return words.filter(w=>!this.has(w.term));}
 change(action,term){
  const operation=this.operation.catch(()=>{}).then(async()=>{
   if(!['add','remove'].includes(action)||typeof term!=='string'||!term.trim()||term.length>250||/[\x00-\x1f\x7f`]/.test(term))throw Object.assign(Error('黑名单操作或流量词无效'),{status:400});
   const key=normaliseBlacklistTerm(term),next=this.terms.filter(t=>normaliseBlacklistTerm(t)!==key);
   if(action==='add')next.push(term.trim());
   const temp=this.file+'.'+randomUUID()+'.tmp';
   await fs.writeFile(temp,JSON.stringify({version:1,terms:next},null,2),{mode:0o600});await fs.rename(temp,this.file);this.terms=next;return this.list();
  });this.operation=operation;return operation;
 }
}
