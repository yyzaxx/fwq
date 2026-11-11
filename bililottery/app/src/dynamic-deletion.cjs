const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { extractCookie, splitList, writeJsonAtomic } = require('./config.cjs');
const { requestBili, verifyAccount, validDynamicId, removeDynamic } = require('./bili-api.cjs');

const GRANT_LIFETIME = 15 * 60 * 1000;
const SCOPES = new Set(['reposts', 'recorded', 'all']);
const STATES = new Set(['idle', 'scanning', 'preview', 'deleting', 'completed', 'simulated', 'cancelled', 'failed', 'expired', 'interrupted']);
const STOP_CODES = new Set([-101, -102, -111, -352, -403, -412, -509, 401, 403, 412, 429, 61000, 61002, 65006]);
const fingerprint = cookie => crypto.createHash('sha256').update(cookie).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = value => new Date(value).toISOString();

function operationError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    return error;
}

function publicItem(item) {
    return { id: item.id, type: item.type, originalId: item.originalId || null,
        text: String(item.text || '').slice(0, 200), url: `https://t.bilibili.com/${item.id}`,
        status: ['pending', 'deleted', 'skipped', 'simulated'].includes(item.status) ? item.status : 'pending' };
}

class DynamicDeletion {
    constructor(runtime, getSettings, options = {}) {
        this.runtime = runtime;
        this.getSettings = getSettings;
        this.request = options.request || requestBili;
        this.remove = options.remove || removeDynamic;
        this.interval = options.interval === undefined ? 8000 : Math.max(0, Number(options.interval) || 0);
        this.maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : 1000;
        this.now = typeof options.now === 'function' ? options.now : () => options.now ?? Date.now();
        this.file = path.join(runtime, 'manual-dynamics.json');
        this.busy = false;
        this.grant = null;
        this.report = this._empty();
        this._restore();
    }

    _empty(scope = 'reposts') {
        return { state: 'idle', scope, uid: '', count: 0, total: 0, scanned: 0, deleted: 0, skipped: 0,
            simulated: 0, processed: 0, dryRun: true, previewOnly: true, items: [], startedAt: null,
            completedAt: null, expiresAt: null, error: null };
    }

    _restore() {
        if (!fs.existsSync(this.file)) return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved.version !== 1 || !STATES.has(saved.state)) return;
            const state = ['scanning', 'deleting'].includes(saved.state) ? 'interrupted'
                : saved.state === 'preview' ? 'expired' : saved.state;
            this.report = { ...this._empty(SCOPES.has(saved.scope) ? saved.scope : 'reposts'), state,
                uid: /^\d{1,22}$/.test(saved.uid) ? String(saved.uid) : '',
                dryRun: saved.dryRun !== false, previewOnly: saved.previewOnly !== false,
                items: Array.isArray(saved.items) ? saved.items.filter(entry => validDynamicId(entry?.id))
                    .slice(0, 50).map(publicItem) : [],
                error: ['interrupted', 'expired', 'failed'].includes(state) ? '上次任务已停止，请重新预览' : null };
            for (const key of ['count', 'total', 'scanned', 'deleted', 'skipped', 'simulated', 'processed']) this.report[key] = integer(saved[key]);
            for (const key of ['startedAt', 'completedAt', 'expiresAt']) {
                if (typeof saved[key] === 'string' && Number.isFinite(Date.parse(saved[key]))) this.report[key] = saved[key];
            }
            this._persist();
        } catch {
            this.report = this._empty();
            this.report.state = 'interrupted';
            this.report.error = '上次清理报告无法读取，请重新预览';
        }
    }

    getState() {
        const liveGrant = this.grant && this.report.state === 'preview' && this.now() < this.grant.expiresAt;
        return { ...this.report, items: this.report.items.map(publicItem),
            state: this.grant && this.report.state === 'preview' && !liveGrant ? 'expired' : this.report.state,
            previewId: liveGrant ? this.grant.id : null, canExecute: Boolean(liveGrant && !this.busy && this.report.count), busy: this.busy };
    }

    _persist() {
        const report = this.getState();
        writeJsonAtomic(this.file, { version: 1, ...report, previewId: null, canExecute: false, busy: false });
    }

    _output(params, text) {
        try { params.onOutput?.(`[手动清理] ${text}\n`); } catch { /* Reporting must not change deletion progress. */ }
    }

    _checkCredentials(account) {
        const settings = this.getSettings();
        if (String(settings.uid || '').trim() !== account.uid || fingerprint(extractCookie(this.runtime)) !== fingerprint(account.cookie)) {
            throw operationError('账号或登录凭证已改变，请重新预览', 409);
        }
        return settings;
    }

    _candidate(item, uid, scope, keep) {
        if (!validDynamicId(item?.id_str) || String(item.modules?.module_author?.mid) !== uid
            || typeof item.type !== 'string' || !/^DYNAMIC_TYPE_[A-Z_]+$/.test(item.type) || item.type === 'DYNAMIC_TYPE_NONE') return null;
        const forward = item.type === 'DYNAMIC_TYPE_FORWARD';
        if (scope !== 'all' && !forward) return null;
        let originalId = forward ? item.orig?.id_str : null;
        if (forward && originalId === undefined) {
            // Manual cleanup can remove an owned repost after its source disappears.
            // A keep list requires a known original so source protection stays reliable.
            if (scope === 'recorded' || keep.size) return null;
            originalId = null;
        } else if (forward && (!validDynamicId(originalId) || originalId === item.id_str)) return null;
        if (keep.has(item.id_str) || keep.has(originalId)) return null;
        return { id: item.id_str, type: item.type, originalId, text: item.modules?.module_dynamic?.desc?.text || '', status: 'pending' };
    }

    _add(item, items) {
        items.push(item);
        this.report.count = this.report.total = items.length;
        if (this.report.items.length < 50) this.report.items.push(publicItem(item));
    }

    _readLedger() {
        const file = path.join(this.runtime, 'repost-ledger.json');
        if (!fs.existsSync(file)) return null;
        try {
            const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (ledger.version !== 1 || !Array.isArray(ledger.records)) throw new Error();
            return ledger;
        } catch { throw operationError('转发清理记录无法读取，已停止'); }
    }

    _canSkip(error, signal) {
        if (signal?.aborted || error?.name === 'AbortError') return false;
        const code = Number(error?.code);
        return Number.isFinite(code) && error?.code != null && !STOP_CODES.has(code)
            && !/登录|风控|频繁|csrf|rate.?limit|unauthor|forbidden/i.test(String(error.message || ''));
    }

    async _previewRecorded(account, keep, items, params) {
        const seen = new Set(), ledger = this._readLedger();
        for (const record of ledger?.records || []) {
            params.signal?.throwIfAborted();
            if (!record || !validDynamicId(record.repostId) || !validDynamicId(record.originalId)
                || record.repostId === record.originalId || String(record.ownerUid) !== account.uid || record.deletedAt
                || keep.has(record.repostId) || keep.has(record.originalId)) {
                this.report.skipped++;
                continue;
            }
            if (seen.has(record.repostId)) continue;
            seen.add(record.repostId);
            this.report.scanned++;
            try {
                const data = await this.request(`/x/polymer/web-dynamic/v1/detail?id=${record.repostId}&features=itemOpusStyle`, account.cookie, params.signal);
                const candidate = this._candidate(data?.item, account.uid, 'recorded', keep);
                if (candidate && candidate.id === record.repostId && candidate.originalId === record.originalId) this._add(candidate, items);
                else this.report.skipped++;
            } catch (error) {
                if (!this._canSkip(error, params.signal)) throw error;
                this.report.skipped++;
            }
            this._persist();
            this._output(params, `已检查 ${this.report.scanned} 条工具记录，符合范围 ${items.length} 条`);
        }
    }

    _settingsForGrant(grant) {
        const settings = this.getSettings();
        if (String(settings.uid || '').trim() !== grant.uid || fingerprint(extractCookie(this.runtime)) !== grant.fingerprint
            || (settings.dryRun !== false) !== grant.dryRun) {
            throw operationError('账号、凭证或模拟设置已改变，请重新预览', 409);
        }
        return settings;
    }

    _progress(item, status, params) {
        item.status = status;
        const visible = this.report.items.find(entry => entry.id === item.id);
        if (visible) visible.status = status;
        this.report.processed++;
        if (status === 'deleted') this.report.deleted++;
        if (status === 'simulated') this.report.simulated++;
        if (status === 'skipped') this.report.skipped++;
        this._persist();
        this._output(params, `${status === 'deleted' ? '已删除' : status === 'simulated' ? '模拟删除' : '已跳过'}动态 ${item.id}`);
    }

    _markLedgerDeleted(item, uid) {
        const ledger = this._readLedger();
        if (!ledger) return;
        let changed = false;
        for (const record of ledger.records) {
            if (record && record.repostId === item.id && String(record.ownerUid) === uid
                && (item.originalId === null || record.originalId === item.originalId) && !record.deletedAt) {
                record.deletedAt = iso(this.now());
                changed = true;
            }
        }
        if (changed) writeJsonAtomic(path.join(this.runtime, 'repost-ledger.json'), ledger);
    }

    _fail(error, params) {
        const aborted = params.signal?.aborted || error?.name === 'AbortError';
        const message = aborted ? '动态清理已取消' : '动态清理已停止，请核对账号或接口状态后重新预览';
        this.grant = null;
        this.report.state = aborted ? 'cancelled' : 'failed';
        this.report.error = message;
        this.report.completedAt = iso(this.now());
        this._persist();
        this._output(params, message);
        const safe = operationError(message, aborted ? 409 : 400);
        if (aborted) safe.code = 'ABORT_ERR';
        else if (typeof error?.code === 'number') safe.code = error.code;
        return safe;
    }

    async preview(scope = 'reposts', params = {}) {
        if (this.busy) throw operationError('已有动态清理任务正在运行', 409);
        if (!SCOPES.has(scope)) throw operationError('请选择有效的动态清理范围');
        this.busy = true;
        this.grant = null;
        this.report = this._empty(scope);
        this.report.state = 'scanning';
        this.report.startedAt = iso(this.now());
        try {
            this._persist();
            params.signal?.throwIfAborted();
            const settings = this.getSettings();
            const account = await verifyAccount(this.runtime, settings, { request: this.request, signal: params.signal });
            this.report.uid = account.uid;
            this.report.dryRun = settings.dryRun !== false;
            const keep = new Set(splitList(settings.cleanupKeepIds)), items = [], seen = new Set(), cursors = new Set(['']);
            let offset = '';
            if (scope === 'recorded') await this._previewRecorded(account, keep, items, params);
            else for (let page = 0; page < this.maxPages; page++) {
                params.signal?.throwIfAborted();
                const data = await this.request(`/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(account.uid)}&features=itemOpusStyle&offset=${encodeURIComponent(offset)}`, account.cookie, params.signal);
                if (!Array.isArray(data?.items) || ![true, false, 0, 1].includes(data.has_more)) throw operationError('动态列表响应无效，已停止');
                for (const raw of data.items) {
                    params.signal?.throwIfAborted();
                    if (!validDynamicId(raw?.id_str)) { this.report.skipped++; continue; }
                    if (seen.has(raw.id_str)) continue;
                    seen.add(raw.id_str);
                    this.report.scanned++;
                    const candidate = this._candidate(raw, account.uid, scope, keep);
                    if (candidate) this._add(candidate, items);
                    else this.report.skipped++;
                }
                this._persist();
                this._output(params, `已扫描 ${this.report.scanned} 条动态，符合范围 ${items.length} 条`);
                if (!data.has_more) break;
                if (typeof data.offset !== 'string' || !data.offset || cursors.has(data.offset) || page + 1 >= this.maxPages) {
                    throw operationError('动态分页异常或超过扫描上限，已停止');
                }
                offset = data.offset;
                cursors.add(offset);
            }
            params.signal?.throwIfAborted();
            this._checkCredentials(account);
            const completed = this.now();
            this.grant = { id: crypto.randomBytes(24).toString('hex'), uid: account.uid,
                fingerprint: fingerprint(account.cookie), scope, items, dryRun: this.report.dryRun, expiresAt: completed + GRANT_LIFETIME };
            this.report.state = 'preview';
            this.report.completedAt = iso(completed);
            this.report.expiresAt = iso(this.grant.expiresAt);
            this._persist();
        } catch (error) {
            throw this._fail(error, params);
        } finally {
            this.busy = false;
        }
        return this.getState();
    }

    async execute(previewId, params = {}) {
        if (this.busy) throw operationError('已有动态清理任务正在运行', 409);
        const grant = this.grant;
        if (!grant || typeof previewId !== 'string' || previewId !== grant.id || this.report.state !== 'preview') {
            throw operationError('清理预览无效或已使用，请重新预览', 409);
        }
        if (this.now() >= grant.expiresAt || !grant.items.length) {
            this.grant = null;
            this.report.state = 'expired';
            this._persist();
            throw operationError('清理预览已过期或没有可删除动态，请重新预览', 409);
        }
        // Consume the grant synchronously, before credentials or any remote operation.
        this.busy = true;
        this.grant = null;
        this.report.state = 'deleting';
        this.report.completedAt = null;
        try {
            this._persist();
            params.signal?.throwIfAborted();
            const settings = this._settingsForGrant(grant);
            const account = await verifyAccount(this.runtime, settings, { request: this.request, signal: params.signal });
            if (account.uid !== grant.uid || fingerprint(account.cookie) !== grant.fingerprint) throw operationError('账号已改变，请重新预览', 409);
            this._readLedger();
            let lastAttemptAt = null;
            for (const item of grant.items) {
                params.signal?.throwIfAborted();
                this._settingsForGrant(grant);
                if (lastAttemptAt !== null && this.interval > 0) {
                    const delay = this.interval - (Date.now() - lastAttemptAt);
                    if (delay > 0) await pause(delay, undefined, { signal: params.signal });
                }
                params.signal?.throwIfAborted();
                const currentSettings = this._settingsForGrant(grant);
                const keep = new Set(splitList(currentSettings.cleanupKeepIds));
                if (keep.has(item.id) || keep.has(item.originalId)) { this._progress(item, 'skipped', params); continue; }
                let current;
                try {
                    const data = await this.request(`/x/polymer/web-dynamic/v1/detail?id=${item.id}&features=itemOpusStyle`, account.cookie, params.signal);
                    current = this._candidate(data?.item, grant.uid, grant.scope, keep);
                } catch (error) {
                    if (!this._canSkip(error, params.signal)) throw error;
                    this._progress(item, 'skipped', params);
                    continue;
                }
                params.signal?.throwIfAborted();
                const finalSettings = this._settingsForGrant(grant), finalKeep = new Set(splitList(finalSettings.cleanupKeepIds));
                if (!current || current.id !== item.id || current.type !== item.type || current.originalId !== item.originalId
                    || finalKeep.has(item.id) || finalKeep.has(item.originalId)
                    || (item.type === 'DYNAMIC_TYPE_FORWARD' && item.originalId === null && finalKeep.size)) {
                    this._progress(item, 'skipped', params);
                    continue;
                }
                if (grant.dryRun) { this._progress(item, 'simulated', params); continue; }
                try {
                    params.signal?.throwIfAborted();
                    lastAttemptAt = Date.now();
                    const result = await this.remove(item.id, account.cookie, params.signal);
                    if (result && typeof result === 'object' && result.code != null && result.code !== 0) {
                        const error = new Error('删除请求被接口拒绝');
                        error.code = result.code;
                        throw error;
                    }
                } catch (error) {
                    if (!this._canSkip(error, params.signal)) throw error;
                    this._progress(item, 'skipped', params);
                    continue;
                }
                this.report.previewOnly = false;
                this._progress(item, 'deleted', params);
                this._markLedgerDeleted(item, grant.uid);
            }
            params.signal?.throwIfAborted();
            this.report.state = grant.dryRun ? 'simulated' : 'completed';
            this.report.completedAt = iso(this.now());
            this._persist();
        } catch (error) {
            throw this._fail(error, params);
        } finally {
            this.busy = false;
        }
        return this.getState();
    }
}

module.exports = { DynamicDeletion };
