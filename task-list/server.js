import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore, HttpError } from './lib/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 7380);
const dataFile = process.env.DATA_FILE || path.join(root, 'data', 'tasks.json');
const store = await new TaskStore(dataFile).init();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function response(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw new HttpError(400, '请求内容不是有效 JSON'); }
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return response(res, 405, { error: '请求方法不支持' });
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, name);
  if (!file.startsWith(`${publicDir}${path.sep}`)) return response(res, 404, { error: '页面不存在' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error.code === 'ENOENT') return response(res, 404, { error: '页面不存在' });
    throw error;
  }
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/api/')) return await serveStatic(req, res, pathname);
    if (pathname === '/api/tasks' && req.method === 'GET') return response(res, 200, { tasks: store.list() });
    if (pathname === '/api/tasks' && req.method === 'POST') return response(res, 201, { task: await store.create(await readBody(req)) });
    if (pathname === '/api/tasks/completed' && req.method === 'DELETE') return response(res, 200, await store.clearCompleted());
    const match = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})$/);
    if (match && req.method === 'PUT') return response(res, 200, { task: await store.edit(match[1], await readBody(req)) });
    if (match && req.method === 'DELETE') return response(res, 200, { task: await store.remove(match[1]) });
    response(res, 404, { error: '接口不存在' });
  } catch (error) {
    response(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '服务器暂时无法处理，请稍后重试' });
    if (!(error instanceof HttpError)) console.error(error);
  }
});

server.listen(port, '127.0.0.1', () => console.log(`任务清单已启动：http://127.0.0.1:${port}`));
