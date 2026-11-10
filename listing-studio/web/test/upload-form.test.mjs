import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

async function harness(){
  const handlers={},element={addEventListener:(name,handler)=>handlers[name]=handler,classList:{add(){},remove(){}},textContent:'',innerHTML:''};
  let resolveUpload;
  const context=vm.createContext({URL,AbortController,structuredClone,console,setTimeout:()=>0,clearTimeout(){},location:{href:'http://test.local/qa/',pathname:'/qa/'},history:{replaceState(){}},window:{scrollTo(){}},localStorage:{getItem:()=>null,setItem(){}},document:{querySelector:()=>element},fetch:()=>new Promise(resolve=>resolveUpload=resolve)});
  let source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  source=source.replace(/^import[^\n]+\n/,'');source=source.slice(0,source.indexOf('try{const boot='));
  vm.runInContext(source+'\nrender=()=>{};',context);
  return {context,handlers,finish:()=>resolveUpload({ok:true,json:async()=>({id:'late-batch',name:'图片.zip',files:[{id:'001'}],skipped:[]})})};
}
test('编辑历史任务会使进行中的ZIP响应失效，迟到结果不能改变本次编辑商品',async()=>{
  const {context,handlers,finish}=await harness();
  vm.runInContext("state.tasks=[{id:'saved-task',input:{category:'挂画',templateOne:'A {主体}',templateTwo:'B {主体}',ranges:[[1,60],[1,100]]},name:'saved.jpg',previewFile:'preview.jpg'}];",context);
  const pending=vm.runInContext("loadImage({name:'images.zip',type:'application/zip',size:200})",context);
  await handlers.click({target:{closest:()=>({dataset:{action:'edit',id:'saved-task'}})},preventDefault(){}});
  finish();await pending;
  assert.equal(vm.runInContext('state.form.reuseId',context),'saved-task');
  assert.equal(vm.runInContext('state.form.batchId',context),'');
  assert.equal(vm.runInContext('state.form.templateOne',context),'A {主体}');
});
test('用无效文件替换正在上传的ZIP不会让提交按钮永远停留在上传状态',async()=>{
  const {context,finish}=await harness();
  const pending=vm.runInContext("loadImage({name:'images.zip',type:'application/zip',size:200})",context);
  await vm.runInContext("loadImage({name:'notes.txt',type:'text/plain',size:10})",context);
  assert.equal(vm.runInContext('state.form.archiveUploading',context),false);
  finish();await pending;
  assert.equal(vm.runInContext('state.form.batchId',context),'');
});
