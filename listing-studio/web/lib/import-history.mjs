import fs from 'node:fs/promises';
import path from 'node:path';

export async function importHistory(store,projectRoot){
  const id='history-bunny-20261109';if(store.get(id)||store.isDeleted(id))return;
  const stem='a5227f190a9eeb07_挂画_US_亚马逊竞品与Sif流量词_2026-11-09';
  const source=path.join(projectRoot,'research',stem+'_images');
  const originalReport=path.join(projectRoot,'research',stem+'.md');
  try{await fs.access(originalReport);}catch{return;}
  const directory=store.directory(id),artifacts=path.join(directory,'artifacts');
  await fs.mkdir(artifacts,{recursive:true});await fs.cp(source,path.join(artifacts,'images'),{recursive:true});
  await fs.copyFile(path.join(source,'design_thumb.jpg'),path.join(directory,'preview.jpg'));
  await fs.copyFile(path.join(source,'design_original.jpg'),path.join(directory,'design.jpg'));
  const md=(await fs.readFile(originalReport,'utf8')).split(source).join(path.join(artifacts,'images'));
  await fs.writeFile(path.join(artifacts,'report.md'),md);
  const order=md.split('\n')[0].split(', '),competitors=[];
  const differences={B0F6ND1QZH:'兔子探出锈色桶，周围是花草；参考图搭配胡萝卜和绿色条纹。',B0GYP64H5J:'兔子、桶和椭圆构图相近，竞品为花卉背景，没有胡萝卜或绿色条纹。',B0G5XG5YMN:'兔子坐在花盆里，配白花；没有提桶、胡萝卜和椭圆条纹。',B0G4LCFPW4:'兔子与胡萝卜主题相近，没有桶和条纹椭圆背景。',B0H2CXRDC5:'条纹椭圆布局相近，主体是穿睡衣的白兔，没有桶和胡萝卜。'};
  for(const asin of order){
    const p=JSON.parse(await fs.readFile(path.join(source,asin+'_evidence.json'),'utf8'));
    competitors.push({asin,title:p.titleArea.replace(/\s+/g,' ').trim(),variant:p.selectedVariant||'已核实页面变体',imageFile:`artifacts/images/${asin}_thumb.jpg`,imageSource:p.main.hires||p.main.src,url:`https://www.amazon.com/dp/${asin}`,similarity:'仅主题相似',difference:differences[asin]});
  }
  const sif=JSON.parse(await fs.readFile(path.join(source,'sif_status.json'),'utf8')),keywords=[];
  for(const term of sif.selected_keywords||[]){
    let found;
    for(const query of sif.queries){const evidence=JSON.parse(await fs.readFile(path.join(source,`sif_${query.seed}_7d.json`),'utf8'));const row=evidence.rows.find(x=>x.keyword===term);if(row){found={query,row};break;}}
    const v=sif.weekly_volumes[term];
    keywords.push({term,seed:found.query.seed,queryUrl:found.query.url,period:'最近7天；周搜索量',volume:v.value,volumeStatus:v.value===null?'页面未展示数值':'已核实周搜索量',sourcePosition:`主流量词列表第${found.row.row}行`});
  }
  await store.create({category:'挂画',templateOne:'',templateTwo:'',ranges:[[65,75],[115,125]]},{id,state:'needs_input',stage:'titles',message:'调研已完成，补充两套模板即可生成标题',name:'兔子与胡萝卜挂画',imageFile:'design.jpg',previewFile:'preview.jpg',mode:'titles_only',imported:true,result:{status:'needs_input',message:'两套标题模板尚未提供',titles:[],keywords,competitors,reportFile:'artifacts/report.md'},createdAt:sif.checked_at||new Date().toISOString()});
}
