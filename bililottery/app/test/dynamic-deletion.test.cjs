const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UID = '123';
const A = '9007199254740993123';
const B = '9007199254740993124';
const C = '9007199254740993125';
const ORIGINAL = '8007199254740993123';
const COOKIE = 'DedeUserID=123; SESSDATA=secret-session; bili_jct=secret-csrf;';

function item(id, { owner = UID, type = 'DYNAMIC_TYPE_FORWARD', original = ORIGINAL, text = 'a post' } = {}) {
    return { id_str: id, type, modules: { module_author: { mid: owner }, module_dynamic: { desc: { text } } },
        ...(type === 'DYNAMIC_TYPE_FORWARD' ? { orig: { id_str: original } } : {}) };
}

function setup(t, options = {}) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-manual-test-'));
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
    const settings = { uid: UID, dryRun: false, cleanupKeepIds: '', ...options.settings };
    const setCookie = value => fs.writeFileSync(path.join(runtime, 'env.js'), `module.exports={COOKIE:${JSON.stringify(value)}};`);
    setCookie(COOKIE);
    const removed = [], requests = [];
    let pages = [{ items: [item(A), item(B)], has_more: false, offset: '' }];
    let details = new Map([[A, item(A)], [B, item(B)], [C, item(C)]]);
    let nav = { isLogin: true, mid: UID };
    const request = async (endpoint, cookie, signal) => {
        signal?.throwIfAborted();
        requests.push(endpoint);
        assert.equal(cookie, COOKIE);
        if (endpoint === '/x/web-interface/nav') return nav;
        if (endpoint.startsWith('/x/polymer/web-dynamic/v1/feed/space?')) {
            const url = new URL(endpoint, 'https://api.bilibili.com');
            assert.equal(url.searchParams.get('host_mid'), UID);
            assert.equal(url.searchParams.get('features'), 'itemOpusStyle');
            return pages.shift();
        }
        if (endpoint.startsWith('/x/polymer/web-dynamic/v1/detail?')) {
            const id = new URL(endpoint, 'https://api.bilibili.com').searchParams.get('id');
            const result = details.get(id);
            if (result instanceof Error) throw result;
            return { item: result };
        }
        throw Error('unexpected endpoint');
    };
    const { DynamicDeletion } = require('../src/dynamic-deletion.cjs');
    const service = new DynamicDeletion(runtime, () => settings, { interval: 0, request,
        remove: async id => removed.push(id), ...options.service });
    return { runtime, settings, service, removed, requests, setCookie,
        setPages: value => { pages = value; }, setDetails: value => { details = value; },
        setNav: value => { nav = value; },
        readReport: () => JSON.parse(fs.readFileSync(path.join(runtime, 'manual-dynamics.json'), 'utf8')),
        writeLedger: records => fs.writeFileSync(path.join(runtime, 'repost-ledger.json'), JSON.stringify({ version: 1, records })),
        readLedger: () => JSON.parse(fs.readFileSync(path.join(runtime, 'repost-ledger.json'), 'utf8')) };
}

test('preview paginates exact string IDs, deduplicates and excludes foreign, original and kept posts', async t => {
    const context = setup(t), { service, settings } = context;
    settings.cleanupKeepIds = ORIGINAL + '9';
    context.setPages([
        { items: [item(A), item(B, { owner: '456' }), item(C, { type: 'DYNAMIC_TYPE_WORD' })], has_more: true, offset: 'next+cursor' },
        { items: [item(A), item('9007199254740993126', { original: ORIGINAL + '9' }), item('9007199254740993127')], has_more: false, offset: '' }
    ]);
    const report = await service.preview('reposts');
    assert.equal(report.state, 'preview');
    assert.equal(report.count, 2);
    assert.equal(report.scanned, 5);
    assert.equal(report.skipped, 3);
    assert.deepEqual(report.items.map(entry => entry.id), [A, '9007199254740993127']);
    assert.equal(report.canExecute, true);
    assert.match(report.previewId, /^[a-f0-9]{32,}$/);
    assert.match(context.requests[2], /offset=next%2Bcursor/);
    assert.deepEqual(context.removed, []);
    const saved = context.readReport();
    assert.equal(saved.count, 2);
    assert.equal(saved.previewId, null);
    assert.doesNotMatch(JSON.stringify([report, saved]), /secret-session|secret-csrf|signature|cookie/i);
});

test('all scope previews own original posts while reposts remains the default', async t => {
    const context = setup(t);
    context.setPages([{ items: [item(A, { type: 'DYNAMIC_TYPE_WORD' }), item(B)], has_more: false }]);
    const all = await context.service.preview('all');
    assert.deepEqual(all.items.map(entry => entry.id), [A, B]);
    context.setPages([{ items: [item(A, { type: 'DYNAMIC_TYPE_WORD' }), item(B)], has_more: false }]);
    const reposts = await context.service.preview();
    assert.equal(reposts.scope, 'reposts');
    assert.deepEqual(reposts.items.map(entry => entry.id), [B]);
});

test('preview rejects an unverified account without reading the feed', async t => {
    const context = setup(t);
    context.setNav({ isLogin: true, mid: '456' });
    await assert.rejects(context.service.preview('all'));
    assert.equal(context.service.getState().state, 'failed');
    assert.equal(context.service.getState().canExecute, false);
    assert.equal(context.requests.length, 1);
    assert.deepEqual(context.removed, []);
});

test('cursor loops stop preview without granting deletion', async t => {
    const context = setup(t);
    context.setPages([
        { items: [item(A)], has_more: true, offset: 'repeat' },
        { items: [item(B)], has_more: true, offset: 'repeat' }
    ]);
    await assert.rejects(context.service.preview());
    assert.equal(context.service.getState().canExecute, false);
    assert.equal(context.requests.length, 3);
    assert.deepEqual(context.removed, []);
});

test('execute deletes only the preview snapshot once and persists exact ledger matches', async t => {
    const context = setup(t);
    context.writeLedger([
        { repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null, extra: 'preserve me' },
        { repostId: B, originalId: ORIGINAL, ownerUid: UID, deletedAt: null },
        { repostId: C, originalId: ORIGINAL, ownerUid: UID, deletedAt: null },
        { repostId: Number(A), originalId: ORIGINAL, ownerUid: UID, deletedAt: null }
    ]);
    const preview = await context.service.preview();
    await assert.rejects(context.service.execute(C));
    const result = await context.service.execute(preview.previewId);
    assert.deepEqual(context.removed, [A, B]);
    assert.equal(result.deleted, 2);
    assert.equal(result.state, 'completed');
    assert.equal(result.canExecute, false);
    assert.equal(result.previewOnly, false);
    const ledger = context.readLedger();
    assert.equal(typeof ledger.records[0].deletedAt, 'string');
    assert.equal(typeof ledger.records[1].deletedAt, 'string');
    assert.equal(ledger.records[0].extra, 'preserve me');
    assert.equal(ledger.records[2].deletedAt, null);
    assert.equal(ledger.records[3].deletedAt, null);
    assert.equal(context.readReport().deleted, 2);
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, [A, B]);
});

test('execute rechecks exact ID, type, owner, original and the current keep list', async t => {
    const context = setup(t);
    const ids = ['9007199254740993121', '9007199254740993122', A, B, C, '9007199254740993126'];
    context.setPages([{ items: ids.map(id => item(id)), has_more: false }]);
    const preview = await context.service.preview();
    context.settings.cleanupKeepIds = C;
    context.setDetails(new Map([
        [ids[0], item('9007199254740993199')],
        [ids[1], item(ids[1], { type: 'DYNAMIC_TYPE_WORD' })],
        [A, item(A, { owner: '456' })],
        [B, item(B, { original: '8007199254740993124' })],
        [C, item(C)],
        [ids[5], item(ids[5])]
    ]));
    const result = await context.service.execute(preview.previewId);
    assert.deepEqual(context.removed, ['9007199254740993126']);
    assert.equal(result.skipped, 5);
    assert.equal(result.deleted, 1);
});

test('an original keep ID added after preview also protects its repost', async t => {
    const context = setup(t);
    const preview = await context.service.preview('all');
    context.settings.cleanupKeepIds = ORIGINAL;
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.skipped, 2);
    assert.deepEqual(context.removed, []);
});

test('all scope executes original dynamics only after detail ownership and type checks', async t => {
    const context = setup(t);
    context.setPages([{ items: [item(A, { type: 'DYNAMIC_TYPE_WORD' }), item(B, { type: 'DYNAMIC_TYPE_DRAW' })], has_more: false }]);
    context.setDetails(new Map([[A, item(A, { type: 'DYNAMIC_TYPE_WORD' })], [B, item(B, { owner: '456', type: 'DYNAMIC_TYPE_DRAW' })]]));
    const preview = await context.service.preview('all');
    const result = await context.service.execute(preview.previewId);
    assert.deepEqual(context.removed, [A]);
    assert.equal(result.skipped, 1);
});

test('recorded scope ignores age and summary account but never includes unrecorded or foreign records', async t => {
    const context = setup(t);
    context.writeLedger([
        { repostId: A, originalId: ORIGINAL, ownerUid: UID, summaryUid: 'unrelated', drawAt: '2099-01-01T00:00:00Z', deletedAt: null },
        { repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null },
        { repostId: B, originalId: ORIGINAL, ownerUid: '456', deletedAt: null },
        { repostId: C, originalId: ORIGINAL, ownerUid: UID, deletedAt: '2026-01-01T00:00:00Z' }
    ]);
    const preview = await context.service.preview('recorded');
    assert.deepEqual(preview.items.map(entry => entry.id), [A]);
    assert.equal(context.requests.some(endpoint => endpoint.includes('/feed/space?')), false);
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.deleted, 1);
    assert.deepEqual(context.removed, [A]);
});

test('recorded scope rejects a detail with a different original ID', async t => {
    const context = setup(t);
    context.writeLedger([{ repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null }]);
    context.setDetails(new Map([[A, item(A, { original: '8007199254740993124' })]]));
    const preview = await context.service.preview('recorded');
    assert.equal(preview.count, 0);
    assert.equal(preview.canExecute, false);
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
});

test('dryRun simulates without removal or ledger changes', async t => {
    const context = setup(t, { settings: { dryRun: true } });
    context.writeLedger([{ repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null }]);
    const preview = await context.service.preview();
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.state, 'simulated');
    assert.equal(result.simulated, 2);
    assert.equal(result.deleted, 0);
    assert.equal(result.previewOnly, true);
    assert.deepEqual(context.removed, []);
    assert.equal(context.readLedger().records[0].deletedAt, null);
});

test('changing dryRun after preview requires a new preview', async t => {
    const context = setup(t, { settings: { dryRun: true } });
    const preview = await context.service.preview();
    context.settings.dryRun = false;
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
});

test('a changed cookie consumes the grant without deleting anything', async t => {
    const context = setup(t);
    const preview = await context.service.preview();
    context.setCookie(COOKIE.replace('secret-session', 'different-session'));
    await assert.rejects(context.service.execute(preview.previewId));
    context.setCookie(COOKIE);
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
    assert.equal(context.readReport().state, 'failed');
});

test('execute rejects an owner change returned by nav', async t => {
    const context = setup(t);
    const preview = await context.service.preview();
    context.setNav({ isLogin: true, mid: '456' });
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
});

test('grants expire fifteen minutes after preview completes', async t => {
    let now = Date.parse('2026-11-12T01:00:00Z');
    const context = setup(t, { service: { now: () => now } });
    const preview = await context.service.preview('reposts', { onOutput: () => { now += 120000; } });
    assert.equal(preview.expiresAt, '2026-11-12T01:17:00.000Z');
    now += 15 * 60 * 1000;
    assert.equal(context.service.getState().canExecute, false);
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
});

test('a concurrent or second execution cannot reuse a single-use grant', async t => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const inside = new Promise(resolve => { entered = resolve; });
    const context = setup(t, { service: { remove: async () => { entered(); await gate; } } });
    const preview = await context.service.preview();
    const execution = context.service.execute(preview.previewId);
    await inside;
    await assert.rejects(context.service.execute(preview.previewId));
    await assert.rejects(context.service.preview());
    release();
    assert.equal((await execution).deleted, 2);
    await assert.rejects(context.service.execute(preview.previewId));
});

test('login failure stops with incremental deletion and ledger progress preserved', async t => {
    const failure = Object.assign(Error('secret-session must never be public'), { code: -101 });
    const removed = [];
    const context = setup(t, { service: { remove: async id => { if (id === B) throw failure; removed.push(id); } } });
    context.writeLedger([{ repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null },
        { repostId: B, originalId: ORIGINAL, ownerUid: UID, deletedAt: null }]);
    const preview = await context.service.preview();
    await assert.rejects(context.service.execute(preview.previewId), error => error.code === -101 && !error.message.includes('secret-session'));
    assert.deepEqual(removed, [A]);
    assert.equal(context.service.getState().deleted, 1);
    assert.equal(context.readReport().deleted, 1);
    assert.equal(context.readReport().state, 'failed');
    assert.equal(typeof context.readLedger().records[0].deletedAt, 'string');
    assert.equal(context.readLedger().records[1].deletedAt, null);
    assert.doesNotMatch(JSON.stringify(context.service.getState()), /secret-session/);
});

test('invisible detail and per-post rejection skip safely while rate limits stop', async t => {
    const invisible = Object.assign(Error('invisible'), { code: 4101152 });
    const context = setup(t, { service: { remove: async id => { if (id === B) throw Object.assign(Error('rejected'), { code: -400 }); } } });
    context.setPages([{ items: [item(A), item(B), item(C)], has_more: false }]);
    context.setDetails(new Map([[A, invisible], [B, item(B)], [C, item(C)]]));
    const preview = await context.service.preview();
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.deleted, 1);
    assert.equal(result.skipped, 2);
    const limited = setup(t, { service: { remove: async () => { throw Object.assign(Error('rate limited'), { code: 429 }); } } });
    const limitedPreview = await limited.service.preview();
    await assert.rejects(limited.service.execute(limitedPreview.previewId));
    assert.equal(limited.service.getState().deleted, 0);
    assert.equal(limited.service.getState().processed, 0);
});

test('cancellation during the delay stops before the next post and preserves progress', { timeout: 2000 }, async t => {
    const controller = new AbortController(), removed = [];
    const context = setup(t, { service: { interval: 30000, remove: async id => {
        removed.push(id);
        setImmediate(() => controller.abort());
    } } });
    const preview = await context.service.preview();
    await assert.rejects(context.service.execute(preview.previewId, { signal: controller.signal }), error => error.code === 'ABORT_ERR');
    assert.deepEqual(removed, [A]);
    assert.equal(context.readReport().deleted, 1);
    assert.equal(context.readReport().state, 'cancelled');
});

test('restart preserves progress but invalidates previews and never resumes deletion', async t => {
    const context = setup(t);
    const preview = await context.service.preview();
    const { DynamicDeletion } = require('../src/dynamic-deletion.cjs');
    const restarted = new DynamicDeletion(context.runtime, () => context.settings, { request: async () => { throw Error('must not read account'); },
        remove: async () => { throw Error('must not resume'); } });
    assert.equal(restarted.getState().state, 'expired');
    assert.equal(restarted.getState().canExecute, false);
    await assert.rejects(restarted.execute(preview.previewId));
    const saved = context.readReport();
    saved.state = 'deleting'; saved.deleted = 1;
    fs.writeFileSync(path.join(context.runtime, 'manual-dynamics.json'), JSON.stringify(saved));
    const interrupted = new DynamicDeletion(context.runtime, () => context.settings);
    assert.equal(interrupted.getState().state, 'interrupted');
    assert.equal(interrupted.getState().deleted, 1);
    assert.deepEqual(context.removed, []);
});

test('public previews cap items at fifty while execution retains every exact snapshot ID', async t => {
    const context = setup(t);
    const posts = Array.from({ length: 55 }, (_, index) => item('900719925474100' + String(index).padStart(4, '0')));
    context.setPages([{ items: posts, has_more: false }]);
    context.setDetails(new Map(posts.map(post => [post.id_str, post])));
    const preview = await context.service.preview();
    assert.equal(preview.count, 55);
    assert.equal(preview.items.length, 50);
    preview.items[0].id = C;
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.deleted, 55);
    assert.equal(context.removed.length, 55);
    assert.equal(context.removed[0], '9007199254741000000');
    assert.equal(context.removed[54], '9007199254741000054');
    assert.equal(context.readReport().items.length, 50);
});

test('numeric dynamic IDs are skipped rather than converted through floating point', async t => {
    const context = setup(t);
    context.setPages([{ items: [item(Number(A)), item(A)], has_more: false }]);
    const result = await context.service.preview();
    assert.deepEqual(result.items.map(entry => entry.id), [A]);
    assert.equal(result.skipped, 1);
});

test('settings UID and local cookie owner must match before nav or feed requests', async t => {
    const context = setup(t, { settings: { uid: '456' } });
    await assert.rejects(context.service.preview());
    assert.deepEqual(context.requests, []);
    assert.deepEqual(context.removed, []);
});

test('missing pagination metadata and page limits fail closed', async t => {
    const context = setup(t);
    context.setPages([{ items: [item(A)] }]);
    await assert.rejects(context.service.preview());
    assert.equal(context.service.getState().canExecute, false);
    const limited = setup(t, { service: { maxPages: 1 } });
    limited.setPages([{ items: [item(A)], has_more: true, offset: 'more' }]);
    await assert.rejects(limited.service.preview());
    assert.equal(limited.service.getState().canExecute, false);
});

test('cancelling preview invalidates its partial result and any older grant', async t => {
    const context = setup(t), controller = new AbortController();
    const old = await context.service.preview();
    context.setPages([{ items: [item(B)], has_more: false }]);
    await assert.rejects(context.service.preview('all', { signal: controller.signal, onOutput: () => controller.abort() }));
    await assert.rejects(context.service.execute(old.previewId));
    assert.equal(context.readReport().state, 'cancelled');
    assert.deepEqual(context.removed, []);
});

test('a changed credential during detail verification prevents the pending deletion', async t => {
    const context = setup(t);
    const preview = await context.service.preview();
    const originalRequest = context.service.request;
    context.service.request = async (...args) => {
        const result = await originalRequest(...args);
        if (args[0].includes('/detail?')) context.setCookie(COOKIE.replace('secret-session', 'changed-session'));
        return result;
    };
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
});

test('a keep ID added during detail verification prevents the pending deletion', async t => {
    const context = setup(t);
    const preview = await context.service.preview();
    const originalRequest = context.service.request;
    context.service.request = async (...args) => {
        const result = await originalRequest(...args);
        if (args[0].includes('/detail?')) context.settings.cleanupKeepIds = ORIGINAL;
        return result;
    };
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.skipped, 2);
    assert.deepEqual(context.removed, []);
});

test('corrupt ledger blocks deletion before any post and preserves existing data', async t => {
    const context = setup(t);
    const preview = await context.service.preview();
    const ledgerFile = path.join(context.runtime, 'repost-ledger.json');
    fs.writeFileSync(ledgerFile, '{broken');
    await assert.rejects(context.service.execute(preview.previewId));
    assert.deepEqual(context.removed, []);
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), '{broken');
});

test('default deletion delay allows cancellation after one post', { timeout: 2000 }, async t => {
    const controller = new AbortController(), removed = [];
    const context = setup(t, { service: { interval: undefined, remove: async id => {
        removed.push(id);
        setImmediate(() => controller.abort());
    } } });
    const preview = await context.service.preview();
    await assert.rejects(context.service.execute(preview.previewId, { signal: controller.signal }));
    assert.deepEqual(removed, [A]);
    assert.equal(context.readReport().state, 'cancelled');
});

test('manual reposts preview and delete own forwards whose originals no longer exist', async t => {
    const context = setup(t);
    const missing = item(A), deleted = item(B);
    delete missing.orig;
    deleted.orig = { type: 'DYNAMIC_TYPE_NONE' };
    context.setPages([{ items: [missing, deleted], has_more: false }]);
    context.setDetails(new Map([[A, missing], [B, deleted]]));
    context.writeLedger([
        { repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null, extra: 'retain' },
        { repostId: B, originalId: '8007199254740993124', ownerUid: UID, deletedAt: null },
        { repostId: A, originalId: ORIGINAL, ownerUid: '456', deletedAt: null },
        { repostId: C, originalId: ORIGINAL, ownerUid: UID, deletedAt: null }
    ]);
    const preview = await context.service.preview('reposts');
    assert.deepEqual(preview.items.map(entry => [entry.id, entry.originalId]), [[A, null], [B, null]]);
    assert.deepEqual(context.removed, []);
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.deleted, 2);
    assert.deepEqual(context.removed, [A, B]);
    const records = context.readLedger().records;
    assert.equal(typeof records[0].deletedAt, 'string');
    assert.equal(typeof records[1].deletedAt, 'string');
    assert.equal(records[0].extra, 'retain');
    assert.equal(records[2].deletedAt, null);
    assert.equal(records[3].deletedAt, null);
});

test('all scope permits missing original IDs but rejects explicitly malformed and self original IDs', async t => {
    const context = setup(t);
    const missing = item(A), deleted = item(B);
    delete missing.orig;
    deleted.orig = { type: 'DYNAMIC_TYPE_NONE' };
    context.setPages([{ items: [missing, deleted,
        item(C, { original: C }), item('9007199254740993126', { original: 'invalid' }),
        item('9007199254740993127', { original: null }),
        item('9007199254740993128', { original: Number(ORIGINAL) }),
        item('9007199254740993129', { original: '' })], has_more: false }]);
    context.setDetails(new Map([[A, missing], [B, deleted]]));
    const preview = await context.service.preview('all');
    assert.deepEqual(preview.items.map(entry => entry.id), [A, B]);
    assert.equal(preview.skipped, 5);
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.deleted, 2);
    assert.deepEqual(context.removed, [A, B]);
});

test('a nonempty keep list excludes forwards with unknown originals during preview or execution', async t => {
    const context = setup(t);
    const missing = item(A);
    missing.orig = { type: 'DYNAMIC_TYPE_NONE' };
    context.setPages([{ items: [missing, item(B)], has_more: false }]);
    context.setDetails(new Map([[A, missing], [B, item(B)]]));
    context.settings.cleanupKeepIds = C;
    const protectedPreview = await context.service.preview('reposts');
    assert.deepEqual(protectedPreview.items.map(entry => entry.id), [B]);
    context.settings.cleanupKeepIds = '';
    context.setPages([{ items: [missing, item(B)], has_more: false }]);
    const preview = await context.service.preview('all');
    assert.deepEqual(preview.items.map(entry => entry.id), [A, B]);
    context.settings.cleanupKeepIds = C;
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.skipped, 1);
    assert.deepEqual(context.removed, [B]);
});

test('recorded scope still requires the ledger original ID in the current detail', async t => {
    const context = setup(t);
    const missing = item(A), deleted = item(B);
    delete missing.orig;
    deleted.orig = { type: 'DYNAMIC_TYPE_NONE' };
    context.writeLedger([{ repostId: A, originalId: ORIGINAL, ownerUid: UID, deletedAt: null },
        { repostId: B, originalId: ORIGINAL, ownerUid: UID, deletedAt: null }]);
    context.setDetails(new Map([[A, missing], [B, deleted]]));
    const preview = await context.service.preview('recorded');
    assert.equal(preview.count, 0);
    assert.equal(preview.canExecute, false);
    assert.deepEqual(context.removed, []);
});

test('a keep list added during detail verification also protects an unknown original', async t => {
    const context = setup(t), missing = item(A);
    delete missing.orig;
    context.setPages([{ items: [missing, item(B)], has_more: false }]);
    context.setDetails(new Map([[A, missing], [B, item(B)]]));
    const preview = await context.service.preview('reposts');
    assert.deepEqual(preview.items.map(entry => entry.id), [A, B]);
    const originalRequest = context.service.request;
    context.service.request = async (...args) => {
        const response = await originalRequest(...args);
        if (args[0].includes('/detail?')) context.settings.cleanupKeepIds = C;
        return response;
    };
    const result = await context.service.execute(preview.previewId);
    assert.equal(result.skipped, 1);
    assert.deepEqual(context.removed, [B]);
});
