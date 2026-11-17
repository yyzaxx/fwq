import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const helpers=source.split('// Keyword translation display helpers.')[1].split('// End keyword translation display helpers.')[0];
const task=()=>({id:'translation-task',state:'completed',result:{keywords:[{term:'frog decor'},{term:'cute frog decor'}]}});
function setup(api){
 const state={tasks:[task()],selected:'translation-task',screen:'detail',tab:'words'};
 const context=vm.createContext({state,api,render:()=>{},esc:value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))});
 vm.runInContext(helpers+'\nglobalThis.ui={ensureKeywordTranslations,keywordTranslationNotice,keywordMeaning,preserveDisplayedKeywordMeanings};',context);
 return context;
}
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('中文释义晚到时只补同一个英文词，不恢复已删除词、不覆盖新状态和顺序',async()=>{
 const pending=gate(),calls=[];
 const f=setup(async(route)=>{calls.push(route);if(route.endsWith('/keyword-translations'))return pending.promise;return {result:{keywords:[{term:'frog decor',translationZh:'青蛙装饰'},{term:'cute frog decor',translationZh:'可爱青蛙装饰'}]}};});
 const request=f.ui.ensureKeywordTranslations();await f.ui.ensureKeywordTranslations();assert.equal(calls.length,1);
 f.state.tasks=[{...task(),state:'queued',result:{keywords:[{term:'cute frog decor'},{term:'new frog print'}]}}];pending.resolve({});await request;
 const current=f.state.tasks[0];assert.equal(current.state,'queued');assert.equal(current.result.keywords.length,2);
 assert.equal(current.result.keywords[0].term,'cute frog decor');assert.equal(current.result.keywords[0].translationZh,'可爱青蛙装饰');
 assert.equal(current.result.keywords[1].term,'new frog print');assert.equal(current.result.keywords[1].translationZh,undefined);
});
test('释义失败不会轮询重试或阻塞英文词，显式重试后可显示中文',async()=>{
 let failed=true,count=0;
 const f=setup(async(route)=>{count++;if(failed)throw Error('offline');return {result:{keywords:[{term:'frog decor',translationZh:'青蛙装饰'},{term:'cute frog decor',translationZh:'可爱青蛙装饰'}]}};});
 await f.ui.ensureKeywordTranslations();await f.ui.ensureKeywordTranslations();assert.equal(count,1);
 assert.match(f.ui.keywordTranslationNotice(f.state.tasks[0]),/重试中文释义/);assert.equal(f.state.tasks[0].result.keywords[0].term,'frog decor');
 failed=false;await f.ui.ensureKeywordTranslations('translation-task',{retry:true});assert.equal(count,3);
 assert.equal(f.ui.keywordTranslationNotice(f.state.tasks[0]),'');
});
test('复制按钮在存在中文释义时仍只复制英文原词、原有顺序及分隔符',()=>{
 const row=source.split('\n').find(line=>line.includes("if(action==='copy-words')"));
 const state={selected:'translation-task',tasks:[{id:'translation-task',result:{keywords:[{term:'Frog decor',translationZh:'青蛙装饰'},{term:'cute frog decor',translationZh:'可爱青蛙装饰'}]}}]};
 let copied;vm.runInNewContext('(function(){'+row+'})()',{state,action:'copy-words',copy:value=>copied=value});assert.equal(copied,'Frog decor, cute frog decor');
});
test('词卡和来源表均转义中文释义，未生成时提示生成中',()=>{
 const wordsTab=source.slice(source.indexOf('function wordsTab('),source.indexOf('function competitorsTab('));
 const f=setup(async()=>({}));Object.assign(f,{canChangeKeywords:()=>true,blacklistPanel:()=>'',icon:()=>'',titleActionLabel:()=>''});
 vm.runInContext(wordsTab+'\nglobalThis.wordsHtml=wordsTab;',f);
 const data=task();data.result.keywords=[{term:'frog decor',translationZh:'青蛙<script>alert(1)</script>装饰'}];
 const html=f.wordsHtml(data);assert.match(html,/中文意思/);assert.equal((html.match(/青蛙&lt;script&gt;alert\(1\)&lt;\/script&gt;装饰/g)||[]).length,2);assert.doesNotMatch(html,/<script>/);
 data.result.keywords=[{term:'frog decor'}];assert.match(f.wordsHtml(data),/释义生成中/);
});

test('旧轮询响应保留已显示中文，仅兜底同任务同原词，服务端新状态和顺序优先',()=>{
 const f=setup(async()=>({}));
 const previous=[{id:'translation-task',state:'completed',result:{keywords:[{term:'frog decor',translationZh:'青蛙装饰'},{term:'cute frog decor',translationZh:'可爱青蛙装饰'},{term:'removed word',translationZh:'已删除词'}]}},{id:'other-task',result:{keywords:[{term:'another keyword',translationZh:'其他词'}]}}];
 const incoming=[{id:'translation-task',state:'queued',message:'后端新状态',result:{reportFile:'new-report.md',keywords:[{term:'cute frog decor'},{term:'frog decor',translationZh:'服务端更新的中文'},{term:'FROG decor'},{term:'new keyword'}]}},{id:'third-task',result:{keywords:[{term:'another keyword'}]}}];
 const merged=f.ui.preserveDisplayedKeywordMeanings(incoming,previous);
 assert.equal(merged[0].state,'queued');assert.equal(merged[0].message,'后端新状态');assert.equal(merged[0].result.reportFile,'new-report.md');
 assert.deepEqual(Array.from(merged[0].result.keywords,word=>word.term),['cute frog decor','frog decor','FROG decor','new keyword']);
 assert.equal(merged[0].result.keywords[0].translationZh,'可爱青蛙装饰');assert.equal(merged[0].result.keywords[1].translationZh,'服务端更新的中文');
 assert.equal(merged[0].result.keywords[2].translationZh,undefined);assert.equal(merged[1].result.keywords[0].translationZh,undefined);
 assert.equal(incoming[0].result.keywords[0].translationZh,undefined);
});
