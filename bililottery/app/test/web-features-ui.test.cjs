const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function element() {
    const classes = new Set(), listeners = new Map();
    return {
        value: '', textContent: '', disabled: false, open: false, children: [],
        classList: {
            contains: name => classes.has(name),
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            toggle(name, force) {
                const present = force === undefined ? !classes.has(name) : force;
                if (present) classes.add(name); else classes.delete(name);
                return present;
            }
        },
        addEventListener(name, callback) { listeners.set(name, callback); },
        click() { if (!this.disabled) return listeners.get('click')?.(); },
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        showModal() { this.open = true; },
        close() { this.open = false; }
    };
}

function fixture({ holdSave = false } = {}) {
    const nodes = new Map(), saved = deferred(), preview = deferred();
    const deletes = [], previews = [];
    const $ = selector => {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
    };
    let state = {
        settings: { uid: '123', dryRun: false },
        account: { loggedIn: false }, process: { running: false }, wins: {},
        dynamicDeletion: {
            state: 'preview', scope: 'all', uid: '123', count: 2, total: 2,
            scanned: 2, deleted: 0, skipped: 0, simulated: 0, processed: 0,
            dryRun: false, previewOnly: true, canExecute: true,
            previewId: 'old-all-grant', items: []
        }
    };
    const window = {
        lotteryDesktop: {
            previewDynamics(scope) { previews.push(scope); return preview.promise; },
            async deleteDynamics(previewId) { deletes.push(previewId); return state; },
            async dynamicStatus() { return state.dynamicDeletion; },
            async refreshWins() { return state; },
            async stop() {},
            async openExternal() {}
        },
        async saveSettings() {
            await saved.promise;
            // The real renderer applies the full saved state before returning.
            window.updateState(state);
            return state;
        },
        updateState(value) { state = value; window.biliFeatures.update(value); },
        async refresh() {}, showToast() {}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/features.js'), 'utf8'), {
        window,
        document: { querySelector: $, querySelectorAll: () => [], createElement: element },
        setTimeout: () => 1, clearTimeout() {}, setInterval() {}, Date
    }, { filename: 'web/features.js' });
    window.biliFeatures.update(state);
    $('#dynamic-scope').value = 'reposts';
    if (!holdSave) saved.resolve();
    return {
        $, deletes, previews, saved, preview,
        resolvePreview() {
            preview.resolve({ ...state, dynamicDeletion: {
                ...state.dynamicDeletion, scope: 'reposts', count: 1, total: 1,
                previewId: 'new-reposts-grant'
            } });
        }
    };
}

const nextTurn = () => new Promise(setImmediate);

test('requesting a replacement preview disables the prior grant before settings finish saving', async () => {
    const ui = fixture({ holdSave: true });
    const pending = ui.$('#btn-dynamics-preview').click();
    assert.equal(ui.$('#btn-dynamic-confirm').disabled, true,
        'the old all-dynamics confirmation must be disabled synchronously');
    assert.equal(ui.$('#btn-dynamic-confirm').classList.contains('hidden'), true);
    ui.saved.resolve();
    await nextTurn();
    assert.equal(ui.$('#btn-dynamic-confirm').disabled, true,
        'the old state returned by saving settings must not restore confirmation');
    ui.resolvePreview();
    await pending;
});

test('a pending reposts preview cannot submit the prior all-dynamics deletion grant', async () => {
    const ui = fixture();
    const pending = ui.$('#btn-dynamics-preview').click();
    await nextTurn();
    assert.deepEqual(ui.previews, ['reposts']);
    await ui.$('#btn-dynamic-confirm').click();
    assert.deepEqual(ui.deletes, [], 'no old grant may be submitted while its replacement is pending');
    ui.resolvePreview();
    await pending;
});

test('a late preview response cannot restore confirmation after the user cancels it', async () => {
    const ui = fixture();
    const pending = ui.$('#btn-dynamics-preview').click();
    await nextTurn();
    await ui.$('#btn-dynamic-close').click();
    assert.equal(ui.$('#dynamic-delete-dialog').open, false);
    ui.resolvePreview();
    await pending;
    assert.equal(ui.$('#dynamic-delete-dialog').open, false,
        'a cancelled request must not reopen its dialog');
    assert.equal(ui.$('#btn-dynamic-confirm').disabled, true,
        'a cancelled request must not enable its late grant');
    await ui.$('#btn-dynamic-confirm').click();
    assert.deepEqual(ui.deletes, []);
});
