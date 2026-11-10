import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TemplateStore} from '../lib/templates.mjs';

const preset={name:'挂画常用',category:'挂画',templateOne:' Brand {主体} Wall Art ',templateTwo:'Brand {主体} Wall Art for Living Room, {风格}',ranges:[[65,75],[115,125]]};
test('模板成组持久保存，重启后两条固定文字和字符范围保持原样',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-presets-'));
  try{
    const file=path.join(root,'templates.json'),store=await new TemplateStore(file).init();
    const saved=await store.create(preset);
    const reloaded=await new TemplateStore(file).init();
    assert.equal(reloaded.list()[0].id,saved.id);
    assert.equal(reloaded.list()[0].templateOne,preset.templateOne);
    assert.deepEqual(reloaded.list()[0].ranges,preset.ranges);
    const copy=reloaded.list();copy[0].ranges[0][0]=1;
    assert.equal(reloaded.list()[0].ranges[0][0],65);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('并发保存不丢失，同类目同名不能静默覆盖，更新删除只影响所选模板',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-presets-'));
  try{
    const file=path.join(root,'templates.json'),store=await new TemplateStore(file).init();
    const items=await Promise.all(Array.from({length:4},(_,i)=>store.create({...preset,name:'组合'+i})));
    assert.equal(store.list().length,4);
    await assert.rejects(store.create({...preset,name:'组合0'}),/同名/);
    const changed=await store.update(items[0].id,{...preset,name:'已更新',expectedUpdatedAt:items[0].updatedAt,ranges:[[60,80],[110,130]]});
    assert.equal(changed.id,items[0].id);
    assert.deepEqual(changed.ranges,[[60,80],[110,130]]);
    await assert.rejects(store.update(items[0].id,{...preset,expectedUpdatedAt:items[0].updatedAt}),/修改|刷新/);
    await store.remove(items[1].id);
    assert.equal((await new TemplateStore(file).init()).list().length,3);
    assert.ok(store.list().some(x=>x.id===items[2].id));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('支持通用组合，缺少第二套模板或非法范围时不保存',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-presets-'));
  try{
    const store=await new TemplateStore(path.join(root,'templates.json')).init();
    assert.equal((await store.create({...preset,category:''})).category,'');
    await assert.rejects(store.create({...preset,templateTwo:''}),/标题二/);
    await assert.rejects(store.create({...preset,ranges:[[80,60],[110,130]]}),/字符/);
    assert.equal(store.list().length,1);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
