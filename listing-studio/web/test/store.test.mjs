import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../lib/store.mjs';
import { renderMarkdown, packageReport } from '../lib/reports.mjs';

test('任务持久保存，并发进度写入不丢失，服务恢复仍保留资料',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-store-'));
  try {
    const store=await new TaskStore(root).init();
    const task=await store.create({category:'挂画',templateOne:'A {主体}',templateTwo:'B {主体}',ranges:[[1,50],[1,50]]});
    await Promise.all(Array.from({length:8},(_,i)=>store.patch(task.id,x=>({events:[...x.events,{message:String(i)}]}))));
    const restored=await new TaskStore(root).init();
    assert.equal(restored.get(task.id).events.length,8);
    assert.equal(restored.get(task.id).input.category,'挂画');
    assert.throws(()=>restored.directory('../../etc'),/任务/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('报告可读并将本地图片转成任务资源地址，网页脚本只显示文本',()=>{
  const html=renderMarkdown('# 报告\n\n![参考图](</tmp/job/pic.jpg>)\n\n<script>alert(1)</script>\n\n|词|量|\n|---|---|\n|bunny decor|661|',p=>'/asset?path='+encodeURIComponent(p));
  assert.match(html,/<table>/);
  assert.match(html,/src="\/asset\?path=/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/&lt;script&gt;/);
});
test('报告下载包含实际图片且路径相对化，不打包执行日志或越界文件',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'listing-bundle-'));
  try {
    await fs.mkdir(path.join(root,'images'));
    await fs.writeFile(path.join(root,'images','a.jpg'),'image-content');
    await fs.writeFile(path.join(root,'secret.log'),'private-log');
    await fs.writeFile(path.join(root,'executor.jsonl'),'private-executor-content');
    await fs.writeFile(path.join(root,'input.json'),'private-input-content');
    await fs.symlink(path.join(root,'executor.jsonl'),path.join(root,'images','alias.jpg'));
    await fs.writeFile(path.join(root,'report.md'),`# 报告\n![图](<${root}/images/a.jpg>)\n[不应打包](</etc/passwd>)\n[日志](executor.jsonl)\n[内部输入](input.json)\n![别名](images/alias.jpg)`);
    const bundle=await packageReport(root,'report.md');
    assert.equal(bundle.subarray(0,2).toString(),'PK');
    assert.ok(bundle.includes(Buffer.from('images/a.jpg')));
    assert.ok(!bundle.includes(Buffer.from('secret.log')));
    assert.ok(!bundle.includes(Buffer.from('private-executor-content')));
    assert.ok(!bundle.includes(Buffer.from('private-input-content')));
    assert.ok(!bundle.includes(Buffer.from('root:x:')));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
