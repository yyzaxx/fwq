const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshWins, readWins } = require('../src/win-stats.cjs');

const NOW = Date.parse('2026-11-12T04:00:00Z');
const DAY = 86400000;
const SYSTEM = '/x/sys-msg/query_user_notify';
const UNIFIED = '/x/sys-msg/query_unified_notify';
const SESSIONS = '/session_svr/v1/session_svr/get_sessions';
const MESSAGES = '/svr_sync/v1/svr_sync/fetch_session_msgs';

function setup(t, uid = '123') {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-wins-test-'));
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
    const settings = { uid };
    function account(nextUid) {
        settings.uid = nextUid;
        fs.writeFileSync(path.join(runtime, 'env.js'), `module.exports={COOKIE:'DedeUserID=${nextUid}; SESSDATA=secret-test; bili_jct=secret-csrf;'};`);
    }
    account(uid);
    return { runtime, settings, account };
}

function requestFixture(routes = {}, uid = '123') {
    return async (endpoint, cookie, signal) => {
        signal?.throwIfAborted();
        const url = new URL(endpoint, 'https://api.bilibili.com');
        assert.doesNotMatch(url.pathname, /update_ack|send_msg|ack|mark_read/);
        if (Object.hasOwn(routes, url.pathname)) {
            const value = routes[url.pathname];
            return typeof value === 'function' ? value(url, cookie, signal) : value;
        }
        if (url.pathname === '/x/web-interface/nav') return { isLogin: true, mid: Number(uid) };
        if (url.pathname === SYSTEM || url.pathname === UNIFIED) return { system_notify_list: [] };
        if (url.pathname === '/x/msgfeed/reply' || url.pathname === '/x/msgfeed/at') return { cursor: { is_end: true, id: 0, time: 0 }, items: [] };
        if (url.pathname === SESSIONS) return { session_list: [], has_more: false };
        if (url.pathname === MESSAGES) return { messages: [], has_more: false, min_seqno: 0, max_seqno: 0 };
        throw new Error(`Unexpected endpoint ${url.pathname}`);
    };
}

function notice(id, content, time = NOW - 3600000, extra = {}) {
    const local = new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    return { id, cursor: id, notify_cursor: id, title: '消息通知', content, time_at: local, card_link: '', ...extra };
}

function message(seq, content, time = NOW - 3600000, extra = {}) {
    return { sender_uid: 456, receiver_id: 123, msg_type: 1, content: JSON.stringify({ content }), msg_seqno: seq,
        timestamp: Math.floor(time / 1000), msg_key: 9999999999999999999, ...extra };
}

function session(talker = '456', time = NOW - 3600000, extra = {}) {
    return { talker_id: talker, session_type: 1, session_ts: time * 1000, unread_count: 0,
        last_msg: message('1', '普通聊天', time, { sender_uid: talker }), ...extra };
}

async function refresh(context, routes = {}, options = {}) {
    return refreshWins(context.runtime, context.settings, { now: NOW, interval: 0,
        request: requestFixture(routes, context.settings.uid), ...options });
}

test('no completed scan reports unknown rather than an invented zero', t => {
    const context = setup(t);
    const result = readWins(context.runtime, context.settings, { now: NOW });
    assert.equal(result.count, null);
    assert.equal(result.status, 'unknown');
    assert.equal(result.updatedAt, null);
    assert.equal(result.windowDays, 7);
});

test('a complete empty scan produces a verified zero and a persisted timestamp', async t => {
    const context = setup(t);
    const result = await refresh(context);
    assert.equal(result.count, 0);
    assert.equal(result.status, 'ok');
    assert.equal(result.updatedAt, '2026-11-12T04:00:00.000Z');
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, 0);
});

test('system wins use the rolling 168 hour boundary and Shanghai notification times', async t => {
    const context = setup(t);
    const list = [
        notice('101', '恭喜你中奖了！', NOW - 7 * DAY),
        notice('102', '恭喜您在互动抽奖中获奖！', NOW - 7 * DAY - 1000),
        notice('103', '恭喜你中奖了！', NOW - 1000),
        notice('104', '恭喜你中奖了！', NOW + 1000),
        notice('105', '请查收抽奖奖品', NOW - 2000, { title: '中奖通知' })
    ];
    const result = await refresh(context, { [SYSTEM]: { system_notify_list: list } });
    assert.equal(result.count, 3);
    assert.equal(result.status, 'ok');
    assert.equal(readWins(context.runtime, context.settings, { now: NOW + 1000 }).count, 2);
});

test('overlapping feeds, repeated refreshes, and dynamic URL aliases count the same activity once', async t => {
    const context = setup(t);
    const one = notice('90071992547409931', '恭喜你中奖了！', NOW - 2000, { card_link: 'https://t.bilibili.com/1234567890123456789' });
    const routes = {
        [SYSTEM]: { system_notify_list: [one] },
        [UNIFIED]: { system_notify_list: [one, notice('90071992547409932', '恭喜你中奖了！', NOW - 1000,
            { card_link: 'https://www.bilibili.com/opus/1234567890123456789?from=notify' })] },
        '/x/msgfeed/reply': { cursor: { is_end: true, id: 1, time: NOW / 1000 }, items: [{ id: '90071992547409933',
            user: { mid: 456 }, reply_time: (NOW - 1000) / 1000,
            item: { source_content: '恭喜你中奖了！', uri: 'https://www.bilibili.com/opus/1234567890123456789' } }] }
    };
    assert.equal((await refresh(context, routes)).count, 1);
    assert.equal((await refresh(context, routes)).count, 1);
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, 1);
});

test('does not treat wishes, losses, verification codes, reservations, streams, or coupons as wins', async t => {
    const context = setup(t);
    const rejected = ['暂未中奖', '很遗憾，您未中奖', '祝你中奖！', '祝您中奖！', '你的验证码是123456',
        '预约成功', '直播开始啦', '恭喜你获得100元优惠券', '恭喜获得优惠券', '参与抽奖，有机会中奖',
        '中奖概率提升了', '提高中奖率', '中奖结果公布，请查看中奖名单', '请发兑换码', '恭喜其他用户中奖了'];
    const result = await refresh(context, { [SYSTEM]: { system_notify_list: rejected.map((text, index) => notice(String(index + 1), text)) } });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 0);
});

test('read private messages decode JSON and HTML, exclude outgoing messages, and keep separate wins from one sender', async t => {
    const context = setup(t);
    const messages = [
        message('90071992547409931', '恭喜你中奖了！这是奖品甲'),
        message('90071992547409932', '&lt;b&gt;恭喜您在抽奖中获奖！&lt;/b&gt;这是奖品乙'),
        message('90071992547409933', '恭喜你中奖了！', NOW - 1000, { sender_uid: 123, receiver_id: 456 }),
        message('90071992547409934', '恭喜你中奖了！', NOW - 1000, { receiver_id: 999 }),
        message('90071992547409935', '请把验证码告诉我')
    ];
    const output = [];
    const result = await refresh(context, {
        [SESSIONS]: { session_list: [session()], has_more: false },
        [MESSAGES]: { messages, has_more: false, min_seqno: '90071992547409931', max_seqno: '90071992547409935' }
    }, { onOutput: text => output.push(text) });
    assert.equal(result.count, 2);
    assert.equal(result.status, 'ok');
    const ledgerText = fs.readFileSync(path.join(context.runtime, 'win-stats.json'), 'utf8');
    assert.doesNotMatch(ledgerText + JSON.stringify(result) + output.join(''), /奖品甲|奖品乙|恭喜|secret-test|secret-csrf|90071992547409931/);
});

test('pages system, reply, at, sessions, and each chat with the verified read-only cursors', async t => {
    const context = setup(t);
    let systemPages = 0, replyPages = 0, atPages = 0, sessionPages = 0, chatPages = 0;
    const result = await refresh(context, {
        [SYSTEM]: url => {
            assert.equal(url.hostname, 'message.bilibili.com');
            systemPages++;
            if (!url.searchParams.has('cursor')) return { system_notify_list: Array.from({ length: 20 }, (_, index) => notice(String(20 - index), index ? '普通消息' : '恭喜你中奖了！')) };
            assert.equal(url.searchParams.get('cursor'), '1');
            return { system_notify_list: [notice('older', '普通消息', NOW - 8 * DAY)] };
        },
        '/x/msgfeed/reply': url => {
            replyPages++;
            if (!url.searchParams.has('id')) return { cursor: { is_end: false, id: '90071992547409931', time: (NOW - 2000) / 1000 }, items: [{ id: 'reply1', user: { mid: 456 },
                item: { source_content: '普通回复', uri: '' }, reply_time: (NOW - 2000) / 1000 }] };
            assert.equal(url.searchParams.get('id'), '90071992547409931');
            assert.equal(url.searchParams.get('reply_time'), String((NOW - 2000) / 1000));
            return { cursor: { is_end: true, id: 0, time: 0 }, items: [{ id: 'reply2', user: { mid: 456 },
                item: { source_content: '恭喜你中奖了！', uri: '' }, reply_time: (NOW - 3000) / 1000 }] };
        },
        '/x/msgfeed/at': url => {
            atPages++;
            if (!url.searchParams.has('id')) return { cursor: { is_end: false, id: 99, time: (NOW - 2000) / 1000 }, items: [{ id: 99, user: { mid: 456 }, item: { source_content: '普通at', uri: '' }, at_time: (NOW - 2000) / 1000 }] };
            assert.equal(url.searchParams.get('id'), '99');
            assert.equal(url.searchParams.get('at_time'), String((NOW - 2000) / 1000));
            return { cursor: { is_end: true, id: 0, time: 0 }, items: [{ id: 98, user: { mid: 456 }, item: { source_content: '恭喜你中奖了！', uri: '' }, at_time: (NOW - 3000) / 1000 }] };
        },
        [SESSIONS]: url => {
            assert.equal(url.hostname, 'api.vc.bilibili.com');
            assert.equal(url.searchParams.get('session_type'), '1');
            sessionPages++;
            if (!url.searchParams.has('end_ts')) return { session_list: [session('456')], has_more: true };
            assert.equal(url.searchParams.get('end_ts'), String((NOW - 3600000) * 1000));
            return { session_list: [session('789', NOW - 7200000)], has_more: false };
        },
        [MESSAGES]: url => {
            chatPages++;
            assert.equal(url.hostname, 'api.vc.bilibili.com');
            assert.equal(url.searchParams.get('size'), '20');
            if (url.searchParams.get('talker_id') === '789') return { messages: [message('2', '恭喜你中奖了！', NOW - 7200000, { sender_uid: 789 })], has_more: false, min_seqno: '2', max_seqno: '2' };
            if (!url.searchParams.has('begin_seqno')) return { messages: [message('20', '普通聊天')], has_more: true, min_seqno: '20', max_seqno: '20' };
            assert.equal(url.searchParams.get('begin_seqno'), '20');
            return { messages: [message('19', '恭喜你中奖了！'), message('18', '普通聊天', NOW - 8 * DAY)], has_more: true, min_seqno: '18', max_seqno: '19' };
        }
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 5);
    assert.deepEqual([systemPages, replyPages, atPages, sessionPages, chatPages], [2, 2, 2, 2, 3]);
});

test('page caps and looping cursors report unknown with a detected lower bound', async t => {
    const context = setup(t);
    const list = Array.from({ length: 20 }, (_, index) => notice(String(index + 1), index ? '普通通知' : '恭喜你中奖了！'));
    for (const maxPages of [1, 3]) {
        const result = await refresh(context, { [SYSTEM]: { system_notify_list: list } }, { maxPages });
        assert.equal(result.count, null);
        assert.equal(result.status, 'unknown');
        assert.equal(result.detectedCount, 1);
        assert.equal(result.updatedAt, null);
    }
});

test('API failure preserves the last complete count and timestamp with a stale marker', async t => {
    const context = setup(t);
    await refresh(context, { [SYSTEM]: { system_notify_list: [notice('1', '恭喜你中奖了！')] } });
    const result = await refresh(context, { '/x/msgfeed/reply': () => { throw new Error('private secret-test body'); },
        [SYSTEM]: { system_notify_list: [notice('2', '恭喜你中奖了！')] } }, { now: NOW + 60000 });
    assert.equal(result.count, 1);
    assert.equal(result.status, 'stale');
    assert.equal(result.detectedCount, 2);
    assert.equal(result.updatedAt, '2026-11-12T04:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(result), /private|secret-test/);
    assert.equal(readWins(context.runtime, context.settings, { now: NOW + 60000 }).status, 'stale');
    assert.equal(readWins(context.runtime, context.settings, { now: NOW + 8 * DAY }).count, 0);
});

test('login failures and malformed API data cannot become a verified zero', async t => {
    const context = setup(t);
    const cases = [
        { '/x/web-interface/nav': { isLogin: false, mid: 0 } },
        { [SYSTEM]: {} },
        { [MESSAGES]: {}, [SESSIONS]: { session_list: [session()], has_more: false } },
        { [SYSTEM]: { system_notify_list: [notice('1', '恭喜你中奖了！', NOW, { time_at: 'invalid' })] } }
    ];
    for (const routes of cases) {
        const result = await refresh(context, routes);
        assert.equal(result.count, null);
        assert.equal(result.status, 'unknown');
    }
});

test('cached counts are scoped to the configured and locally logged-in account', async t => {
    const context = setup(t);
    await refresh(context, { [SYSTEM]: { system_notify_list: [notice('1', '恭喜你中奖了！')] } });
    context.account('789');
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, null);
    assert.equal((await refresh(context)).count, 0);
    context.account('123');
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, 1);
    fs.writeFileSync(path.join(context.runtime, 'env.js'), "module.exports={COOKIE:'DedeUserID=789; SESSDATA=another-account;'};");
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, null);
    assert.equal((await refresh(context)).count, null);
});

test('cancellation leaves prior values stale and never exposes raw errors', async t => {
    const context = setup(t);
    await refresh(context, { [SYSTEM]: { system_notify_list: [notice('1', '恭喜你中奖了！')] } });
    const controller = new AbortController();
    controller.abort(new Error('secret-test cancellation'));
    const result = await refresh(context, {}, { signal: controller.signal, now: NOW + 60000 });
    assert.equal(result.status, 'stale');
    assert.equal(result.count, 1);
    assert.equal(result.cancelled, true);
    assert.doesNotMatch(JSON.stringify(result), /secret-test/);
});

test('a credential change during a scan discards results for the previous login', async t => {
    const context = setup(t);
    const result = await refresh(context, { [SYSTEM]: () => {
        context.account('789');
        return { system_notify_list: [notice('1', '恭喜你中奖了！')] };
    } });
    assert.equal(result.count, null);
    assert.equal(result.status, 'unknown');
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, null);
});

test('conditional wins and newly granted draw entries are not winning outcomes', async t => {
    const context = setup(t);
    const texts = ['如果你中奖了，请提供收件地址', '假如你中奖啦，请回复本消息', '恭喜你获得一次抽奖机会',
        '恭喜你获得本次抽奖的参与资格', '活动通知：若您已中奖，请到个人中心查看'];
    const result = await refresh(context, { [SYSTEM]: { system_notify_list: texts.map((text, index) => notice(String(index + 1), text)) } });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 0);
});

test('malformed rows and contradictory empty pagination cannot certify zero', async t => {
    const context = setup(t);
    const cases = [
        { [SYSTEM]: { system_notify_list: [null] } },
        { [SYSTEM]: { system_notify_list: [], has_more: true } },
        { '/x/msgfeed/reply': { items: [null], cursor: { is_end: true, id: 0, time: 0 } } },
        { '/x/msgfeed/at': { items: [], cursor: { is_end: false, id: 123, time: NOW / 1000 } } },
        { [SESSIONS]: { session_list: [], has_more: true } },
        { [SESSIONS]: { session_list: [session()], has_more: false }, [MESSAGES]: { messages: [null], has_more: false } },
        { [SESSIONS]: { session_list: [session()], has_more: false }, [MESSAGES]: { messages: [], has_more: true } }
    ];
    for (const routes of cases) {
        const result = await refresh(context, routes);
        assert.equal(result.count, null);
        assert.equal(result.status, 'unknown');
    }
});

test('winning questions, conditional claims, and near misses do not count as outcomes', async t => {
    const context = setup(t);
    const texts = ['你中奖了吗？', '要是你中奖了，请提供地址', '只有你中奖了，才需要填写地址',
        '恭喜你差点中奖！', '如果系统提示你中奖了，请联系主办方'];
    const result = await refresh(context, { [SYSTEM]: { system_notify_list: texts.map((text, index) => notice(String(index + 1), text)) } });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 0);
});

test('a confirmed win followed by a separate address question remains a win', async t => {
    const context = setup(t);
    const result = await refresh(context, { [SYSTEM]: { system_notify_list: [notice('1', '恭喜你中奖了！请问收件地址是什么？')] } });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
});

test('an unreliable observation cannot become a second verified win when its identifier later appears', async t => {
    const context = setup(t);
    const first = await refresh(context, { [SYSTEM]: { system_notify_list: [notice(undefined, '恭喜你中奖了！')] } });
    assert.equal(first.status, 'unknown');
    assert.equal(first.count, null);
    assert.equal(first.detectedCount, 1);
    const second = await refresh(context, { [SYSTEM]: { system_notify_list: [notice('123', '恭喜你中奖了！')] } });
    assert.equal(second.status, 'ok');
    assert.equal(second.count, 1);
    assert.equal(readWins(context.runtime, context.settings, { now: NOW }).count, 1);
});

test('a later complete scan does not promote an unmatched unreliable observation', async t => {
    const context = setup(t);
    const first = await refresh(context, { [SYSTEM]: { system_notify_list: [notice(undefined, '恭喜你中奖了！')] } });
    assert.equal(first.detectedCount, 1);
    const second = await refresh(context);
    assert.equal(second.status, 'ok');
    assert.equal(second.count, 0);
});

test('a newly identified observation also reconciles an earlier fallback during incomplete scans', async t => {
    const context = setup(t);
    await refresh(context, { [SYSTEM]: { system_notify_list: [notice(undefined, '恭喜你中奖了！')] } });
    const second = await refresh(context, { [SYSTEM]: { system_notify_list: [notice('123', '恭喜你中奖了！')] },
        '/x/msgfeed/reply': () => { throw Error('fixture unavailable'); } });
    assert.equal(second.status, 'unknown');
    assert.equal(second.count, null);
    assert.equal(second.detectedCount, 1);
});

test('an old pinned session on a mixed page cannot hide recent sessions on the next page', async t => {
    const context = setup(t);
    let pages = 0;
    const result = await refresh(context, {
        [SESSIONS]: url => {
            pages++;
            if (!url.searchParams.has('end_ts')) return { session_list: [session('900', NOW - 8 * DAY), session('456')], has_more: true };
            assert.equal(url.searchParams.get('end_ts'), String((NOW - 3600000) * 1000));
            return { session_list: [session('789', NOW - 7200000)], has_more: false };
        },
        [MESSAGES]: url => ({ messages: [message('2', url.searchParams.get('talker_id') === '789' ? '恭喜你中奖了！' : '普通聊天',
            NOW - 7200000, { sender_uid: Number(url.searchParams.get('talker_id')) })], has_more: false, min_seqno: '2', max_seqno: '2' })
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal(pages, 2);
});

test('sentence punctuation after an activity URL does not split one win into two', async t => {
    const context = setup(t);
    const url = 'https://t.bilibili.com/1234567890123456789';
    const result = await refresh(context, {
        [SESSIONS]: { session_list: [session()], has_more: false },
        [MESSAGES]: { messages: [message('2', `恭喜你中奖了！活动链接 ${url}`), message('3', `恭喜你中奖了！活动链接 ${url}。`)],
            has_more: false, min_seqno: '2', max_seqno: '3' }
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
});
