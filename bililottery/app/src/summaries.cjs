const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { DEFAULT_UA, extractCookie, writeJsonAtomic } = require('./config.cjs');

function shanghaiTime(text) {
    const match = text.match(/(?:LT|结束|开奖时间)\s*[:：]\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i);
    if (!match) return null;
    const iso = `${match[1]}T${match[2]}+08:00`;
    const stamp = Date.parse(iso);
    if (!Number.isFinite(stamp)) return null;
    if (new Date(stamp + 8 * 3600000).toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
    return iso;
}

function parseSummaryText(text, sourceId, now = Date.now()) {
    const items = [];
    let kind = 'interaction', block = null;
    const flush = () => {
        if (!block) return;
        const raw = block.lines.join('\n');
        const drawAt = shanghaiTime(raw);
        const urls = raw.match(/https?:\/\/[^\s<>"，]+/g) || [];
        for (const rawUrl of urls) {
            let url;
            try { url = new URL(rawUrl); } catch { continue; }
            if (url.username || url.password || url.port) continue;
            const match = url.host === 't.bilibili.com' ? url.pathname.match(/^\/(\d{18,})\/?$/)
                : ['www.bilibili.com', 'm.bilibili.com'].includes(url.host) ? url.pathname.match(/^\/opus\/(\d{18,})\/?$/) : null;
            if (!match) continue;
            items.push({ dyid: match[1], name: block.name, kind: block.kind, sourceId,
                url: `https://t.bilibili.com/${match[1]}`, drawAt,
                prize: block.lines.filter(l => /^[一二三四五六七八九十]奖/.test(l)).join('；'),
                status: !drawAt ? 'unknown' : Date.parse(drawAt) <= now ? 'expired' : 'ready' });
        }
    };
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (/^(互动抽奖|预约抽奖)$/.test(line)) {
            flush(); block = null; kind = line === '预约抽奖' ? 'reserve' : 'interaction';
        } else {
            const heading = line.match(/^\[\d+\]\s*-+\s*(.+)$/);
            if (heading) { flush(); block = { name: heading[1], kind, lines: [] }; }
            else if (block) block.lines.push(line);
        }
    }
    flush();
    return items;
}

function parseOpusSummary(item, uid, now = Date.now()) {
    if (String(item?.basic?.uid) !== String(uid)) throw new Error('汇总作者与指定 UID 不一致');
    const modules = item.modules || [];
    const paragraphs = modules.flatMap(m => m.module_content?.paragraphs || []);
    if (!paragraphs.length) throw new Error('未获取到完整汇总正文，请稍后在浏览器检查');
    const text = paragraphs.map(p => (p.text?.nodes || []).map(n => {
        const value = n.word?.words || n.rich?.orig_text || n.rich?.text || '';
        const url = n.rich?.jump_url;
        return url && !value.includes(url) ? `${value} ${url}` : value;
    }).join('')).join('\n');
    const title = modules.find(m => m.module_title)?.module_title.text || item.basic.title || '';
    if (!/互动抽奖|预约抽奖/.test(title)) throw new Error('该动态不是互动抽奖或预约抽奖汇总');
    return { id: item.id_str, title, url: `https://www.bilibili.com/opus/${item.id_str}`,
        items: parseSummaryText(text, item.id_str, now) };
}

async function officialRequest(endpoint, cookie, signal) {
    signal?.throwIfAborted();
    const response = await fetch(`https://api.bilibili.com${endpoint}`, {
        headers: { Cookie: cookie, 'User-Agent': DEFAULT_UA, Referer: 'https://www.bilibili.com/' },
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`汇总读取被中止：HTTP ${response.status}，请在浏览器检查后再试`);
    let result;
    try { result = await response.json(); } catch { throw new Error('接口未返回 JSON，可能需要在浏览器完成验证，已停止读取'); }
    if (result.code !== 0) {
        const error = new Error(`接口返回 ${result.code}，已停止读取，请在浏览器检查登录或验证状态`);
        error.code = result.code;
        throw error;
    }
    return result.data;
}

function credentials(runtimeDir) {
    const cookie = extractCookie(runtimeDir);
    if (!/SESSDATA=[^;]+/.test(cookie)) throw new Error('请先扫码登录后读取汇总');
    return cookie;
}

async function collectSummaries(runtimeDir, settings, options = {}) {
    const uid = String(settings.summaryUid || '492426375');
    if (!/^\d+$/.test(uid)) throw new Error('汇总 UID 必须为数字');
    const cookie = credentials(runtimeDir), request = options.request || officialRequest;
    const now = options.now ?? Date.now();
    options.onOutput?.(`[每日汇总] 读取 UP ${uid} 最近两篇互动/预约抽奖汇总\n`);
    const feed = await request(`/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}&features=itemOpusStyle`, cookie, options.signal);
    const candidates = (feed.items || []).filter(p => /互动抽奖|预约抽奖/.test(p.modules?.module_dynamic?.major?.opus?.title || '')
        && Number(p.modules?.module_author?.pub_ts) >= now / 1000 - 14 * 86400).slice(0, 2);
    if (!candidates.length) throw new Error('最近动态中没有找到可读取的互动/预约抽奖汇总');
    const sources = [], unique = new Map();
    for (const post of candidates) {
        if (!/^\d+$/.test(post.id_str)) throw new Error('汇总动态 ID 无效');
        const data = await request(`/x/polymer/web-dynamic/v1/opus/detail?id=${post.id_str}`, cookie, options.signal);
        const parsed = parseOpusSummary(data.item, uid, now);
        if (parsed.id !== post.id_str) throw new Error('接口返回的汇总 ID 不匹配');
        sources.push({ id: parsed.id, title: parsed.title, url: parsed.url, count: parsed.items.length });
        for (const item of parsed.items) {
            const prior = unique.get(item.dyid);
            if (!prior || (item.drawAt && (!prior.drawAt || Date.parse(item.drawAt) < Date.parse(prior.drawAt)))) unique.set(item.dyid, item);
        }
    }
    options.signal?.throwIfAborted();
    const report = { uid, fetchedAt: new Date(now).toISOString(), sources, items: [...unique.values()] };
    writeJsonAtomic(path.join(runtimeDir, 'summary-preview.json'), report);
    options.onOutput?.(`[每日汇总] 共 ${report.items.length} 条，未到期 ${report.items.filter(i => i.status === 'ready').length} 条\n`);
    return report;
}

async function prepareSummaryQueue(report, enginePath, runtimeDir, settings, options = {}) {
    options.signal?.throwIfAborted();
    const historyFile = path.join(runtimeDir, 'dyids/dyid.txt');
    const history = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : '';
    const participated = new Set(history.split(/[,\s]+/).filter(Boolean));
    const tasks = report.items.filter(item => /^\d{18,}$/.test(item.dyid)
        && item.status === 'ready' && Date.parse(item.drawAt) > (options.now ?? Date.now())
        && (!settings.disableReserve || item.kind !== 'reserve') && !participated.has(item.dyid));
    if (!tasks.length) throw new Error('没有可处理的未到期条目，本次不启动引擎');
    writeJsonAtomic(path.join(runtimeDir, 'summary-tasks.json'), { summaryUid: settings.summaryUid, tasks });
    options.onOutput?.('[每日汇总] 已加入 ' + tasks.length + ' 条任务，直接启动逐条处理\n');
    return tasks.length;
}

async function hydrateSummaryTask(item, enginePath, runtimeDir, settings, options = {}) {
    options.signal?.throwIfAborted();
    const request = options.request || officialRequest;
    if (!/^\d{18,}$/.test(item.dyid)) throw new Error('动态 ID 无效');
    const data = await request('/x/polymer/web-dynamic/v1/detail?id=' + item.dyid + '&features=itemOpusStyle', credentials(runtimeDir), options.signal);
    if (data.item?.id_str !== item.dyid) throw new Error('原动态 ID 不匹配，已停止处理');
    const engineRequire = createRequire(path.join(enginePath, 'package.json'));
    const { parseDynamicCard } = engineRequire('./lib/core/searcher.js');
    const card = parseDynamicCard(data);
    if (!card.uid || !card.type || !card.rid_str || !card.description) throw new Error('当前动态缺少执行所需参数，已停止处理');
    if (card.is_charge_lottery || card.is_liked) return null;
    return { lottery_info_type: 'article', create_time: card.create_time, is_liked: card.is_liked,
        uids: [card.uid, card.origin?.uid || card.uid], uname: card.uname, ctrl: card.ctrl,
        dyid: card.dynamic_id, reserve_id: card.reserve_id, reserve_lottery_text: card.reserve_lottery_text,
        is_charge_lottery: card.is_charge_lottery, rid: card.rid_str, chat_type: card.chat_type,
        des: card.description, type: card.type, hasOfficialLottery: card.hasOfficialLottery };
}

module.exports = { parseSummaryText, parseOpusSummary, collectSummaries, prepareSummaryQueue, hydrateSummaryTask, officialRequest };
