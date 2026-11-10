const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_SETTINGS, readJson, saveConfigs, writeJsonAtomic, validateEngine, accountStatus, ensureDir } = require('../src/config.cjs');
const { EngineManager, createLoginQr, sanitizeLog } = require('../src/engine.cjs');
const { collectSummaries, prepareSummaryQueue } = require('../src/summaries.cjs');
const { previewExpiredReposts, cleanupExpiredReposts } = require('../src/cleanup.cjs');
const project = path.resolve(__dirname, '..');

function createWebServer(options = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(project, 'web-data'));
    const runtime = path.join(dataDir, 'runtime'), settingsFile = path.join(dataDir, 'settings.json');
    const seed = options.seedRoot === undefined ? path.join(project, 'release/BiliLotteryDesktop-Green-v1.0.0/data') : options.seedRoot;
    ensureDir(dataDir);
    if (!fs.existsSync(settingsFile) && seed && fs.existsSync(path.join(seed, 'settings.json'))) {
        if (fs.existsSync(path.join(seed, 'runtime'))) fs.cpSync(path.join(seed, 'runtime'), runtime, {
            recursive: true, filter: file => path.basename(file) !== 'desktop-worker'
        });
        fs.copyFileSync(path.join(seed, 'settings.json'), settingsFile);
    }
    ensureDir(runtime);
    let settings = readJson(settingsFile, DEFAULT_SETTINGS);
    if (!settings.enginePath) settings.enginePath = path.join(project, 'engine/LotteryAutoScript');
    if (!fs.existsSync(path.join(runtime, 'my_config.js'))) settings = saveConfigs(settings.enginePath, runtime, settings);
    writeJsonAtomic(settingsFile, settings);
    const manager = new EngineManager(path.join(dataDir, 'logs'));
    const clients = new Set(), token = crypto.randomBytes(32).toString('hex');
    let prep = null, qrImage = '', lastQr = '', output = '', port = 0;
    const proc = () => prep ? { running: true, action: prep.action, startedAt: prep.startedAt } : manager.getState();
    const state = () => ({ rootDir: dataDir, runtimeDir: runtime, settings, engine: validateEngine(settings.enginePath),
        account: accountStatus(runtime), process: proc(), version: '1.0.0 Web',
        summaryPreview: readJson(path.join(runtime, 'summary-preview.json'), { sources: [], items: [] }),
        cleanupPreview: readJson(path.join(runtime, 'cleanup-preview.json'), { items: [], deleted: 0 }) });
    const emit = (type, data) => { for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    manager.on('output', text => {
        output = (output + text).slice(-50000); emit('output', text);
        if (manager.action === 'login') {
            const child = manager.child;
            createLoginQr(settings.enginePath, text).then(qr => {
                if (!qr || manager.child !== child || lastQr === qr.url) return;
                lastQr = qr.url; qrImage = qr.image; emit('qrcode', qrImage);
            }).catch(() => manager.appendLog('[Web助手] 二维码图片生成失败\n'));
        }
    });
    manager.on('state', value => {
        if (!value.running) { qrImage = ''; lastQr = ''; }
        emit('state', value);
    });
    function idle() { if (proc().running) throw new Error('已有任务运行中，请先停止'); }
    async function prepare(work, action = 'summary') {
        idle(); const controller = new AbortController();
        prep = { controller, action, startedAt: Date.now() }; emit('state', proc());
        try { return await work({ signal: controller.signal, onOutput: text => manager.appendLog(text) }); }
        finally { prep = null; emit('state', proc()); }
    }
    async function run(action) {
        idle();
        const account = accountStatus(runtime);
        if (['check', 'account'].includes(action) && !account.loggedIn) throw new Error('请先扫码登录');
        if (['start', 'login'].includes(action) && !account.hasUid) throw new Error('请先填写并保存 UID');
        if (action === 'start' && settings.summarySource) return prepare(async params => {
            if (settings.cleanupExpired) await cleanupExpiredReposts(runtime, settings, params);
            const report = await collectSummaries(runtime, settings, params);
            await prepareSummaryQueue(report, settings.enginePath, runtime, settings, params);
            params.signal.throwIfAborted();
            const worker = path.join(runtime, 'desktop-worker'); ensureDir(worker);
            for (const file of ['config.cjs', 'summaries.cjs', 'cleanup.cjs', 'summary-runner.cjs']) fs.copyFileSync(path.join(project, 'src', file), path.join(worker, file));
            return manager.run(action, { enginePath: settings.enginePath, runtimeDir: runtime, runnerEntry: path.join(worker, 'summary-runner.cjs') });
        });
        return manager.run(action, { enginePath: settings.enginePath, runtimeDir: runtime });
    }
    const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    async function body(req) {
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('请求过大'); }
        return text ? JSON.parse(text) : {};
    }
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
        const host = req.headers.host;
        if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: '拒绝非本机或跨站请求' });
        try {
            if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return json(res, 400, { error: '无效请求路径' });
            const url = new URL(req.url, `http://${host}`);
            if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
                res.setHeader('Set-Cookie', `bili_web=${token}; HttpOnly; SameSite=Strict; Path=/`);
                return json(res, 200, { ...state(), webToken: token, qrImage, output });
            }
            if (req.method === 'GET' && url.pathname === '/api/events') {
                if (!(req.headers.cookie || '').split(';').some(c => c.trim() === `bili_web=${token}`)) return json(res, 403, { error: '请刷新页面建立连接' });
                res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
                res.write(': connected\n\n'); clients.add(res);
                const timer = setInterval(() => res.write(': ping\n\n'), 20000);
                res.on('close', () => { clearInterval(timer); clients.delete(res); }); return;
            }
            if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
                if (req.headers['x-web-token'] !== token) return json(res, 403, { error: '页面会话无效，请刷新' });
                const input = await body(req);
                if (url.pathname === '/api/settings') {
                    idle(); const update = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'enginePath' && Object.hasOwn(input, k)).map(k => [k, input[k]]));
                    settings = saveConfigs(settings.enginePath, runtime, { ...settings, ...update }); writeJsonAtomic(settingsFile, settings);
                    return json(res, 200, state());
                }
                if (url.pathname === '/api/engine') {
                    idle(); const candidate = String(input.path || '').trim(); const info = validateEngine(candidate);
                    if (!info.valid) throw new Error(info.message);
                    settings.enginePath = path.resolve(candidate); writeJsonAtomic(settingsFile, settings); return json(res, 200, state());
                }
                if (url.pathname === '/api/run') return json(res, 200, await run(input.action));
                if (url.pathname === '/api/stop') {
                    if (prep) prep.controller.abort(new Error('已取消任务')); else await manager.stop();
                    return json(res, 200, true);
                }
                if (url.pathname === '/api/summaries') {
                    await prepare(params => collectSummaries(runtime, settings, params)); return json(res, 200, state());
                }
                if (url.pathname === '/api/cleanup-preview') {
                    await prepare(params => previewExpiredReposts(runtime, settings, params), 'cleanup'); return json(res, 200, state());
                }
                if (url.pathname === '/api/path') {
                    const paths = { root: dataDir, data: dataDir, logs: path.join(dataDir, 'logs'), engine: settings.enginePath, config: path.join(runtime, 'my_config.js') };
                    if (!paths[input.target]) throw new Error('未知目录'); return json(res, 200, { path: paths[input.target] });
                }
                return json(res, 404, { error: '接口不存在' });
            }
            if (req.method !== 'GET') return json(res, 405, { error: '不支持的请求方式' });
            const assets = { '/': ['src/index.html', 'text/html'], '/index.html': ['src/index.html', 'text/html'],
                '/styles.css': ['src/styles.css', 'text/css'], '/renderer.js': ['src/renderer.js', 'text/javascript'],
                '/web-adapter.js': ['web/adapter.js', 'text/javascript'], '/web.css': ['web/web.css', 'text/css'] };
            const asset = assets[url.pathname]; if (!asset) return json(res, 404, { error: '文件不存在' });
            let content = fs.readFileSync(path.join(project, asset[0]), 'utf8');
            if (asset[1] === 'text/html') content = content.replace('<script src="renderer.js">', '<script src="web-adapter.js"></script>\n    <script src="renderer.js">')
                .replace('</head>', '<link rel="stylesheet" href="web.css">\n</head>')
                .replaceAll('Bili抽奖助手 · 绿色版', 'Bili抽奖助手 · Web版').replaceAll('绿色桌面版', '本机 Web 应用')
                .replace('id="enginePath" readonly', 'id="enginePath"').replace('>选择目录</button>', '>连接源码</button>')
                .replace('EXE 只包含桌面界面。', 'Web 版由本机 Node.js 服务运行。').replace('绿色版数据', 'Web 版数据');
            res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(content);
        } catch (error) { json(res, 400, { error: sanitizeLog(error.message) }); }
    });
    return {
        state,
        listen: (requestedPort = 8787) => new Promise((resolve, reject) => {
            server.once('error', reject); server.listen(requestedPort, '127.0.0.1', () => { port = server.address().port; resolve(`http://127.0.0.1:${port}`); });
        }),
        close: async () => {
            prep?.controller.abort(new Error('服务关闭'));
            if (manager.getState().running) { const finished = new Promise(resolve => manager.once('finished', resolve)); await manager.stop(); await finished; }
            for (const client of clients) client.end();
            await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        }
    };
}
if (require.main === module) {
    const web = createWebServer(); const requested = Number(process.env.BILI_WEB_PORT || 8787);
    web.listen(requested).then(url => console.log(`Bili Lottery Web ready: ${url}`)).catch(e => { console.error(e.message); process.exitCode = 1; });
    for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => web.close().then(() => process.exit(0)));
}
module.exports = { createWebServer };
