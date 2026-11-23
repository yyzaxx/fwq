import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore, HttpError } from '../lib/store.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-list-test-'));
  return { dir, store: await new TaskStore(path.join(dir, 'tasks.json')).init() };
}

test('创建、修改、完成和删除任务并持久化', async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.create({ title: '  准备周报  ', note: '整理本周工作', dueDate: '2026-11-20', priority: 'high' });
    assert.equal(created.title, '准备周报');
    assert.equal(created.completed, false);
    const updated = await store.edit(created.id, { ...created, title: '完成周报', completed: true });
    assert.equal(updated.completed, true);
    const restored = await new TaskStore(store.file).init();
    assert.equal(restored.get(created.id).title, '完成周报');
    await store.remove(created.id);
    assert.equal(store.list().length, 0);
    assert.equal(JSON.parse(await fs.readFile(store.file, 'utf8')).tasks.length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('拒绝无效输入，且不会破坏已有数据', async () => {
  const { dir, store } = await fixture();
  try {
    await assert.rejects(store.create({ title: '' }), error => error instanceof HttpError && error.status === 400);
    await assert.rejects(store.create({ title: '测试', dueDate: '2026-02-31' }), /截止日期不存在/);
    await assert.rejects(store.create({ title: '测试', priority: 'urgent' }), /优先级不正确/);
    await assert.rejects(store.create({ title: 'x'.repeat(121) }), /最多120个字符/);
    assert.equal(store.list().length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('清除已完成任务，保留待办并正确处理不存在任务', async () => {
  const { dir, store } = await fixture();
  try {
    const done = await store.create({ title: '已完成', completed: true });
    await store.create({ title: '待完成' });
    assert.deepEqual(await store.clearCompleted(), { count: 1 });
    assert.equal(store.list().length, 1);
    await assert.rejects(store.remove(done.id), error => error.status === 404);
    assert.equal(store.list().length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('空文件初始化和并发写入不会丢失任务', async () => {
  const { dir, store } = await fixture();
  try {
    assert.deepEqual(store.list(), []);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.create({ title: `任务 ${i}` })));
    const restored = await new TaskStore(store.file).init();
    assert.equal(restored.list().length, 20);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
