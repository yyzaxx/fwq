import test from 'node:test';
import assert from 'node:assert/strict';
import {applySavedTemplate,changeProductCategory,renameSavedTemplate} from '../public/template-form.js';

const form={category:'',templateOne:'',templateTwo:'',ranges:[[65,75],[115,125]],imageData:'original-image',reuseId:null};
const preset={id:'saved-preset',category:'挂画',templateOne:'Brand {主体} Wall Art',templateTwo:'Brand {主体} Canvas Wall Art',ranges:[[60,80],[110,130]]};
test('选择组合原样填入两条模板和范围，保留图片，记录适用类目',()=>{
  const result=applySavedTemplate(form,preset);
  assert.equal(result.category,'挂画');assert.equal(result.templateOne,preset.templateOne);assert.equal(result.imageData,'original-image');
  assert.equal(result.presetCategory,'挂画');assert.deepEqual(result.ranges,preset.ranges);
  result.ranges[0][0]=1;assert.equal(preset.ranges[0][0],60);
  assert.throws(()=>applySavedTemplate({...form,category:'马克杯'},preset),/类目/);
});
test('改类目时清除原类目的自动填入内容，取消选中也不能绕过适用类目',()=>{
  const loaded=applySavedTemplate(form,preset);
  for(const current of [loaded,{...loaded,presetId:''}]){
    const changed=changeProductCategory(current,'马克杯');
    assert.equal(changed.templateOne,'');assert.equal(changed.templateTwo,'');assert.equal(changed.presetId,'');
    assert.deepEqual(changed.ranges,[[65,75],[115,125]]);assert.equal(changed.imageData,'original-image');
  }
});
test('通用组合和手动填写内容不因类目改变而被误删',()=>{
  const generic=applySavedTemplate(form,{...preset,category:''});
  assert.equal(changeProductCategory(generic,'马克杯').templateOne,preset.templateOne);
  assert.equal(changeProductCategory({...form,templateOne:'Manual {主体}'},'马克杯').templateOne,'Manual {主体}');
});
test('两组模板来回切换只替换正文和范围，保留图片与类目，不污染保存组合',()=>{
  const another={...preset,id:'another-preset',templateOne:'Other {主体} Poster',templateTwo:'Other {主体} Print, {风格}',ranges:[[55,85],[100,140]]};
  const first=applySavedTemplate(form,preset);
  first.templateOne='本次临时修改';first.ranges[0][0]=2;
  const second=applySavedTemplate(first,another);
  assert.equal(second.templateOne,another.templateOne);assert.equal(second.templateTwo,another.templateTwo);
  assert.deepEqual(second.ranges,another.ranges);assert.equal(second.imageData,'original-image');assert.equal(second.category,'挂画');
  const restored=applySavedTemplate(second,preset);
  assert.equal(restored.templateOne,preset.templateOne);assert.equal(restored.templateTwo,preset.templateTwo);
  assert.deepEqual(restored.ranges,[[60,80],[110,130]]);assert.equal(restored.imageData,'original-image');assert.equal(restored.category,'挂画');
  assert.equal(preset.templateOne,'Brand {主体} Wall Art');assert.deepEqual(another.ranges,[[55,85],[100,140]]);
});
test('独立重命名只取已保存正文和范围，不夹带输入框里的临时编辑',()=>{
  const saved={...preset,name:'旧名字',updatedAt:'2026-11-09T13:20:00.000Z'};
  const renamed=renameSavedTemplate(saved,'  我的兔子挂画模板  ');
  assert.equal(renamed.name,'我的兔子挂画模板');
  assert.equal(renamed.templateOne,saved.templateOne);assert.equal(renamed.templateTwo,saved.templateTwo);
  assert.equal(renamed.category,'挂画');assert.deepEqual(renamed.ranges,saved.ranges);
  assert.equal(renamed.expectedUpdatedAt,saved.updatedAt);
  renamed.ranges[0][0]=1;assert.equal(saved.ranges[0][0],60);
  assert.throws(()=>renameSavedTemplate(saved,'   '),/名称/);
});
