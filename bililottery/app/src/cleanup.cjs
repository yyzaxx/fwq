const fs = require('fs');
const path = require('path');
const { setTimeout: pause } = require('timers/promises');
const { DEFAULT_UA, extractCookie, splitList, writeJsonAtomic } = require('./config.cjs');
const { officialRequest } = require('./summaries.cjs');
const DAY = 86400000;
const dynamicId = value => typeof value === 'string' && /^\d{18,}$/.test(value);
const stamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

function readLedger(runtime) {
    const file = path.join(runtime, 'repost-ledger.json');
    if (!fs.existsSync(file)) return { version: 1, records: [] };
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.records)) throw new Error();
        return data;
    } catch { throw new Error('转发清理记录损坏，已停止自动清理'); }
}

function recordRepost(runtime, entry) {
    if (!dynamicId(entry.repostId) || !dynamicId(entry.originalId) || !dynamicId(entry.sourceId) || entry.repostId === entry.originalId
        || !/^\d+$/.test(String(entry.ownerUid)) || !/^\d+$/.test(String(entry.summaryUid)) || !Number.isFinite(stamp(entry.drawAt))) {
        throw new Error('转发清理记录缺少准确的 ID 或开奖时间');
    }
    const ledger = readLedger(runtime);
    if (ledger.records.some(r => r.repostId === entry.repostId)) return;
    ledger.records.push({ ...entry, ownerUid: String(entry.ownerUid), summaryUid: String(entry.summaryUid),
        createdAt: entry.createdAt || new Date().toISOString(), deletedAt: null });
    writeJsonAtomic(path.join(runtime, 'repost-ledger.json'), ledger);
}

function installRepostTracking(http, runtime, { uid, summaryUid, tasks, simulation, onOutput = () => {} }) {
    if (simulation) return;
    const send = http.send;
    const byOriginal = new Map(tasks.map(t => [t.dyid, t]));
    http.send = function (request) {
        if (request.url !== 'https://api.bilibili.com/x/dynamic/feed/create/dyn' || String(request.method).toUpperCase() !== 'POST') {
            return send.apply(this, arguments);
        }
        const task = byOriginal.get(request.contents?.web_repost_src?.dyn_id_str);
        if (!task) return send.apply(this, arguments);
        const success = request.success;
        return send.call(this, { ...request, success: response => {
            try {
                const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
                const result = JSON.parse(text);
                if (result.code === 0 && (result.data?.result == null || result.data.result === 0)) {
                    const id = result.data?.dyn_id_str || (typeof result.data?.dyn_id === 'string' ? result.data.dyn_id
                        : text.match(/"dyn_id"\s*:\s*(\d{18,})/)?.[1]);
                    if (dynamicId(id)) {
                        recordRepost(runtime, { ownerUid: String(uid), summaryUid: String(summaryUid), originalId: task.dyid,
                            repostId: id, sourceId: task.sourceId, drawAt: task.drawAt });
                    } else onOutput('[自动清理] 转发已成功，但响应缺少新动态 ID，本条保留\n');
                }
            } catch { onOutput('[自动清理] 转发响应未保存为清理记录，本条保留\n'); }
            success?.(response);
        } });
    };
}

async function previewExpiredReposts(runtime, settings, options = {}) {
    options.signal?.throwIfAborted();
    const now = options.now ?? Date.now();
    const keep = new Set(splitList(settings.cleanupKeepIds));
    const records = readLedger(runtime).records.filter(r => !r.deletedAt && dynamicId(r.repostId) && dynamicId(r.originalId) && dynamicId(r.sourceId)
        && r.repostId !== r.originalId && r.ownerUid === String(settings.uid) && r.summaryUid === String(settings.summaryUid)
        && Number.isFinite(stamp(r.drawAt)) && now - stamp(r.drawAt) > DAY && !keep.has(r.repostId) && !keep.has(r.originalId));
    const report = { checkedAt: new Date(now).toISOString(), items: [], skipped: 0, deleted: 0, previewOnly: true };
    if (records.length) {
        const cookie = extractCookie(runtime), request = options.request || officialRequest;
        const localUid = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/)?.[1];
        if (localUid !== String(settings.uid)) throw new Error('清理账号与本地凭证不一致，已停止');
        const account = await request('/x/web-interface/nav', cookie, options.signal);
        if (!account?.isLogin || String(account.mid) !== String(settings.uid)) throw new Error('清理账号核对失败，已停止');
        for (const [index, record] of records.entries()) {
            options.signal?.throwIfAborted();
            if (index) await pause(options.interval ?? Math.max(2000, Number(settings.searchWaitMs) || 2000), undefined, { signal: options.signal });
            let data;
            try { data = await request(`/x/polymer/web-dynamic/v1/detail?id=${record.repostId}&features=itemOpusStyle`, cookie, options.signal); }
            catch (error) {
                if ([-404, 4101131, 4101152].includes(error.code)) {
                    report.skipped++;
                    options.onOutput?.(`[自动清理] 转发 ${record.repostId} 不存在或不可见，跳过删除并保留记录\n`);
                    continue;
                }
                throw error;
            }
            const item = data?.item;
            if (item?.id_str !== record.repostId || item.type !== 'DYNAMIC_TYPE_FORWARD'
                || String(item.modules?.module_author?.mid) !== String(settings.uid) || item.orig?.id_str !== record.originalId) {
                report.skipped++; continue;
            }
            report.items.push({ repostId: record.repostId, originalId: record.originalId, drawAt: record.drawAt,
                ownerUid: record.ownerUid, summaryUid: record.summaryUid, url: `https://t.bilibili.com/${record.repostId}` });
        }
    }
    options.signal?.throwIfAborted();
    writeJsonAtomic(path.join(runtime, 'cleanup-preview.json'), report);
    return report;
}

async function deleteRepost(id, cookie, signal) {
    if (!dynamicId(id)) throw new Error('删除动态 ID 无效');
    signal?.throwIfAborted();
    const csrf = cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
    if (!csrf) throw new Error('登录凭证缺少 CSRF，无法删除动态');
    const response = await fetch(`https://api.bilibili.com/x/dynamic/feed/operate/remove?platform=web&csrf=${encodeURIComponent(csrf)}`, {
        method: 'POST', headers: { Cookie: cookie, 'User-Agent': DEFAULT_UA, Referer: 'https://www.bilibili.com/', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dyn_id_str: id }), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`删除动态失败：HTTP ${response.status}，已停止`);
    let result;
    try { result = await response.json(); } catch { throw new Error('删除接口响应无效，已停止'); }
    if (result.code !== 0) throw new Error(`删除动态返回 ${result.code}，已停止`);
}

async function cleanupExpiredReposts(runtime, settings, options = {}) {
    options.signal?.throwIfAborted();
    if (!settings.cleanupExpired) return { items: [], deleted: 0, disabled: true };
    const report = await previewExpiredReposts(runtime, settings, options);
    options.onOutput?.(`[自动清理] 找到 ${report.items.length} 条开奖超过24小时的已记录转发\n`);
    if (settings.dryRun || options.previewOnly) return report;
    const cookie = extractCookie(runtime), remove = options.remove || deleteRepost;
    for (const [index, item] of report.items.entries()) {
        options.signal?.throwIfAborted();
        if (index) await pause(options.interval ?? Math.max(2000, Number(settings.searchWaitMs) || 2000), undefined, { signal: options.signal });
        await remove(item.repostId, cookie, options.signal);
        const ledger = readLedger(runtime);
        const record = ledger.records.find(r => r.repostId === item.repostId && r.ownerUid === item.ownerUid && r.originalId === item.originalId);
        if (!record) throw new Error('删除后清理记录不匹配，已停止后续操作');
        record.deletedAt = new Date(options.now ?? Date.now()).toISOString();
        writeJsonAtomic(path.join(runtime, 'repost-ledger.json'), ledger);
        report.deleted++;
        report.previewOnly = false;
        writeJsonAtomic(path.join(runtime, 'cleanup-preview.json'), report);
        options.onOutput?.(`[自动清理] 已删除转发 ${item.repostId}\n`);
    }
    return report;
}

module.exports = { recordRepost, installRepostTracking, previewExpiredReposts, cleanupExpiredReposts, deleteRepost };
