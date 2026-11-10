const fs = require('fs');
const path = require('path');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const DEFAULT_SETTINGS = Object.freeze({
    enginePath: '',
    summarySource: false,
    summaryUid: '492426375',
    cleanupExpired: false,
    cleanupKeepIds: '',
    uid: '',
    note: '我的B站账号',
    uids: '',
    tags: '互动抽奖',
    articles: '抽奖合集',
    model: '10',
    chatmodel: '00',
    disableReserve: false,
    waitSeconds: 30,
    searchWaitMs: 2000,
    loopMinutes: 0,
    maxCreateDays: 14,
    maxDrawDays: 30,
    minFollower: 1000,
    uidPages: 3,
    tagPages: 3,
    articlePages: 3,
    relayText: '转发动态',
    chatText: '参与一下',
    dryRun: true,
    onlyFollowed: false,
    logLevel: 3
});

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = {}) {
    try {
        return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
        return { ...fallback };
    }
}

function writeJsonAtomic(file, value) {
    ensureDir(path.dirname(file));
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
}

function splitList(value, numeric = false) {
    const items = String(value || '')
        .split(/[\n,，;；]+/)
        .map(item => item.trim())
        .filter(Boolean);
    if (!numeric) return [...new Set(items)];
    return [...new Set(items.map(item => {
        if (!/^\d+$/.test(item)) throw new Error(`UID 只能填写数字：${item}`);
        return Number(item);
    }))];
}

function boundedInt(value, name, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new Error(`${name}应为 ${min} 到 ${max} 之间的整数`);
    }
    return number;
}

function normalizeSettings(input = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...input };
    const cleanupKeepIds = String(settings.cleanupKeepIds || '').trim();
    if (splitList(cleanupKeepIds).some(id => !/^\d+$/.test(id))) throw new Error('清理保留名单只能填写数字动态 ID');
    return {
        ...settings,
        enginePath: String(settings.enginePath || '').trim(),
        summarySource: settings.summarySource === true,
        summaryUid: String(settings.summaryUid || '492426375').trim(),
        cleanupExpired: settings.cleanupExpired === true,
        cleanupKeepIds,
        uid: String(settings.uid || '').trim(),
        uids: String(settings.uids || '').trim(),
        tags: String(settings.tags || '').trim(),
        articles: String(settings.articles || '').trim(),
        waitSeconds: boundedInt(settings.waitSeconds, '转发间隔', 10, 3600),
        searchWaitMs: boundedInt(settings.searchWaitMs, '检索间隔', 1000, 60000),
        loopMinutes: boundedInt(settings.loopMinutes, '循环间隔', 0, 10080),
        maxCreateDays: boundedInt(settings.maxCreateDays, '动态时间范围', 1, 365),
        maxDrawDays: boundedInt(settings.maxDrawDays, '开奖时间范围', 0, 3650),
        minFollower: boundedInt(settings.minFollower, '最低粉丝数', 0, 1000000000),
        uidPages: boundedInt(settings.uidPages, 'UID 扫描页数', 1, 20),
        tagPages: boundedInt(settings.tagPages, '话题扫描页数', 1, 20),
        articlePages: boundedInt(settings.articlePages, '专栏扫描页数', 1, 20),
        logLevel: boundedInt(settings.logLevel, '日志等级', 0, 4),
        dryRun: settings.dryRun !== false,
        disableReserve: Boolean(settings.disableReserve),
        onlyFollowed: Boolean(settings.onlyFollowed)
    };
}

function validateEngine(enginePath) {
    const result = {
        valid: false,
        path: enginePath || '',
        version: '',
        dependencies: false,
        message: ''
    };
    if (!enginePath) {
        result.message = '请选择 LotteryAutoScript 源码目录';
        return result;
    }
    const mainFile = path.join(enginePath, 'main.js');
    const packageFile = path.join(enginePath, 'package.json');
    const envTemplate = path.join(enginePath, 'env.example.js');
    const configTemplate = path.join(enginePath, 'my_config.example.js');
    if (![mainFile, packageFile, envTemplate, configTemplate].every(file => fs.existsSync(file))) {
        result.message = '目录缺少 main.js、package.json 或配置模板';
        return result;
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        result.version = pkg.version || '未知';
        result.dependencies = fs.existsSync(path.join(enginePath, 'node_modules', 'chalk'))
            && fs.existsSync(path.join(enginePath, 'node_modules', '@catlair', 'blogin'));
        result.valid = true;
        result.message = result.dependencies ? '源码与运行依赖已就绪' : '源码有效，但缺少 node_modules 依赖';
    } catch (error) {
        result.message = `源码检查失败：${error.message}`;
    }
    return result;
}

function extractCookie(runtimeDir) {
    const envFile = path.join(runtimeDir, 'env.js');
    if (!fs.existsSync(envFile)) return '';
    const text = fs.readFileSync(envFile, 'utf8');
    const match = text.match(/COOKIE['"]?\s*:\s*(['"])(.*?)\1/s);
    return match ? match[2] : '';
}

function accountStatus(runtimeDir) {
    const cookie = extractCookie(runtimeDir);
    const uid = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/i)?.[1] || '';
    const hasSession = /(?:^|;\s*)SESSDATA=[^;]+/i.test(cookie);
    return { uid, loggedIn: Boolean(uid && hasSession), hasUid: Boolean(uid) };
}

function freshRequire(file) {
    delete require.cache[require.resolve(file)];
    return require(file);
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    }
    return value;
}

function serialize(value, level = 0) {
    const pad = '    '.repeat(level);
    const childPad = '    '.repeat(level + 1);
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        return `[\n${value.map(item => `${childPad}${serialize(item, level + 1)}`).join(',\n')}\n${pad}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (!entries.length) return '{}';
        return `{\n${entries.map(([key, item]) => `${childPad}${JSON.stringify(key)}: ${serialize(item, level + 1)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(value);
}

function buildConfigs(enginePath, runtimeDir, rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const engine = validateEngine(enginePath);
    if (!engine.valid) throw new Error(engine.message);
    if (settings.uid && !/^\d+$/.test(settings.uid)) throw new Error('B站 UID 只能填写数字');

    const UIDs = splitList(settings.uids, true);
    const TAGs = splitList(settings.tags).map(tag => tag.replace(/^#|#$/g, ''));
    const Articles = splitList(settings.articles);
    if (settings.summarySource && !/^\d+$/.test(settings.summaryUid)) throw new Error('汇总 UP 的 UID 只能填写数字');
    if (!settings.summarySource && !UIDs.length && !TAGs.length && !Articles.length) {
        throw new Error('至少配置一个监控来源：UID、话题或专栏关键词');
    }

    const env = clone(freshRequire(path.join(enginePath, 'env.example.js')));
    const currentCookie = extractCookie(runtimeDir);
    const currentUid = currentCookie.match(/(?:^|;\s*)DedeUserID=(\d+)/i)?.[1] || '';
    const cookie = currentCookie && (!settings.uid || currentUid === settings.uid)
        ? currentCookie
        : (settings.uid ? `DedeUserID=${settings.uid}` : '');

    env.account_parm = {
        ...env.account_parm,
        COOKIE: cookie,
        NOTE: settings.note,
        NUMBER: 1,
        CLEAR: false,
        ACCOUNT_UA: DEFAULT_UA,
        ENABLE_CHAT_CAPTCHA_OCR: false,
        ENABLE_AI_JUDGE: false,
        ENABLE_AI_COMMENTS: false,
        ENABLE_MULTIPLE_ACCOUNT: false,
        MULTIPLE_ACCOUNT_PARM: '',
        LOTTERY_LOG_LEVEL: settings.logLevel,
        NOT_GO_LOTTERY: settings.dryRun ? '1' : ''
    };
    env.multiple_account_parm = [];

    const config = clone(freshRequire(path.join(enginePath, 'my_config.example.js')));
    const overrides = {
        UIDs: settings.summarySource ? [] : UIDs,
        TAGs: settings.summarySource ? [] : TAGs,
        Articles: settings.summarySource ? [] : Articles,
        APIs: settings.summarySource ? ['file://up-summary.json'] : [],
        TxT: settings.summarySource ? [] : ['dyids.txt'],
        LotteryOrder: settings.summarySource ? [3] : [2, 0, 1],
        save_lottery_info_to_file: false,
        model: settings.model,
        chatmodel: settings.chatmodel,
        disable_reserve_lottery: settings.disableReserve,
        check_if_duplicated: 3,
        max_create_time: settings.summarySource ? Infinity : settings.maxCreateDays,
        maxday: settings.maxDrawDays === 0 ? Infinity : settings.maxDrawDays,
        uid_scan_page: settings.uidPages,
        tag_scan_page: settings.tagPages,
        article_scan_page: settings.articlePages,
        lottery_loop_wait: settings.summarySource ? 0 : settings.loopMinutes * 60 * 1000,
        check_loop_wait: 0,
        clear_loop_wait: 0,
        wait: settings.waitSeconds * 1000,
        search_wait: settings.searchWaitMs,
        minfollower: settings.minFollower,
        only_followed: settings.onlyFollowed,
        create_dy: false,
        at_users: [],
        relay: [settings.relayText || '转发动态'],
        chat: [settings.chatText || '参与一下'],
        is_repost_then_chat: false,
        is_copy_chat: false,
        clear_remove_dynamic: false,
        clear_remove_attention: false
    };
    config.default_config = { ...config.default_config, ...overrides };
    config.config_1 = { ...config.config_1, ...overrides };
    config.config_2 = {};
    config.config_3 = {};

    return {
        env: `// 由 BiliLotteryDesktop 生成。包含账号凭证时请勿分享。\nmodule.exports = Object.freeze(${serialize(env)});\n`,
        config: `// 由 BiliLotteryDesktop 生成。高级选项可在外置源码模板中查看。\nmodule.exports = Object.freeze(${serialize(config)});\n`,
        settings
    };
}

function saveConfigs(enginePath, runtimeDir, settings) {
    const output = buildConfigs(enginePath, runtimeDir, settings);
    ensureDir(runtimeDir);
    for (const [name, content] of [['env.js', output.env], ['my_config.js', output.config]]) {
        const file = path.join(runtimeDir, name);
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, content, 'utf8');
        fs.renameSync(temp, file);
    }
    return output.settings;
}

module.exports = {
    DEFAULT_UA,
    DEFAULT_SETTINGS,
    accountStatus,
    buildConfigs,
    ensureDir,
    extractCookie,
    normalizeSettings,
    readJson,
    saveConfigs,
    splitList,
    validateEngine,
    writeJsonAtomic
};
