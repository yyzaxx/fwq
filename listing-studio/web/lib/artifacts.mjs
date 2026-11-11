import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveWithin} from './domain.mjs';

export async function safeDirectory(root,relative){
 const target=relative?resolveWithin(root,relative):root,realRoot=await fs.realpath(root);
 let current=root,expected=realRoot;
 for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){
  current=path.join(current,part);expected=path.join(expected,part);
  await fs.mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const stat=await fs.lstat(current);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(current)!==expected)throw Error('任务资料目录路径无效，已有资料保留');
 }
 return target;
}
export async function copyArtifact(source,root,relative){
 const target=resolveWithin(root,relative);await safeDirectory(root,path.relative(root,path.dirname(target)));
 const temporary=path.join(path.dirname(target),'.copy-'+randomUUID());
 try{await fs.copyFile(source,temporary,fs.constants.COPYFILE_EXCL);await fs.rename(temporary,target);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
export async function writeArtifact(root,relative,data){
 const target=resolveWithin(root,relative);await safeDirectory(root,path.relative(root,path.dirname(target)));
 const temporary=path.join(path.dirname(target),'.write-'+randomUUID());
 try{await fs.writeFile(temporary,data,{mode:0o600,flag:'wx'});await fs.rename(temporary,target);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
export async function appendArtifact(root,relative,data){
 const target=resolveWithin(root,relative),handle=await fs.open(target,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(data);}finally{await handle.close();}
}
export async function freezeArtifact(sourceRoot,relative,taskRoot,archive){
 const {realFile}=await import('./reports.mjs');const source=await realFile(sourceRoot,relative),destination=archive+'/'+relative;
 await copyArtifact(source,taskRoot,destination);return destination;
}
