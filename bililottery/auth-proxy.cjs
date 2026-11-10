#!/usr/bin/env node
// BiliLottery Web 认证反代
// 监听 0.0.0.0:PORT，HTTP Basic Auth 通过后转发到 127.0.0.1:8787。
// 上游服务只信任 Host=127.0.0.1:8787，因此这里重写 Host 并移除 Origin。
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

const LISTEN_HOST = process.env.BILI_PROXY_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.BILI_PROXY_PORT || 8790);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.BILI_WEB_PORT || 8787);
const UPSTREAM_HOST_HEADER = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const PASSWORD_FILE = process.env.BILI_PROXY_PASSWORD_FILE || '/opt/bililottery/proxy.password';
const USER = process.env.BILI_PROXY_USER || 'bili';

function loadPassword() {
    const value = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    if (value.length < 8) throw new Error(`密码文件 ${PASSWORD_FILE} 内容过短（至少 8 位）`);
    return value;
}
let PASSWORD = loadPassword();

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index < 0) return false;
    return safeEqual(decoded.slice(0, index), USER) && safeEqual(decoded.slice(index + 1), PASSWORD);
}

const server = http.createServer((req, res) => {
    if (!authorized(req)) {
        res.writeHead(401, {
            'WWW-Authenticate': `Basic realm="BiliLottery", charset="UTF-8"`,
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        return res.end('需要登录\n');
    }
    const headers = { ...req.headers, host: UPSTREAM_HOST_HEADER };
    delete headers.origin;
    delete headers.referer;
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    delete headers['accept-encoding']; // SSE 与静态资源都直接给明文，避免压缩缓冲
    const upstream = http.request({
        host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers
    }, up => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
    });
    upstream.on('error', error => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`上游服务不可用：${error.code || error.message}\n`);
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
});
server.headersTimeout = 0;
server.requestTimeout = 0;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`BiliLottery 认证代理就绪：http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST_HEADER}（用户 ${USER}）`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
