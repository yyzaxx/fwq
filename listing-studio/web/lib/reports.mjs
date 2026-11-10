import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWithin } from './domain.mjs';

export const escapeHtml=text=>String(text??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
export function renderMarkdown(markdown,assetUrl){
  function inline(raw){
    const tokens=[];
    let text=raw.replace(/(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g,(_,image,label,a,b)=>{
      const target=a||b;let url='';
      if (/^https?:\/\//i.test(target))url=target;
      else if (!/^[a-z]+:/i.test(target))url=assetUrl(target);
      const tag=image?`<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy">`:`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
      tokens.push(tag);return `\u0000${tokens.length-1}\u0000`;
    });
    text=escapeHtml(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
    return text.replace(/\u0000(\d+)\u0000/g,(_,index)=>tokens[Number(index)]);
  }
  const lines=markdown.split(/\r?\n/);const output=[];let code=null,list=false;
  const finishList=()=>{if(list){output.push('</ul>');list=false;}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.startsWith('```')){finishList();if(code===null)code=[];else{output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);code=null;}continue;}
    if(code!==null){code.push(line);continue;}
    if(/^\s*\|/.test(line)&&/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i+1]||'')){
      finishList();const cells=x=>x.trim().replace(/^\||\|$/g,'').split('|').map(x=>inline(x.trim()));
      output.push('<div class="table-scroll"><table><thead><tr>'+cells(line).map(x=>`<th>${x}</th>`).join('')+'</tr></thead><tbody>');i++;
      while(/^\s*\|/.test(lines[i+1]||''))output.push('<tr>'+cells(lines[++i]).map(x=>`<td>${x}</td>`).join('')+'</tr>');
      output.push('</tbody></table></div>');continue;
    }
    const heading=line.match(/^(#{1,6})\s+(.+)/);
    if(heading){finishList();output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);continue;}
    const item=line.match(/^(?:[-*]|\d+\.)\s+(.*)/);
    if(item){if(!list){output.push('<ul>');list=true;}output.push(`<li>${inline(item[1])}</li>`);continue;}
    finishList();if(line.trim())output.push(`<p>${inline(line)}</p>`);
  }
  finishList();if(code)output.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);return output.join('\n');
}
export async function realFile(root,relative){
  const candidate=resolveWithin(root,relative);
  const [resolved,realRoot]=await Promise.all([fs.realpath(candidate),fs.realpath(root)]);
  if(!resolved.startsWith(realRoot+path.sep))throw new Error('文件路径越界');
  if(!(await fs.stat(resolved)).isFile())throw new Error('不是可下载文件');
  return resolved;
}
export function isPublicArtifact(relative){
  const pieces=relative.split(/[\\/]/),name=pieces.at(-1).toLowerCase();
  if(pieces.some(p=>!p||p==='..'||p.startsWith('.')))return false;
  if(['task.json','input.json','progress.json','previous-progress.json','research.json','result.json'].includes(name)||name.startsWith('executor'))return false;
  return ['.jpg','.jpeg','.png','.webp','.json','.md'].includes(path.extname(name));
}
export async function publicFile(root,relative){
  if(!isPublicArtifact(relative))throw new Error('此文件不属于可公开的调研资料');
  const resolved=await realFile(root,relative);
  if(!isPublicArtifact(path.relative(root,resolved)))throw new Error('此文件不属于可公开的调研资料');
  return resolved;
}
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function zip(entries){
  const chunks=[],central=[];let offset=0;
  for(const [filename,data]of entries){
    const name=Buffer.from(filename);const crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    chunks.push(local,name,data);
    const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);header.writeUInt32LE(crc,16);header.writeUInt32LE(data.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE(offset,42);central.push(header,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directory,end]);
}
export async function packageReport(root,reportFile){
  const report=await realFile(root,reportFile);let markdown=await fs.readFile(report,'utf8');const entries=[],seen=new Set();
  const refs=[...markdown.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))\)/g)].map(x=>x[1]||x[2]);
  for(const reference of refs){
    if(/^https?:\/\//i.test(reference)||seen.has(reference))continue;seen.add(reference);
    try{
      const relative=path.isAbsolute(reference)?path.relative(root,reference):path.relative(root,path.resolve(path.dirname(report),reference));
      const file=await publicFile(root,relative);const name=relative.split(path.sep).join('/');
      const stat=await fs.stat(file);if(stat.size>30*1024*1024||entries.length>150)continue;
      entries.push([name,await fs.readFile(file)]);markdown=markdown.split(reference).join(name);
    }catch{}
  }
  entries.unshift(['report.md',Buffer.from(markdown)]);return zip(entries);
}
