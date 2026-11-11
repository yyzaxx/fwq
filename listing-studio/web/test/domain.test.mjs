import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, detectImage, renderTemplate, auditTitles, resolveWithin, validateResult } from '../lib/domain.mjs';

const input = {category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Wall Art, {风格}',ranges:[[20,80],[25,100]]};
const sources={keywords:[{term:'bunny room decor'},{term:'vintage easter decor'}],competitors:[{asin:'B0F6ND1QZH',title:'Rabbit Bunny Flower Canvas Wall Art'}]};
test('模板固定文字保留，占位可以使用两类已核实词源，并计算标点空格',()=>{
  const titles=[{text:'Brand Bunny Wall Art',slots:[{name:'主体',value:'Bunny'}]},{text:'Brand Rabbit Wall Art, Vintage Easter Decor',slots:[{name:'主体',value:'Rabbit'},{name:'风格',value:'Vintage Easter Decor'}]}];
  const checked=auditTitles(input,titles,sources);
  assert.equal(checked[0].length,20);
  assert.equal(checked[1].wordSources.find(x=>x.word==='Rabbit').source,'B0F6ND1QZH');
});
test('有来源的候选也不能改动模板固定文字或越过字符范围',()=>{
  assert.throws(()=>auditTitles(input,[{text:'Bunny Wall Art',slots:[{name:'主体',value:'Bunny'}]},{}],sources),/固定|模板/);
  assert.throws(()=>auditTitles({...input,ranges:[[65,75],[115,125]]},[{text:'Brand Bunny Wall Art',slots:[{name:'主体',value:'Bunny'}]},{}],sources),/字符/);
});
test('Neutral 等未核实新词不能借助图片判断补进占位',()=>{
  assert.throws(()=>auditTitles(input,[{text:'Brand Neutral Bunny Wall Art',slots:[{name:'主体',value:'Neutral Bunny'}]},{}],sources),/Neutral.*词源/);
});
test('不把竞品装框属性转用到本商品占位',()=>{
  assert.throws(()=>auditTitles(input,[{text:'Brand Framed Bunny Wall Art',slots:[{name:'主体',value:'Framed Bunny'}]},{}],{...sources,competitors:[{asin:'B0F6ND1QZH',title:'Framed Bunny Wall Art'}]}),/装框/);
});
test('输入需要类目和两套明确的占位模板，固定文字不能超过上限',()=>{
  assert.equal(validateInput(input).category,'挂画');
  assert.equal(validateInput({...input,templateOne:'  Brand {主体} Wall Art '}).templateOne,'  Brand {主体} Wall Art ');
  assert.throws(()=>validateInput({...input,templateTwo:''}),/标题二/);
  assert.throws(()=>validateInput({...input,templateOne:'Brand 主体 Wall Art'}),/占位/);
  assert.throws(()=>validateInput({...input,ranges:[[1,5],[25,100]]}),/固定文字/);
  assert.equal(renderTemplate('A {主体}, B {风格}!', [{name:'主体',value:'Rabbit'},{name:'风格',value:'Vintage'}]),'A Rabbit, B Vintage!');
});
test('按文件内容识别图片而非信任扩展名，拒绝脚本伪装',()=>{
  assert.equal(detectImage(Buffer.from([255,216,255,0])).ext,'jpg');
  assert.equal(detectImage(Buffer.from('89504e470d0a1a0a','hex')).ext,'png');
  assert.throws(()=>detectImage(Buffer.from('<svg onload="alert(1)">')),/图片格式/);
});
test('下载和资源解析不能逃出任务目录',()=>{
  assert.equal(resolveWithin('/tmp/job','assets/photo.jpg'),'/tmp/job/assets/photo.jpg');
  assert.throws(()=>resolveWithin('/tmp/job','../other/file'),/路径/);
  assert.throws(()=>resolveWithin('/tmp/job','/etc/passwd'),/路径/);
});
test('仅标题续作锁定旧词库，执行器不能新增词源再为自己背书',()=>{
  const frozen={keywords:[{term:'bunny decor',seed:'B0F6ND1QZH',queryUrl:'https://www.sif.com/reverse?asin=B0F6ND1QZH',period:'最近7天',volume:661,volumeStatus:'已核实',sourcePosition:'第1行'}],competitors:[{asin:'B0F6ND1QZH',title:'Bunny Wall Art',imageFile:'artifacts/bunny.jpg'}]};
  const forged=structuredClone({...frozen,status:'partial',titles:[]});
  forged.keywords.push({...forged.keywords[0],term:'invented decor'});
  assert.throws(()=>validateResult(input,forged,frozen),/词源|词库|原词/);
});
test('粘贴模板的首尾换行去掉、内部换行转为空格，普通空格和标点保留',()=>{
 const parsed=validateInput({...input,templateOne:'\r\nBrand {主体}\r\nWall Art\r\n'});assert.equal(parsed.templateOne,'Brand {主体} Wall Art');
 assert.equal(validateInput({...input,templateOne:'  Brand {主体} Wall Art '}).templateOne,'  Brand {主体} Wall Art ');
 assert.equal(renderTemplate('Brand {主体} Wall Art\n',[{name:'主体',value:'Bunny'}]),'Brand Bunny Wall Art');
});
test('历史模板末尾换行不会让合格的单行标题失败，固定文字改动仍拒绝',()=>{
 const historical={...input,templateOne:input.templateOne+'\n'};
 const titles=[{text:'Brand Bunny Wall Art',slots:[{name:'主体',value:'Bunny'}]},{text:'Brand Rabbit Wall Art, Vintage Easter Decor',slots:[{name:'主体',value:'Rabbit'},{name:'风格',value:'Vintage Easter Decor'}]}];
 const checked=auditTitles(historical,titles,sources);assert.equal(checked[0].text,'Brand Bunny Wall Art');assert.equal(checked[0].length,20);
 assert.throws(()=>auditTitles(historical,[{...titles[0],text:'Other Bunny Wall Art'},titles[1]],sources),/固定/);
});
test('单行规范化不能将非字符串标题当成有效结果',()=>{
 const single={category:'其他',templateOne:'{主体}',templateTwo:'{主体}',ranges:[[1,20],[1,20]]};
 assert.throws(()=>auditTitles(single,[{text:8,slots:[{name:'主体',value:'8'}]},{text:'8',slots:[{name:'主体',value:'8'}]}],{keywords:[{term:'8'}],competitors:[]}),/固定|模板|标题/);
});
test('空白或没有词语的返回项不能计为有效Sif原词',()=>{
 for(const term of ['   ','\t','\u3000','---','\u200b'])assert.throws(()=>validateResult(input,{status:'partial',titles:[],competitors:[],keywords:[{term,seed:'B012345678',queryUrl:'https://www.sif.com/traffic',period:'最近7天',volume:null,volumeStatus:'未展示',sourcePosition:'第1行'}]}),/原词/);
});
