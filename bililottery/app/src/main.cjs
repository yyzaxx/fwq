const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const {
    DEFAULT_SETTINGS,
    accountStatus,
    ensureDir,
    readJson,
    saveConfigs,
    validateEngine,
    writeJsonAtomic
} = require('./config.cjs');
const { EngineManager, createLoginQr } = require('./engine.cjs');
const { collectSummaries, prepareSummaryQueue } = require('./summaries.cjs');
const { previewExpiredReposts, cleanupExpiredReposts } = require('./cleanup.cjs');

const isPackaged = app.isPackaged;
const rootDir = isPackaged
    ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
    : path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const runtimeDir = path.join(dataDir, 'runtime');
const logsDir = path.join(rootDir, 'logs');
const settingsFile = path.join(dataDir, 'settings.json');

ensureDir(runtimeDir);
ensureDir(logsDir);
app.setPath('userData', path.join(dataDir, 'electron'));
app.setPath('crashDumps', path.join(dataDir, 'crash-dumps'));

let settings = readJson(settingsFile, DEFAULT_SETTINGS);
if (!settings.enginePath) {
    const bundledExternal = path.join(rootDir, 'engine', 'LotteryAutoScript');
    settings.enginePath = fs.existsSync(bundledExternal) ? bundledExternal : '';
}
const manager = new EngineManager(logsDir);
let preparation = null;
let mainWindow = null;
const smokeTest = process.env.BILI_DESKTOP_SMOKE === '1' || process.argv.includes('--smoke-test');

function currentProcess() {
    return preparation ? { running: true, action: preparation.action, startedAt: preparation.startedAt } : manager.getState();
}

function publicState() {
    return {
        rootDir,
        runtimeDir,
        settings,
        engine: validateEngine(settings.enginePath),
        account: accountStatus(runtimeDir),
        process: currentProcess(),
        summaryPreview: readJson(path.join(runtimeDir, 'summary-preview.json'), { sources: [], items: [] }),
        cleanupPreview: readJson(path.join(runtimeDir, 'cleanup-preview.json'), { items: [], deleted: 0 }),
        version: app.getVersion()
    };
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function withPreparation(work, action = 'summary') {
    if (currentProcess().running) throw new Error('已有任务正在运行，请先停止');
    const controller = new AbortController();
    preparation = { controller, action, startedAt: Date.now() };
    send('engine:state', currentProcess());
    try {
        return await work({ signal: controller.signal, onOutput: text => manager.appendLog(text) });
    } finally {
        preparation = null;
        send('engine:state', currentProcess());
    }
}

let lastLoginQrUrl = '';
manager.on('output', text => {
    send('engine:output', text);
    if (manager.action !== 'login') return;
    const loginChild = manager.child;
    createLoginQr(settings.enginePath, text).then(qr => {
        if (!qr || manager.child !== loginChild || qr.url === lastLoginQrUrl) return;
        lastLoginQrUrl = qr.url;
        send('engine:qrcode', qr.image);
    }).catch(error => send('engine:output', `[桌面助手] 二维码图片生成失败：${error.message}\n`));
});
manager.on('state', state => {
    if (!state.running) lastLoginQrUrl = '';
    send('engine:state', state);
    if (!state.running) send('engine:output', `[桌面助手] 账号状态：${accountStatus(runtimeDir).loggedIn ? '已登录' : '未登录或凭证不完整'}\n`);
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1220,
        height: 800,
        minWidth: 980,
        minHeight: 680,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#f6f7fb',
        title: 'Bili抽奖助手 · 绿色版',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: !isPackaged
        }
    });
    mainWindow.setMenu(null);
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.once('ready-to-show', () => {
        if (!smokeTest) mainWindow.show();
    });
    if (smokeTest) {
        mainWindow.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                try {
                    const testDir = path.join(rootDir, 'test');
                    ensureDir(testDir);
                    const report = await mainWindow.webContents.executeJavaScript(`({
                        title: document.title,
                        pages: document.querySelectorAll('.page').length,
                        navigation: document.querySelectorAll('.nav-item[data-page]').length,
                        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                        engineText: document.getElementById('engine-state').textContent,
                        accountText: document.getElementById('stat-account').textContent
                    })`);
                    const dashboard = await mainWindow.webContents.capturePage();
                    fs.writeFileSync(path.join(testDir, 'dashboard.png'), dashboard.toPNG());
                    await mainWindow.webContents.executeJavaScript("document.querySelector('[data-page=\"sources\"]').click()");
                    const sources = await mainWindow.webContents.capturePage();
                    fs.writeFileSync(path.join(testDir, 'sources.png'), sources.toPNG());
                    writeJsonAtomic(path.join(testDir, 'smoke-report.json'), report);
                    console.log('SMOKE_TEST', JSON.stringify(report));
                    app.exit(0);
                } catch (error) {
                    console.error('SMOKE_TEST_FAILED', error);
                    app.exit(1);
                }
            }, 1200);
        });
    }
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
ipcMain.handle('app:bootstrap', () => publicState());

ipcMain.handle('settings:save', (_event, input) => {
    if (currentProcess().running) throw new Error('任务运行中不能修改配置');
    settings = saveConfigs(settings.enginePath, runtimeDir, { ...settings, ...input });
    writeJsonAtomic(settingsFile, settings);
    return publicState();
});

ipcMain.handle('engine:choose', async () => {
    if (currentProcess().running) throw new Error('任务运行中不能更换源码');
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 LotteryAutoScript 源码目录',
        defaultPath: settings.enginePath || rootDir,
        properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return publicState();
    const selected = result.filePaths[0];
    const info = validateEngine(selected);
    if (!info.valid) throw new Error(info.message);
    settings.enginePath = selected;
    writeJsonAtomic(settingsFile, settings);
    return publicState();
});

ipcMain.handle('summaries:preview', () => withPreparation(async options => {
    await collectSummaries(runtimeDir, settings, options);
    return publicState();
}));

ipcMain.handle('cleanup:preview', () => withPreparation(async options => {
    await previewExpiredReposts(runtimeDir, settings, options);
    return publicState();
}, 'cleanup'));

ipcMain.handle('engine:run', async (_event, action) => {
    if (currentProcess().running) throw new Error('已有任务正在运行，请先停止');
    if (['start', 'check', 'account'].includes(action)) {
        const account = accountStatus(runtimeDir);
        if (!account.loggedIn && action !== 'start') throw new Error('请先扫码登录账号');
        if (action === 'start' && !account.hasUid) throw new Error('请先在账号设置中填写 UID 并保存');
    }
    if (action === 'start' && settings.summarySource) {
        return withPreparation(async options => {
            if (settings.cleanupExpired) await cleanupExpiredReposts(runtimeDir, settings, options);
            const report = await collectSummaries(runtimeDir, settings, options);
            await prepareSummaryQueue(report, settings.enginePath, runtimeDir, settings, options);
            options.signal.throwIfAborted();
            const workerDir = path.join(runtimeDir, 'desktop-worker');
            ensureDir(workerDir);
            for (const name of ['summary-runner.cjs', 'summaries.cjs', 'config.cjs', 'cleanup.cjs']) {
                fs.copyFileSync(path.join(__dirname, name), path.join(workerDir, name));
            }
            return manager.run(action, { enginePath: settings.enginePath, runtimeDir, runnerEntry: path.join(workerDir, 'summary-runner.cjs') });
        });
    }
    return manager.run(action, { enginePath: settings.enginePath, runtimeDir });
});

ipcMain.handle('engine:stop', () => {
    if (preparation) { preparation.controller.abort(new Error('已取消汇总任务')); return true; }
    return manager.stop();
});

ipcMain.handle('path:open', async (_event, target) => {
    const paths = {
        root: rootDir,
        data: dataDir,
        logs: logsDir,
        engine: settings.enginePath,
        config: path.join(runtimeDir, 'my_config.js')
    };
    const targetPath = paths[target];
    if (!targetPath || !fs.existsSync(targetPath)) throw new Error('目标路径不存在');
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return true;
});

ipcMain.handle('url:open', async (_event, url) => {
    const allowed = [
        'https://github.com/shanmiteko/LotteryAutoScript',
        'https://www.bilibili.com/',
        'https://t.bilibili.com/',
        'https://www.gnu.org/licenses/gpl-3.0'
    ];
    if (!allowed.some(prefix => url.startsWith(prefix))) throw new Error('不允许打开该链接');
    await shell.openExternal(url);
    return true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

let allowQuit = false;
app.on('before-quit', event => {
    preparation?.controller.abort(new Error('程序退出，已取消汇总任务'));
    if (manager.getState().running && !allowQuit) {
        event.preventDefault();
        manager.stop().finally(() => {
            allowQuit = true;
            app.quit();
        });
    }
});
