const api = window.lotteryDesktop;
let appState = null;
let toastTimer = null;
let outputLines = 1;

const pageMeta = {
    dashboard: ['控制台', '让重复操作有序运行，让每一步都看得见'],
    summaries: ['每日汇总', '定向读取 UP 汇总，按条目查看互动抽奖和预约抽奖'],
    sources: ['监控来源', '决定从哪里发现动态，以及扫描多大范围'],
    interaction: ['互动策略', '先明确会做什么，再决定以什么节奏运行'],
    account: ['账号与引擎', '账号凭证留在本地，外置源码可以独立更新'],
    logs: ['运行日志', '每一次启动、停止与异常都有迹可循'],
    about: ['关于与许可', '了解软件结构、开源许可与使用边界']
};

const actionNames = {
    start: '自动抽奖', summary: '汇总读取', cleanup: '转发清理预览', check: '中奖检查', login: '扫码登录',
    account: '账号检查', update: '更新检查', help: '帮助信息'
};

function $(selector) { return document.querySelector(selector); }
function $all(selector) { return [...document.querySelectorAll(selector)]; }

function showToast(message, error = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function navigate(page) {
    if (!pageMeta[page]) return;
    $all('.page').forEach(item => item.classList.toggle('active', item.id === `page-${page}`));
    $all('.nav-item[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === page));
    $('#page-title').textContent = pageMeta[page][0];
    $('#page-subtitle').textContent = pageMeta[page][1];
    $('.main').scrollTo({ top: 0, behavior: 'smooth' });
}

function fillForms() {
    if (!appState) return;
    $all('[data-setting]').forEach(field => {
        const value = appState.settings[field.dataset.setting];
        if (field.type === 'checkbox') field.checked = Boolean(value);
        else field.value = value ?? '';
    });
}

function collectSettings() {
    const settings = { ...appState.settings };
    $all('[data-setting]').forEach(field => {
        settings[field.dataset.setting] = field.type === 'checkbox' ? field.checked : field.value;
    });
    return settings;
}

function updateState(state, refill = true) {
    appState = state;
    if (refill) fillForms();
    const { account, engine, process: proc, settings } = state;
    $('#stat-account').textContent = account.loggedIn ? '已登录' : (account.hasUid ? '待扫码' : '未登录');
    $('#stat-uid').textContent = account.uid ? `UID ${account.uid}` : '填写 UID 后扫码登录';
    $('#stat-engine').textContent = engine.valid ? '已连接' : '待配置';
    $('#stat-version').textContent = engine.valid ? `LotteryAutoScript v${engine.version}` : '选择源码目录';
    $('#stat-mode').textContent = settings.dryRun ? '模拟运行' : '真实互动';
    $('#stat-mode').style.color = settings.dryRun ? '' : '#d84f62';

    $('#account-title').textContent = account.loggedIn ? '账号凭证已配置' : '尚未完成登录';
    $('#account-detail').textContent = account.uid ? `UID ${account.uid} · Cookie 仅保存在本地` : '先填写 UID 并保存，再开始扫码';
    $('#account-badge').textContent = account.loggedIn ? '已登录' : '离线';
    $('#account-badge').classList.toggle('online', account.loggedIn);

    $('#enginePath').value = engine.path || '';
    $('#engine-state').classList.toggle('invalid', !engine.valid || !engine.dependencies);
    $('#engine-state span:last-child').textContent = engine.message;
    $('#engine-details').textContent = engine.valid
        ? `版本 ${engine.version} · ${engine.dependencies ? '依赖完整' : '缺少依赖'} · ${engine.path}`
        : '请选择包含 main.js、package.json 和配置模板的 LotteryAutoScript 目录';
    $('#root-path').textContent = `软件目录：${state.rootDir}`;
    $('#app-version').textContent = state.version;
    renderSummary(state.summaryPreview);
    renderCleanup(state.cleanupPreview);
    updateProcess(proc);
}

function renderSummary(report) {
    const items = report?.items || [];
    const ready = items.filter(i => i.drawAt && Date.parse(i.drawAt) > Date.now()).length;
    $('#summary-status').textContent = report?.fetchedAt
        ? `${new Date(report.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 读取 · 共 ${items.length} 条 · 未到期 ${ready} 条；启动后逐条读取必要参数并处理`
        : '尚未读取汇总';
    const sourceBox = $('#summary-sources');
    sourceBox.replaceChildren();
    for (const source of report?.sources || []) {
        const button = document.createElement('button');
        button.className = 'text-button'; button.textContent = source.title;
        button.addEventListener('click', () => api.openExternal(source.url).catch(e => showToast(e.message, true)));
        sourceBox.append(button);
    }
    const body = $('#summary-items'); body.replaceChildren();
    for (const item of items) {
        const row = document.createElement('tr');
        const status = !item.drawAt ? '时间待核实' : Date.parse(item.drawAt) <= Date.now() ? '已到期' : '待处理';
        for (const text of [item.kind === 'reserve' ? '预约' : '互动', item.name,
            item.drawAt?.replace('T', ' ').replace('+08:00', '') || '未知', status]) {
            const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
        }
        const prize = document.createElement('small'); prize.textContent = item.prize || '';
        row.children[1].append(prize);
        const cell = document.createElement('td'), button = document.createElement('button');
        button.className = 'text-button'; button.textContent = '查看原动态';
        button.addEventListener('click', () => api.openExternal(item.url).catch(e => showToast(e.message, true)));
        cell.append(button); row.append(cell); body.append(row);
    }
}

function renderCleanup(report) {
    $('#cleanup-status').textContent = report?.checkedAt
        ? `${new Date(report.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 检查 · 候选 ${report.items?.length || 0} 条 · 已删除 ${report.deleted || 0} 条${report.previewOnly ? ' · 仅预览' : ''}`
        : '尚未预览。只处理新版记录了准确转发 ID 的动态，无法可靠对应的旧动态会保留。';
    const box = $('#cleanup-items'); box.replaceChildren();
    for (const item of report?.items || []) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
        button.textContent = `转发 ${item.repostId} · 开奖 ${item.drawAt.replace('T', ' ').replace('+08:00', '')}`;
        button.addEventListener('click', () => api.openExternal(item.url).catch(e => showToast(e.message, true)));
        box.append(button);
    }
}

function updateProcess(proc) {
    const running = proc.running;
    if (!running || proc.action !== 'login') {
        $('#login-qr-dialog').close();
        $('#login-qr-image').removeAttribute('src');
    }
    $('#process-pill').classList.toggle('running', running);
    $('#process-text').textContent = running ? `${actionNames[proc.action] || proc.action}运行中` : '空闲';
    $('#btn-start').classList.toggle('hidden', running);
    $('#btn-stop').classList.toggle('hidden', !running);
    $all('.action-button, #btn-start, #btn-choose-engine').forEach(button => { button.disabled = running; });
    $all('form input, form textarea, form select, form button[type="submit"]').forEach(field => { field.disabled = running; });
    $('#btn-summary-start').disabled = running || !$('#summarySource').checked;
}

async function refresh(refill = true) {
    try {
        updateState(await api.bootstrap(), refill);
    } catch (error) {
        showToast(error.message, true);
    }
}

async function saveSettings(showMessage = true) {
    const state = await api.saveSettings(collectSettings());
    updateState(state);
    if (showMessage) showToast('设置已保存到软件 data 目录');
    return state;
}

async function runAction(action) {
    try {
        await saveSettings(false);
        if (action === 'start' && !appState.settings.dryRun) {
            const cleanupNotice = appState.settings.cleanupExpired ? '\n本次还会删除已记录且开奖超过24小时的转发动态，保留名单中的动态除外。' : '';
            const approved = confirm(`真实模式可能自动关注、点赞、评论或转发。请确认已检查监控来源和互动策略，并承担平台风控风险。${cleanupNotice}\n\n确定启动真实互动吗？`);
            if (!approved) return;
        }
        await api.run(action);
        navigate('logs');
        appendOutput(`[桌面助手] 已请求执行：${actionNames[action] || action}\n`);
    } catch (error) {
        showToast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
    }
}

function appendOutput(text) {
    const output = $('#log-output');
    output.textContent += text;
    outputLines += String(text).split('\n').length - 1;
    $('#log-count').textContent = `${outputLines} 条输出`;
    if ($('#auto-scroll').checked) output.scrollTop = output.scrollHeight;
}

$all('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
$all('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)));
$all('.settings-form').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    try { await saveSettings(); } catch (error) { showToast(error.message, true); }
}));
$all('.action-button[data-action]').forEach(button => button.addEventListener('click', () => runAction(button.dataset.action)));
$('#btn-summary-preview').addEventListener('click', async () => {
    try {
        await saveSettings(false);
        await api.previewSummaries();
        await refresh(false);
        showToast('汇总已读取，预览不会执行互动');
    } catch (error) { showToast(error.message, true); }
});
$('#summarySource').addEventListener('change', () => updateProcess(appState.process));
$('#btn-cleanup-preview').addEventListener('click', async () => {
    try {
        await saveSettings(false);
        await api.previewCleanup();
        await refresh(false);
        showToast('清理预览已更新，尚未删除动态');
    } catch (error) { showToast(error.message, true); }
});
$('#btn-start').addEventListener('click', () => runAction('start'));
$('#btn-stop').addEventListener('click', async () => {
    try { await api.stop(); } catch (error) { showToast(error.message, true); }
});
$('#btn-choose-engine').addEventListener('click', async () => {
    try { updateState(await api.chooseEngine()); showToast('源码目录已更新，请保存一次设置'); }
    catch (error) { showToast(error.message, true); }
});
$('#btn-open-engine').addEventListener('click', () => api.openPath('engine').catch(error => showToast(error.message, true)));
$('#btn-open-data').addEventListener('click', () => api.openPath('data').catch(error => showToast(error.message, true)));
$('#btn-open-config').addEventListener('click', () => api.openPath('config').catch(error => showToast(error.message, true)));
$('#btn-open-logs').addEventListener('click', () => api.openPath('logs').catch(error => showToast(error.message, true)));
$('#btn-clear-log').addEventListener('click', () => {
    $('#log-output').textContent = '[桌面助手] 显示已清空，不影响磁盘日志。\n';
    outputLines = 1;
    $('#log-count').textContent = '1 条输出';
});
$all('[data-url]').forEach(button => button.addEventListener('click', () => api.openExternal(button.dataset.url).catch(error => showToast(error.message, true))));

document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveSettings().catch(error => showToast(error.message, true));
    }
});

async function cancelLogin() {
    try {
        await api.stop();
        $('#login-qr-dialog').close();
        $('#login-qr-image').removeAttribute('src');
    } catch (error) { showToast(error.message, true); }
}

$('#btn-cancel-login').addEventListener('click', cancelLogin);
$('#login-qr-dialog').addEventListener('cancel', event => {
    event.preventDefault();
    cancelLogin();
});
api.onQrCode(image => {
    if (!appState?.process.running || appState.process.action !== 'login') return;
    if (!/^data:image\/png;base64,/.test(image)) return;
    $('#login-qr-image').src = image;
    const dialog = $('#login-qr-dialog');
    if (!dialog.open) dialog.showModal();
});
api.onOutput(appendOutput);
api.onState(state => {
    if (appState) appState.process = state;
    updateProcess(state);
    if (!state.running) setTimeout(() => refresh(false), 300);
});

refresh();
