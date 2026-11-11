import path from 'node:path';

export const normaliseTemplate=value=>String(value??'').replace(/\r\n?/g,'\n').replace(/^\n+|\n+$/g,'').replace(/\n/g,' ');
export const keywordKey=term=>String(term).normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export const tokenise = text => String(text).match(/[\p{L}\p{N}]+/gu) || [];
export function templateParts(template) {
  const matches=[...template.matchAll(/\{([^{}]+)\}/g)];
  if (!matches.length || /[{}]/.test(template.replace(/\{[^{}]+\}/g,''))) throw new Error('模板请用 {主体}、{风格} 等标记占位内容');
  return matches;
}
export function validateInput(raw) {
  const category=String(raw.category||'').trim();
  if (!category || category.length>80) throw new Error('请填写有效的商品类目');
  const ranges=raw.ranges || [[65,75],[115,125]];
  if (!Array.isArray(ranges)||ranges.length!==2) throw new Error('请设置两条标题的字符范围');
  const output={category,templateOne:normaliseTemplate(raw.templateOne),templateTwo:normaliseTemplate(raw.templateTwo),ranges};
  for (const [i,key] of ['templateOne','templateTwo'].entries()) {
    const template=output[key];
    if (!template.trim() || template.length>1500) throw new Error(`请填写标题${i===0?'一':'二'}模板`);
    const parts=templateParts(template);
    if (parts.length>8) throw new Error('每套模板最多支持8处占位');
    const range=ranges[i];
    if (!Array.isArray(range)||range.length!==2||range.some(x=>!Number.isInteger(x)||x<1||x>500)||range[0]>range[1]) throw new Error('字符范围须为1到500的整数，且下限不超过上限');
    if (template.replace(/\{[^{}]+\}/g,'').length>range[1]) throw new Error(`标题${i+1}的固定文字已超过字符上限，请调整模板或范围`);
  }
  return output;
}
export function detectImage(buffer) {
  if (buffer.length>15*1024*1024) throw new Error('图片不能超过15MB');
  if (buffer.length>=3 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return {ext:'jpg',mime:'image/jpeg'};
  if (buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return {ext:'png',mime:'image/png'};
  if (buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP') return {ext:'webp',mime:'image/webp'};
  throw new Error('图片格式无效，请上传 JPG、PNG 或 WebP 图片');
}
export function renderTemplate(template,slots) {
  template=normaliseTemplate(template);
  const parts=templateParts(template);
  if (!Array.isArray(slots)||slots.length!==parts.length) throw new Error('标题模板占位数量不一致');
  let index=0;
  return template.replace(/\{([^{}]+)\}/g,(_,name)=>{
    const slot=slots[index++];
    if (slot.name!==name || typeof slot.value!=='string'||!slot.value.trim()||/[\r\n]/.test(slot.value)) throw new Error('标题模板占位名称或内容不正确');
    return slot.value;
  });
}
export function auditTitles(input,titles,sources) {
  if (!Array.isArray(titles)||titles.length!==2) throw new Error('需要两条可校验的最终标题');
  const bank=new Map();
  for (const keyword of sources.keywords||[]) for (const word of tokenise(keyword.term)) if (!bank.has(word.toLowerCase())) bank.set(word.toLowerCase(),{type:'sif',source:keyword.term});
  for (const competitor of sources.competitors||[]) for (const word of tokenise(competitor.title)) if (!bank.has(word.toLowerCase())) bank.set(word.toLowerCase(),{type:'competitor',source:competitor.asin});
  return titles.map((title,index)=>{
    const template=normaliseTemplate(index===0?input.templateOne:input.templateTwo);
    const rendered=renderTemplate(template,title.slots);
    if (typeof title.text!=='string'||rendered!==normaliseTemplate(title.text)) throw new Error(`标题${index+1}改动了模板固定文字或标点`);
    const words=title.slots.flatMap(slot=>tokenise(slot.value));
    const fixed=tokenise(template.replace(/\{[^{}]+\}/g,'')).map(x=>x.toLowerCase());
    const wordSources=words.map(word=>{
      if (['framed','unframed'].includes(word.toLowerCase())&&!fixed.includes(word.toLowerCase())) throw new Error(`${word} 涉及未确认装框属性，请确认模板固定参数`);
      const source=bank.get(word.toLowerCase());
      if (!source) throw new Error(`${word} 没有当次合格词源`);
      return {word,...source};
    });
    const length=Array.from(rendered).length;
    const [min,max]=input.ranges[index];
    if (length<min||length>max) throw new Error(`标题${index+1}为${length}字符，未达到${min}–${max}字符范围`);
    return {...title,text:rendered,length,min,max,wordSources,verified:true};
  });
}
export function resolveWithin(root,relative) {
  if (typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\0')) throw new Error('文件路径无效');
  const candidate=path.resolve(root,relative);
  if (!candidate.startsWith(path.resolve(root)+path.sep)) throw new Error('文件路径越界');
  return candidate;
}
export function validateResult(input,result,frozenSources=null) {
  if (!result||!Array.isArray(result.keywords)||!Array.isArray(result.competitors)) throw new Error('结果缺少竞品或原词列表');
  if(frozenSources){
    const words=x=>x.keywords.map(k=>k.term);
    const competitors=x=>x.competitors.map(c=>[c.asin,c.title]);
    if(JSON.stringify(words(result))!==JSON.stringify(words(frozenSources))||JSON.stringify(competitors(result))!==JSON.stringify(competitors(frozenSources)))throw new Error('仅标题续作不能新增、修改或重排当次词源库');
    result.keywords=structuredClone(frozenSources.keywords);
    result.competitors=structuredClone(frozenSources.competitors);
  }
  if(result.reportFile&&!String(result.reportFile).endsWith('.md'))throw new Error('联合报告必须为Markdown文件');
  const seen=new Set();
  for (const keyword of result.keywords) {
    if (typeof keyword.term!=='string'||!keywordKey(keyword.term)||!tokenise(keyword.term).length||seen.has(keywordKey(keyword.term))) throw new Error('原词列表为空或包含重复词');
    seen.add(keywordKey(keyword.term));
    const url=new URL(keyword.queryUrl);
    if (url.protocol!=='https:'||!['sif.com','www.sif.com'].includes(url.hostname)||!keyword.seed||!keyword.period||!keyword.sourcePosition) throw new Error('Sif 原词缺少可追溯的查询来源');
    if (keyword.volume!==null&&(!Number.isFinite(keyword.volume)||keyword.volume<0)) throw new Error('搜索量格式不正确');
    if (keyword.volume===null&&!keyword.volumeStatus) throw new Error('缺失搜索量需要说明真实状态');
  }
  const asins=new Set();
  for (const competitor of result.competitors) {
    if (!/^B[A-Z0-9]{9}$/.test(competitor.asin)||asins.has(competitor.asin)||!competitor.title||!competitor.imageFile) throw new Error('竞品 ASIN、完整标题或本地图片无效');
    asins.add(competitor.asin);
    competitor.url=`https://www.amazon.com/dp/${competitor.asin}`;
  }
  const allowed=['completed','needs_login','needs_input','partial'];
  if (!allowed.includes(result.status)) throw new Error('执行器返回了未知状态');
  result.titles=result.titles?.length?auditTitles(input,result.titles,result):[];
  if (result.status==='completed'&&(result.titles.length!==2||result.competitors.length<5||result.keywords.length<15||!result.reportFile)) result.status='partial';
  return result;
}
