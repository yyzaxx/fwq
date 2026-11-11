import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateResult} from './domain.mjs';
import {realFile,renderResearchReport} from './reports.mjs';

// Removing titles must still pass every provenance and file check. Invalid research
// is never promoted merely because its title also failed validation.
export async function recoverTitleResult(store,task,raw,error,frozenSources=null,{reportRoot=store.directory(task.id)}={}){
 if(!raw||typeof raw!=='object')throw error;
 const result=validateResult(task.input,{...structuredClone(raw),titles:[],status:raw.status==='completed'?'partial':raw.status},frozenSources);
 if(!result.competitors.length&&!result.keywords.length)throw error;
 const root=store.directory(task.id);
 const originalReport=result.reportFile?await realFile(reportRoot,result.reportFile):null;
 for(const competitor of result.competitors)await realFile(root,competitor.imageFile);
 await realFile(root,task.imageFile||'preview.jpg');
 const id=randomUUID(),relative=`title-validation/${id}/report.md`,directory=path.join(root,'title-validation',id);
 const parent=path.join(root,'title-validation');
 await fs.mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
 const stat=await fs.lstat(parent),[parentReal,rootReal]=await Promise.all([fs.realpath(parent),fs.realpath(root)]);
 if(!stat.isDirectory()||stat.isSymbolicLink()||parentReal!==path.join(rootReal,'title-validation'))throw Error('标题恢复目录路径无效，原资料已保留');
 // The executor has exited; create a fresh leaf without following existing links.
 await fs.mkdir(directory,{mode:0o700});
 await fs.writeFile(path.join(directory,'research.json'),JSON.stringify(raw,null,2),{mode:0o600});
 if(originalReport)await fs.copyFile(originalReport,path.join(directory,'.rejected-report.md'));
 const reason=String(error.message||'标题校验未通过').slice(0,500);
 const markdown=renderResearchReport(task,result,relative,{status:'标题校验未通过，已保存竞品与流量词。'});
 await fs.writeFile(path.join(directory,'report.md'),markdown+'\n标题校验说明：'+reason.replace(/[<>\r\n]/g,' ')+'\n',{mode:0o600});
 result.reportFile=relative;
 result.message=`已保存${result.competitors.length}款竞品、${result.keywords.length}条流量词；标题校验未通过：${reason}。可使用已有资料重新生成标题。`;
 return {result,mode:'titles_only',titlesStale:true,titleValidationError:reason};
}
