import {test} from 'node:test';
import assert from 'node:assert/strict';
import {change,select,restore} from './dist/tasks.js';
test('新增后可完成、编辑和删除任务',()=>{let tasks=change([],{type:'add',title:' 写周报 ',priority:'high'});assert.equal(tasks[0].title,'写周报');let id=tasks[0].id;tasks=change(tasks,{type:'toggle',id});assert.equal(tasks[0].done,true);tasks=change(tasks,{type:'edit',id,title:'提交周报'});assert.equal(tasks[0].title,'提交周报');assert.deepEqual(change(tasks,{type:'delete',id}),[]);});
test('空任务不保存，筛选和搜索组合生效',()=>{assert.equal(change([],{type:'add',title:'  '}).length,0);const tasks=[{title:'写周报',done:false,priority:'high'},{title:'散步',done:true,priority:'normal'}];assert.equal(select(tasks,'active','周报').length,1);assert.equal(select(tasks,'done','周报').length,0);assert.equal(select(tasks,'important','').length,1);});
test('损坏或不符合格式的存储可安全恢复',()=>{assert.deepEqual(restore('bad json'),[]);assert.deepEqual(restore('{}'),[]);assert.deepEqual(restore('[null,1,{}]'),[]);assert.equal(restore('[{"id":"1","title":"任务","done":false,"priority":"normal"}]').length,1);});
