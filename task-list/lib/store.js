import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PRIORITIES = ['low', 'medium', 'high'];
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, name, max, required = false) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${name}格式不正确`);
  const result = value.trim();
  if (required && !result) throw new HttpError(400, `请填写${name}`);
  if (result.length > max) throw new HttpError(400, `${name}最多${max}个字符`);
  return result;
}

function date(value) {
  const result = text(value, '截止日期', 10);
  if (!result) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new HttpError(400, '截止日期格式不正确');
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new HttpError(400, '截止日期不存在');
  return result;
}

function priority(value) {
  const result = value ?? 'medium';
  if (!PRIORITIES.includes(result)) throw new HttpError(400, '优先级不正确');
  return result;
}

function validTask(task) {
  return task && typeof task.id === 'string' && typeof task.title === 'string' && task.title.length > 0 && task.title.length <= 120 &&
    typeof task.note === 'string' && task.note.length <= 1000 && /^\d{4}-\d{2}-\d{2}$|^$/.test(task.dueDate) &&
    PRIORITIES.includes(task.priority) && typeof task.completed === 'boolean' && typeof task.createdAt === 'string' && typeof task.updatedAt === 'string';
}

export class TaskStore {
  constructor(file) {
    this.file = file;
    this.tasks = [];
    this.operation = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tasks) || !data.tasks.every(validTask)) throw new Error('任务数据格式无效');
      this.tasks = data.tasks;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  list() { return this.tasks.map(task => ({ ...task })); }
  get(id) { return this.tasks.find(task => task.id === id); }

  write(input, existing) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请求内容无效');
    const title = text(input.title, '任务名称', 120, true);
    const task = {
      id: existing?.id || randomUUID(),
      title,
      note: text(input.note, '备注', 1000),
      dueDate: date(input.dueDate),
      priority: priority(input.priority),
      completed: typeof input.completed === 'boolean' ? input.completed : (existing?.completed || false),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return task;
  }

  update(mutator) {
    const result = this.operation.catch(() => {}).then(async () => {
      const value = mutator();
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ version: 1, tasks: this.tasks }, null, 2), { mode: 0o600 });
      await fs.rename(temp, this.file);
      return value;
    });
    this.operation = result;
    return result;
  }

  create(input) {
    return this.update(() => {
      const task = this.write(input);
      this.tasks.unshift(task);
      return { ...task };
    });
  }

  edit(id, input) {
    return this.update(() => {
      const index = this.tasks.findIndex(task => task.id === id);
      if (index < 0) throw new HttpError(404, '任务不存在或已删除');
      const task = this.write(input, this.tasks[index]);
      this.tasks[index] = task;
      return { ...task };
    });
  }

  remove(id) {
    return this.update(() => {
      const index = this.tasks.findIndex(task => task.id === id);
      if (index < 0) throw new HttpError(404, '任务不存在或已删除');
      const [task] = this.tasks.splice(index, 1);
      return { ...task };
    });
  }

  clearCompleted() {
    return this.update(() => {
      const count = this.tasks.filter(task => task.completed).length;
      this.tasks = this.tasks.filter(task => !task.completed);
      return { count };
    });
  }
}
