import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateResult,keywordKey,tokenise} from './domain.mjs';
import {realFile,renderResearchReport} from './reports.mjs';
import {safeDirectory,freezeArtifact} from './artifacts.mjs';

export {keywordKey};
export function distinctKeywords(raw,excluded=[]){
 if(!raw||!Array.isArray(raw.keywords))return raw;
 const seen=new Set(excluded.map(keywordKey));
 return {...raw,keywords:raw.keywords.filter(word=>{if(typeof word?.term!=='string')return true;const key=keywordKey(word.term);if(!key||!tokenise(word.term).length||seen.has(key))return false;seen.add(key);return true;})};
}
export const shortKeywords=result=>result?.competitors?.length>=5&&result?.keywords?.length<15;
export const collectingKeywords=task=>task.mode==='full'&&shortKeywords(task.result);

export async function mergeCollectedResult(task,raw,root,directory){
 const incoming=validateResult(task.input,{...distinctKeywords(structuredClone(raw),task.excludedKeywords),titles:[]});
 const archive=`collection-assets/${randomUUID()}`;
 const competitors=structuredClone(task.result.competitors),asins=new Set(competitors.map(c=>c.asin));
 for(const c of incoming.competitors){if(asins.has(c.asin))continue;const imageFile=await freezeArtifact(directory,c.imageFile,root,archive);competitors.push({...c,imageFile});asins.add(c.asin);}
 const excluded=new Set((task.excludedKeywords||[]).map(keywordKey)),seen=new Set(),keywords=[];
 for(const [old,words] of [[true,task.result.keywords],[false,incoming.keywords]])for(const word of words){
  const key=keywordKey(word.term);if(seen.has(key)||excluded.has(key))continue;
  const copy=structuredClone(word);if(!old&&copy.evidenceFile){copy.evidenceFile=await freezeArtifact(directory,copy.evidenceFile,root,archive);}
  seen.add(key);keywords.push(copy);
 }
 const titles=task.result.titles?.length===2?structuredClone(task.result.titles):raw.titles;
 return {...raw,competitors,keywords:keywords.slice(0,15),titles};
}

export async function finishKeywordCollection(store,task,result){
 if(result.competitors.length<5||!shortKeywords(result)&&!collectingKeywords(task))return null;
 const previous=task.result||{keywords:[],competitors:[]};
 const beforeWords=new Set(previous.keywords.map(w=>keywordKey(w.term))),beforeAsins=new Set(previous.competitors.map(c=>c.asin));
 const progress=result.keywords.some(w=>!beforeWords.has(keywordKey(w.term)))||result.competitors.some(c=>!beforeAsins.has(c.asin));
 const rounds=(task.keywordCollection?.rounds||0)+1,stalled=progress?0:(task.keywordCollection?.stalledRounds||0)+1;
 const complete=result.keywords.length>=15,blocked=['needs_login','needs_input'].includes(result.status);
 const state=blocked?result.status:complete?(result.titles.length===2?'completed':'partial'):stalled>=2?'needs_input':'queued';
 const message=blocked?String(result.message||'补采暂停，已有资料保留'):complete?(result.titles.length===2?'已补齐15条真实流量词，竞品、标题及报告已核验':'已补齐15条真实流量词，标题待生成'):state==='queued'?`已核实${result.keywords.length}/15条流量词，继续寻找新竞品ASIN反查补齐`:`仍缺${15-result.keywords.length}条流量词；连续两轮未取得新增词或新增竞品，任务未达标，资料已保留，可检查来源限制后继续补采`;
 const relative=`collection-reports/${randomUUID()}/report.md`,directory=await safeDirectory(store.directory(task.id),path.dirname(relative));
 const next={...result,status:state==='queued'?'partial':state,message,reportFile:relative};
 let markdown=renderResearchReport(task,next,relative,{status:message});
 markdown=markdown.replace('请使用当前词库重新生成两条标题。',!complete?'继续新增相似竞品ASIN反查，补齐15条有效原词后才完成。':next.titles.length===2?'两条标题已通过当前词库校验。':'请使用当前词库生成两条标题。');
 if(next.titles.length===2)markdown+=next.titles.map((t,i)=>`\n## 标题${i?'二':'一'}\n\n\u0060\u0060\u0060text\n${t.text}\n\u0060\u0060\u0060\n`).join('');
 await fs.writeFile(path.join(directory,'report.md'),markdown,{mode:0o600});
 return {result:next,state,stage:state==='queued'?'queued':complete?'done':'sif',mode:complete?'titles_only':'full',message,keywordCollection:{runId:task.keywordCollection?.runId||randomUUID(),target:15,status:complete?'completed':'pending',rounds,stalledRounds:stalled,keywords:next.keywords.length,asins:next.competitors.map(c=>c.asin)}};
}
