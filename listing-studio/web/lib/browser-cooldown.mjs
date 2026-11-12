import fs from 'node:fs/promises';
import path from 'node:path';
import {writeArtifact} from './artifacts.mjs';

export const AMAZON_COOLDOWN_MS=30*60*1000;
export function isAmazonVerification(result){
 if(result?.status!=='needs_login')return false;
 if(result.browserBlock)return result.browserBlock.site==='amazon'&&result.browserBlock.kind==='human_verification';
 return String(result.message||'').split(/[。；;\n]/).some(clause=>/(?:Amazon|亚马逊)/i.test(clause)&&!/\bSif\b/i.test(clause)&&!/(?:不是|并非|没有|未出现).{0,3}(?:人机验证|验证码|CAPTCHA)/i.test(clause)&&/(?:人机验证|验证码|CAPTCHA|I am human|unusual browser activity)/i.test(clause));
}
export async function readCooldown(root){
 let text;try{text=await fs.readFile(path.join(root,'browser-cooldown.json'),'utf8')}catch(error){if(error.code==='ENOENT')return null;throw error}
 const data=JSON.parse(text);if(data.version===1&&data.active===null)return null;
 const r=data.active;
 if(data.version!==1||!r||r.site!=='amazon'||r.kind!=='human_verification'||!/^[a-zA-Z0-9-]{5,80}$/.test(r.taskId)||!Number.isFinite(Date.parse(r.startedAt))||!Number.isFinite(Date.parse(r.until))||Date.parse(r.until)<Date.parse(r.startedAt)||(r.closedAt!==null&&!Number.isFinite(Date.parse(r.closedAt))))throw Error('浏览器等待记录无效');
 return r;
}
export const saveCooldown=(root,record)=>writeArtifact(root,'browser-cooldown.json',JSON.stringify({version:1,active:record},null,2));
