import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
async function harness(){
 const handlers={},calls=[],element={addEventListener:(event,handler)=>handlers[event]=handler,classList:{add(){},remove(){}},textContent:'',innerHTML:''};
 const task={id:'keyword-source',name:'设计图',input:{category:'挂画',templateOne:'{主体}',templateTwo:'{主体}'},state:'completed',result:{keywords:[{term:'frog "art" <test>',volume:null}],competitors:[{asin:'B012345678'}],titles:[]}};
 const context=vm.createContext({URL,structuredClone,console,setTimeout:()=>0,clearTimeout(){},location:{href:'http://test.local/qa/',pathname:'/qa/'},history:{replaceState(){}},window:{scrollTo(){},confirm:()=>true},localStorage:{getItem:()=>null,setItem(){}},document:{querySelector:()=>element},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/queue')?{}:url.endsWith('/batches')?[]:{...task,state:'queued'}};}});
 let source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');source=source.replace(/^import[^\n]+\n/,'');source=source.slice(0,source.indexOf('try{const boot='));vm.runInContext(source+'\nrender=()=>{};',context);context.fixture=task;vm.runInContext("state.tasks=[fixture];state.selected=fixture.id;",context);
 const click=(action,term)=>handlers.click({target:{closest:()=>({dataset:{action,id:task.id,term}})},preventDefault(){}});
 return {context,calls,click};
}
test('词表提供整组重采和逐词操作，特殊字符词可安全显示并原样传回服务器',async()=>{
 const h=await harness(),html=vm.runInContext('wordsTab(state.tasks[0])',h.context);assert.match(html,/全部重新采集/);assert.match(html,/换一个/);assert.match(html,/删除/);assert.doesNotMatch(html,/<test>/);
 await h.click('keyword-replace','frog "art" <test>');const call=h.calls.find(c=>c.url.endsWith('/keywords'));assert.ok(call);assert.deepEqual(JSON.parse(call.options.body),{action:'replace',term:'frog "art" <test>'});
});
test('删除到零个词后仍提供重新采集入口，运行中禁用选词修改',async()=>{
 const h=await harness();vm.runInContext('state.tasks[0].result.keywords=[];',h.context);let html=vm.runInContext('wordsTab(state.tasks[0])',h.context);assert.match(html,/全部重新采集/);
 vm.runInContext("state.tasks[0].state='running';",h.context);html=vm.runInContext('wordsTab(state.tasks[0])',h.context);assert.match(html,/data-action="keyword-refresh"[^>]*disabled/);
});
test('新词库尚未生成标题时可直接使用已保存模板生成，不需要重新填表',async()=>{
 const h=await harness();vm.runInContext('state.tasks[0].titlesStale=true;',h.context);assert.match(vm.runInContext('titleTab(state.tasks[0])',h.context),/按新词库生成标题/);await h.click('regenerate-titles');const call=h.calls.find(c=>c.url.endsWith('/resume'));assert.ok(call);assert.deepEqual(JSON.parse(call.options.body),{templateOne:'{主体}',templateTwo:'{主体}'});
});
test('标题校验失败后展示已保留资料和重新生成入口，不误称词库已修改',async()=>{
 const h=await harness();vm.runInContext("state.tasks[0].titlesStale=true;state.tasks[0].titleValidationError='标题1改动了模板固定文字或标点';",h.context);
 const title=vm.runInContext('titleTab(state.tasks[0])',h.context);assert.match(title,/标题校验未通过/);assert.match(title,/使用已有资料生成标题/);assert.doesNotMatch(title,/流量词已更新/);
 const words=vm.runInContext('wordsTab(state.tasks[0])',h.context);assert.doesNotMatch(words,/词库已修改/);assert.match(words,/使用已有资料生成标题/);
});
