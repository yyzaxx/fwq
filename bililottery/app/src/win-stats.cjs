const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { extractCookie, writeJsonAtomic } = require('./config.cjs');
const { requestBili, verifyAccount } = require('./bili-api.cjs');

const WINDOW = 7 * 24 * 3600000;
const FRESH_FOR = 30 * 60000;
const PAGE_SIZE = 20;
const SOURCES = new Set(['system', 'reply', 'at', 'dm']);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const cacheFile = runtime => path.join(runtime, 'win-stats.json');
const clock = value => {
    const result = typeof value === 'function' ? value() : value ?? Date.now();
    const number = result instanceof Date ? result.getTime() : Number(result);
    if (!Number.isFinite(number)) throw new Error('统计时间无效');
    return number;
};
const stableId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
const uidOf = value => /^[1-9]\d{0,21}$/.test(String(value ?? '')) ? String(value) : '';
const yes = value => value === true || value === 1;
const no = value => value === false || value === 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function readCache(runtime) {
    try {
        const data = JSON.parse(fs.readFileSync(cacheFile(runtime), 'utf8'));
        if (data.version === 1 && data.accounts && typeof data.accounts === 'object' && !Array.isArray(data.accounts)) return data;
    } catch { /* Missing or invalid cache is unknown until a complete scan. */ }
    return { version: 1, accounts: {} };
}

function localScope(runtime, settings) {
    const uid = uidOf(settings?.uid);
    const cookie = extractCookie(runtime);
    const localUid = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/i)?.[1] || '';
    return { uid, mismatch: Boolean(localUid && uid !== localUid),
        loggedIn: localUid === uid && /(?:^|;\s*)SESSDATA=[^;]+/i.test(cookie) };
}

function activeEvents(events, now) {
    return (Array.isArray(events) ? events : []).filter(event => event && /^[a-f0-9]{64}$/.test(event.fingerprint)
        && SOURCES.has(event.source) && Number.isFinite(event.time) && event.time >= now - WINDOW && event.time <= now
        && (!event.activityFingerprint || /^[a-f0-9]{64}$/.test(event.activityFingerprint))
        && (!event.observationFingerprint || /^[a-f0-9]{64}$/.test(event.observationFingerprint)));
}

function mergeEvents(...groups) {
    const result = new Map();
    for (const events of groups) for (const event of events) {
        const previous = result.get(event.fingerprint);
        result.set(event.fingerprint, previous?.activityFingerprint ? previous : event);
    }
    const events = [...result.values()];
    const identified = new Set(events.filter(event => event.reliable === true && event.observationFingerprint)
        .map(event => event.observationFingerprint));
    return events.filter(event => event.reliable !== false || !identified.has(event.observationFingerprint));
}

function eventCount(events) {
    return new Set(events.map(event => event.activityFingerprint || event.fingerprint)).size;
}

function summary(entry, scope, now) {
    const windowStart = new Date(now - WINDOW).toISOString();
    const result = { count: null, status: 'unknown', updatedAt: null, windowDays: 7, windowStart,
        windowEnd: new Date(now).toISOString() };
    if (!scope.uid || scope.mismatch) return { ...result, message: '请核对当前账号后刷新中奖统计' };
    const completedAt = typeof entry?.completedAt === 'string' ? Date.parse(entry.completedAt) : NaN;
    const complete = Number.isFinite(completedAt) && Array.isArray(entry.events);
    const events = activeEvents(entry?.events, now);
    const pending = activeEvents(entry?.pendingEvents, now);
    const detectedCount = eventCount(mergeEvents(events, pending));
    if (complete) {
        result.count = eventCount(events);
        result.updatedAt = new Date(completedAt).toISOString();
        result.status = scope.loggedIn && entry.lastAttemptComplete === true && now >= completedAt
            && now - completedAt < FRESH_FOR ? 'ok' : 'stale';
    }
    if (result.status !== 'ok') {
        result.detectedCount = detectedCount;
        result.message = complete ? '统计未完成或已过期，显示上次完整统计；请刷新'
            : '尚未完成最近七天通知扫描，中奖次数未知';
    }
    if (entry?.lastAttemptAt) result.attemptedAt = entry.lastAttemptAt;
    if (entry?.cancelled) {
        result.cancelled = true;
        result.message = complete ? '统计已停止，显示上次完整统计' : '统计已停止，中奖次数未知';
    }
    return result;
}

function readWins(runtime, settings, { now } = {}) {
    const scope = localScope(runtime, settings);
    return summary(readCache(runtime).accounts[scope.uid], scope, clock(now));
}

// Bilibili system notification strings are Shanghai local time, even when
// this process runs in UTC. Do not feed unzoned strings to Date.parse.
function notificationTime(value, unit = 'seconds') {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) {
        const normalized = value.replace(' ', 'T');
        const stamp = Date.parse(`${normalized}+08:00`);
        return Number.isFinite(stamp) && new Date(stamp + 8 * 3600000).toISOString().slice(0, 19) === normalized ? stamp : NaN;
    }
    if (typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return Date.parse(value);
    if ((typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) && value !== '') {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return unit === 'microseconds' ? number / 1000 : number * 1000;
    }
    return NaN;
}

function decodeEntities(text) {
    return String(text).replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi, token => {
        const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
        if (named[token.toLowerCase()]) return named[token.toLowerCase()];
        const value = token.slice(2, -1);
        const number = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
        return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    });
}

function decodedContent(value, depth = 0) {
    if (depth > 6 || value == null) return '';
    if (typeof value === 'string') {
        const text = value.slice(0, 100000);
        try {
            const parsed = JSON.parse(text);
            if (parsed !== text) return decodedContent(parsed, depth + 1);
        } catch { /* Plain text and HTML are also valid notification bodies. */ }
        return decodeEntities(decodeEntities(text)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(value)) return value.map(item => decodedContent(item, depth + 1)).join(' ');
    if (typeof value === 'object') return ['title', 'content', 'text', 'description', 'desc', 'message', 'msg', 'message_text', 'body', 'rich_text_nodes']
        .filter(key => Object.hasOwn(value, key)).map(key => decodedContent(value[key], depth + 1)).join(' ');
    return '';
}

function winningText(title, content, system = false) {
    const text = `${title} ${content}`;
    if (/未中[奖签]|没(?:有)?中[奖签]|未获奖|未抽中|没有获奖|很遗憾|祝.{0,8}中奖|预祝|有机会中奖|希望.{0,8}中奖|中奖率|中奖概率|中奖机会|验证码|校验码|预约成功|直播(?:已)?开始|开播提醒|优惠[券劵码]|代金券|折扣[券码]|满减券/.test(text)) return false;
    if (/获得.{0,20}(?:抽奖机会|参与资格|抽奖资格|中奖资格)/.test(text)) return false;
    const sentences = content.match(/[^。！!？?]+[。！!？?]*/g) || [];
    const ambiguous = sentence => /(?:中奖|抽中|中得|获奖|获得)/.test(sentence) && (
        /[？?]/.test(sentence)
        || /(?:如果|假如|倘若|要是|只有|只要|除非|万一|假设|一旦|若)[^。！!？?]{0,60}(?:中奖|抽中|中得|获奖|获得)/.test(sentence)
        || /(?:差点|差一点|几乎|险些|尚未|未能)[^。！!？?]{0,20}(?:中奖|抽中|中得|获奖|获得)/.test(sentence)
        || /(?:中奖|抽中|中得|获奖)(?:了|啦)?(?:吗|么|嘛|没|没有)/.test(sentence));
    // Questions about an address in a later sentence do not invalidate a
    // preceding confirmation. Context belongs to the winning statement.
    const statements = sentences.filter(sentence => !ambiguous(sentence));
    if (statements.some(sentence => /(?:您|你)(?:已|已经|成功)?中奖(?:了|啦|[！!，,。\s]|$)/.test(sentence)
        || /恭喜[^。！!？?]{0,12}(?:您|你)[^。！!？?]{0,40}(?:中奖|抽中|中得|获奖)/.test(sentence)
        || /(?:抽奖|开奖|奖品|奖项)/.test(text) && /恭喜[^。！!？?]{0,12}(?:您|你)[^。！!？?]{0,40}获得/.test(sentence))) return true;
    return system && /^(?:互动抽奖)?中奖通知$/.test(title.trim()) && !sentences.some(ambiguous);
}

function activityIdentity(...values) {
    const raw = values.map(value => typeof value === 'string' ? value : JSON.stringify(value ?? '')).join(' ');
    const urls = decodeEntities(decodeEntities(raw)).replace(/\\\//g, '/').match(/https?:\/\/[^\s<>"'\\，。！？；：、）》」』】〉“”‘’]+/g) || [];
    for (const candidate of urls) {
        const link = candidate.replace(/[.,!?;:)\]}]+$/, '');
        let url;
        try { url = new URL(link); } catch { continue; }
        let match;
        if (url.hostname === 't.bilibili.com' && (match = url.pathname.match(/^\/(\d+)\/?$/))) return `dynamic:${match[1]}`;
        if (url.hostname === 'www.bilibili.com' && (match = url.pathname.match(/^\/opus\/(\d+)\/?$/))) return `dynamic:${match[1]}`;
        if (['www.bilibili.com', 't.bilibili.com'].includes(url.hostname) && /\/(?:h5\/)?lottery(?:\/|$)/.test(url.pathname)) {
            const lottery = url.searchParams.get('lottery_id');
            if (lottery && /^\d+$/.test(lottery)) return `lottery:${lottery}`;
            const business = url.searchParams.get('business_id');
            if (business && /^\d+$/.test(business)) return `lottery-business:${url.searchParams.get('business_type') || ''}:${business}`;
        }
    }
    return '';
}

async function refreshWins(runtime, settings, options = {}) {
    const now = clock(options.now);
    const startedSettings = { ...settings };
    const initialScope = localScope(runtime, startedSettings);
    const uid = initialScope.uid;
    const cache = readCache(runtime);
    const previous = cache.accounts[uid] || {};
    const found = [];
    const cutoff = now - WINDOW;
    const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? Math.min(options.maxPages, 1000) : 100;
    const interval = Number.isFinite(options.interval) && options.interval >= 0 ? Math.min(options.interval, 5000) : 750;
    let complete = true, cancelled = false, account, lastRequest = 0, requests = 0;
    const emit = text => { try { options.onOutput?.(`[中奖统计] ${text}\n`); } catch { /* Progress callbacks do not affect counting. */ } };
    const incomplete = () => { complete = false; };
    const request = async (endpoint, cookie, signal) => {
        signal?.throwIfAborted();
        const wait = interval - (Date.now() - lastRequest);
        if (requests && wait > 0) await pause(wait, undefined, { signal });
        signal?.throwIfAborted();
        lastRequest = Date.now();
        requests++;
        return (options.request || requestBili)(endpoint, cookie, signal);
    };
    const get = endpoint => request(endpoint, account.cookie, options.signal);
    const attempt = async (label, operation) => {
        if (cancelled) return;
        emit(`正在读取${label}…`);
        try { await operation(); }
        catch { incomplete(); cancelled = Boolean(options.signal?.aborted); }
        emit(`${label}读取${cancelled ? '已停止' : complete ? '完成' : '未完整完成'}，已识别 ${eventCount(found)} 次中奖`);
    };
    const add = (source, item, time, identity, title, content, links) => {
        if (!winningText(title, content, source === 'system')) return;
        if (!Number.isFinite(time)) { incomplete(); return; }
        if (time < cutoff || time > now) return;
        const reliable = Boolean(identity);
        if (!identity) { incomplete(); identity = `fallback:${time}:${hash(content)}`; }
        const activity = activityIdentity(item, links);
        found.push({ fingerprint: hash(`${source}:${identity}`), time, source, reliable,
            observationFingerprint: hash(`${source}:${time}:${content}`),
            ...(activity ? { activityFingerprint: hash(activity) } : {}) });
    };
    const pageIsOld = times => times.length > 0 && times.every(Number.isFinite) && Math.min(...times) < cutoff;

    async function systemNotices(name) {
        let cursor = '';
        const visited = new Set();
        for (let page = 0; page < maxPages; page++) {
            const params = new URLSearchParams({ page_size: String(PAGE_SIZE), build: '0', mobi_app: 'web' });
            if (cursor) params.set('cursor', cursor);
            const data = await get(`https://message.bilibili.com/x/sys-msg/${name}?${params}`);
            const items = data?.system_notify_list ?? data?.unified_notify_list;
            if (!Array.isArray(items)) { incomplete(); return; }
            const times = items.map(item => notificationTime(item?.time_at));
            for (const [index, item] of items.entries()) {
                if (!record(item)) { incomplete(); continue; }
                if (!Number.isFinite(times[index])) incomplete();
                add('system', item, times[index], stableId(item.id) || stableId(item.cursor) || stableId(item.notify_cursor),
                    decodedContent(item.title), decodedContent(item.content), item.card_link);
            }
            if (!items.length) { if (yes(data.has_more)) incomplete(); return; }
            if (no(data.has_more) || pageIsOld(times) || !yes(data.has_more) && items.length < PAGE_SIZE) return;
            const last = items.at(-1);
            const next = stableId(last?.cursor) || stableId(last?.notify_cursor);
            if (!next || visited.has(next)) { incomplete(); return; }
            visited.add(next);
            cursor = next;
        }
        incomplete();
    }

    async function feed(source) {
        let cursor;
        const visited = new Set();
        for (let page = 0; page < maxPages; page++) {
            const params = new URLSearchParams();
            if (cursor) { params.set('id', cursor.id); params.set(`${source}_time`, cursor.time); }
            const data = await get(`/x/msgfeed/${source}${params.size ? `?${params}` : ''}`);
            if (!Array.isArray(data?.items) || !data.cursor || typeof data.cursor !== 'object') { incomplete(); return; }
            const times = data.items.map(item => notificationTime(item?.[`${source}_time`]));
            for (const [index, item] of data.items.entries()) {
                if (!record(item)) { incomplete(); continue; }
                if (!Number.isFinite(times[index])) incomplete();
                if (uidOf(item?.user?.mid) === uid) continue;
                add(source, item, times[index], stableId(item?.id), '', decodedContent(item?.item?.source_content), item?.item?.uri || item?.item?.native_uri);
            }
            if (!data.items.length) { if (!yes(data.cursor.is_end)) incomplete(); return; }
            if (yes(data.cursor.is_end) || pageIsOld(times)) return;
            const id = stableId(data.cursor.id), time = stableId(data.cursor.time);
            const key = `${id}:${time}`;
            if (!id || !time || visited.has(key)) { incomplete(); return; }
            visited.add(key);
            cursor = { id, time };
        }
        incomplete();
    }

    function privateMessage(item, talker) {
        if (!record(item)) { incomplete(); return; }
        const sender = uidOf(item?.sender_uid), receiver = uidOf(item?.receiver_id);
        if (sender === uid || receiver && receiver !== uid) return;
        const content = decodedContent(item?.content);
        if (!sender) { if (winningText('', content)) incomplete(); return; }
        add('dm', item, notificationTime(item?.timestamp), stableId(item?.msg_seqno) ? `${talker}:${stableId(item.msg_seqno)}` : '', '', content, item?.content);
    }

    async function chat(talker) {
        let cursor = '';
        const visited = new Set();
        for (let page = 0; page < maxPages; page++) {
            const params = new URLSearchParams({ talker_id: talker, session_type: '1', size: String(PAGE_SIZE) });
            if (cursor) params.set('begin_seqno', cursor);
            const data = await get(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?${params}`);
            if (!Array.isArray(data?.messages)) { incomplete(); return; }
            for (const item of data.messages) privateMessage(item, talker);
            const times = data.messages.map(item => notificationTime(item?.timestamp));
            if (!data.messages.length) { if (!no(data.has_more)) incomplete(); return; }
            if (no(data.has_more) || pageIsOld(times)) return;
            if (!yes(data.has_more)) { incomplete(); return; }
            const next = stableId(data.min_seqno);
            if (!next || visited.has(next)) { incomplete(); return; }
            visited.add(next);
            cursor = next;
        }
        incomplete();
    }

    async function sessions() {
        let cursor = '';
        const visited = new Set(), talkers = new Set();
        for (let page = 0; page < maxPages; page++) {
            const params = new URLSearchParams({ session_type: '1' });
            if (cursor) params.set('end_ts', cursor);
            const data = await get(`https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?${params}`);
            if (!Array.isArray(data?.session_list)) { incomplete(); return; }
            const times = data.session_list.map(item => notificationTime(item?.session_ts, 'microseconds'));
            for (const [index, item] of data.session_list.entries()) {
                if (Number.isFinite(times[index]) && times[index] < cutoff) continue;
                if (item?.session_type != null && Number(item.session_type) !== 1) continue;
                const talker = uidOf(item?.talker_id);
                if (!talker) { incomplete(); continue; }
                if (!Number.isFinite(times[index])) incomplete();
                if (talkers.has(talker)) continue;
                talkers.add(talker);
                if (item.last_msg) privateMessage(item.last_msg, talker);
                await attempt('私信记录', () => chat(talker));
                if (cancelled) return;
            }
            if (!data.session_list.length) { if (!no(data.has_more)) incomplete(); return; }
            // Pinned sessions can precede recent sessions. One old entry does
            // not establish that subsequent pages have passed the cutoff.
            const allOld = times.every(time => Number.isFinite(time) && time < cutoff);
            if (no(data.has_more) || allOld) return;
            if (!yes(data.has_more)) { incomplete(); return; }
            const next = stableId(data.session_list.at(-1)?.session_ts);
            if (!next || visited.has(next)) { incomplete(); return; }
            visited.add(next);
            cursor = next;
        }
        incomplete();
    }

    try {
        account = await verifyAccount(runtime, startedSettings, { request, signal: options.signal });
        await attempt('系统通知', () => systemNotices('query_user_notify'));
        await attempt('综合通知', () => systemNotices('query_unified_notify'));
        await attempt('回复通知', () => feed('reply'));
        await attempt('@通知', () => feed('at'));
        await attempt('私信会话', sessions);
        options.signal?.throwIfAborted();
    } catch { incomplete(); cancelled = Boolean(options.signal?.aborted); }

    // Login/settings changes invalidate an in-flight scan before any ledger write.
    if (account && (hash(extractCookie(runtime)) !== account.signature || String(settings?.uid || '') !== uid)) {
        return { ...readWins(runtime, settings, { now }), status: 'unknown', count: null,
            message: '登录账号已变化，请重新刷新中奖统计' };
    }
    if (!uid || initialScope.mismatch) return summary(undefined, localScope(runtime, settings), now);
    const known = activeEvents(previous.events, now);
    const pending = mergeEvents(activeEvents(previous.pendingEvents, now), activeEvents(found, now));
    const entry = { events: known, completedAt: previous.completedAt || null,
        lastAttemptAt: new Date(now).toISOString(), lastAttemptComplete: complete, cancelled };
    if (complete) {
        // Missing notification identifiers can establish a provisional finding,
        // but a later successful scan must not silently certify that fallback.
        entry.events = mergeEvents(known, pending.filter(event => event.reliable === true));
        entry.completedAt = new Date(now).toISOString();
        entry.pendingEvents = [];
    } else entry.pendingEvents = pending;
    cache.accounts[uid] = entry;
    try { writeJsonAtomic(cacheFile(runtime), cache); }
    catch {
        return { ...summary(previous, initialScope, now), status: previous.completedAt ? 'stale' : 'unknown',
            message: '统计结果未能保存，请重新刷新' };
    }
    const result = summary(entry, localScope(runtime, settings), now);
    emit(complete ? `扫描完成，最近七天中奖 ${result.count} 次` : '扫描未完成，保留已核实的统计记录');
    return result;
}

module.exports = { refreshWins, readWins };
