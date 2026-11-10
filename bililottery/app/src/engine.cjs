const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { ensureDir, validateEngine } = require('./config.cjs');

const ACTIONS = new Set(['start', 'stop', 'login', 'check', 'account', 'update', 'help']);

async function createLoginQr(enginePath, line) {
    let url;
    try { url = new URL(String(line).trim()); } catch { return null; }
    if (url.protocol !== 'https:' || url.host !== 'account.bilibili.com'
        || url.pathname !== '/h5/account-h5/auth/scan-web'
        || !url.searchParams.get('qrcode_key') || url.username || url.password) return null;
    const engineRequire = createRequire(path.join(enginePath, 'package.json'));
    const loginRequire = createRequire(engineRequire.resolve('@catlair/blogin'));
    const image = await loginRequire('qrcode').toDataURL(url.href, {
        errorCorrectionLevel: 'M', margin: 4, scale: 8,
        color: { dark: '#000000ff', light: '#ffffffff' }
    });
    return { url: url.href, image };
}

function sanitizeLog(input) {
    return String(input)
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/(SESSDATA=)[^;\s'"]+/gi, '$1[已隐藏]')
        .replace(/(bili_jct=)[^;\s'"]+/gi, '$1[已隐藏]')
        .replace(/(DedeUserID__ckMd5=)[^;\s'"]+/gi, '$1[已隐藏]')
        .replace(/(Cookie\s*[:，,]?\s*)(.+)/gi, '$1[已隐藏，请查看本地 env.js]')
        .replace(/\r/g, '');
}

class EngineManager extends EventEmitter {
    constructor(logsDir) {
        super();
        this.logsDir = logsDir;
        this.child = null;
        this.action = '';
        this.startedAt = null;
        ensureDir(logsDir);
    }

    getState() {
        return {
            running: Boolean(this.child),
            action: this.action,
            startedAt: this.startedAt
        };
    }

    appendLog(text, persist = true) {
        const clean = sanitizeLog(text);
        if (!clean) return;
        if (persist) {
            const day = new Date().toLocaleDateString('zh-CN').replaceAll('/', '-');
            const file = path.join(this.logsDir, `lottery-${day}.log`);
            fs.appendFile(file, clean, { encoding: 'utf8' }, () => {});
        }
        this.emit('output', clean);
    }

    run(action, { enginePath, runtimeDir, runnerEntry }) {
        if (!ACTIONS.has(action) || action === 'stop') throw new Error('不支持的操作');
        if (this.child) throw new Error('已有任务正在运行，请先停止');
        const engine = validateEngine(enginePath);
        if (!engine.valid) throw new Error(engine.message);
        if (!engine.dependencies) throw new Error('外置源码缺少依赖，请先完成依赖安装');
        if (!fs.existsSync(path.join(runtimeDir, 'env.js')) || !fs.existsSync(path.join(runtimeDir, 'my_config.js'))) {
            throw new Error('配置尚未生成，请先保存设置');
        }

        const entry = runnerEntry || path.join(enginePath, 'main.js');
        this.appendLog(`\n[桌面助手] 启动 ${action}，引擎 v${engine.version}\n`);
        const child = spawn(process.execPath, [entry, action, ...(runnerEntry ? [enginePath] : [])], {
            cwd: runtimeDir,
            windowsHide: true,
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                NO_COLOR: '1',
                FORCE_COLOR: '0'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        this.child = child;
        this.action = action;
        this.startedAt = Date.now();
        this.emit('state', this.getState());

        let stdoutBuffer = '';
        let stderrBuffer = '';
        const consume = (chunk, isError = false) => {
            let buffer = isError ? stderrBuffer + chunk.toString('utf8') : stdoutBuffer + chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            if (isError) stderrBuffer = buffer; else stdoutBuffer = buffer;
            for (const line of lines) this.appendLog(`${line}\n`);
        };
        child.stdout.on('data', chunk => consume(chunk));
        child.stderr.on('data', chunk => consume(chunk, true));
        child.on('error', error => {
            this.appendLog(`[桌面助手] 进程启动失败：${error.message}\n`);
        });
        child.on('close', (code, signal) => {
            if (stdoutBuffer) this.appendLog(`${stdoutBuffer}\n`);
            if (stderrBuffer) this.appendLog(`${stderrBuffer}\n`);
            this.appendLog(`[桌面助手] 任务结束${signal ? `（${signal}）` : `，退出码 ${code}`}\n`);
            this.child = null;
            this.action = '';
            this.startedAt = null;
            this.emit('state', this.getState());
            this.emit('finished', { action, code, signal });
        });
        return this.getState();
    }

    async stop() {
        const child = this.child;
        if (!child) return false;
        const pid = child.pid;
        this.appendLog('[桌面助手] 正在停止任务及其子进程…\n');
        await new Promise(resolve => {
            const killer = process.platform === 'win32'
                ? spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
                : null;
            if (killer) {
                killer.on('close', resolve);
                killer.on('error', () => {
                    child.kill('SIGTERM');
                    resolve();
                });
            } else {
                child.kill('SIGTERM');
                resolve();
            }
        });
        return true;
    }
}

module.exports = { EngineManager, sanitizeLog, createLoginQr };
