/** 使用独立时钟和接口夹具验证前端检查、状态归属与上传记录。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const backupSource = fs.readFileSync(new URL('../client/backup.js', import.meta.url), 'utf8');
const panelSource = fs.readFileSync(new URL('../client/panel.js', import.meta.url), 'utf8');
const drain = () => new Promise(resolve => setImmediate(resolve));

function preview(label = '世界书/测试世界书.json') {
    return {
        scopeText: '全部世界书',
        plan: {
            counts: { upload: 1, download: 1, unchanged: 2 },
            uploadCategories: { worlds: 1 },
            upload: [{ path: 'worlds/book.json', label, reason: 'differs' }],
            download: [{ path: 'worlds/book.json', label, reason: 'differs' }],
            plaintextRemaining: 0, truncated: false,
            checkedAt: '2026-09-06T12:00:00.000Z', remoteCheckedAt: '2026-09-06T12:00:00.000Z',
        },
    };
}

async function harness() {
    let now = Date.parse('2026-09-06T12:00:00.000Z');
    let nextTimer = 1;
    const timers = new Map();
    const calls = [];
    const ui = new Map();
    const handlers = new Map();
    const config = {
        activeProfileId: 'one', url: 'https://fixture.example/dav/', username: '', remotePath: 'backup',
        scope: { worlds: { all: true, selected: [] } },
        auto: { enabled: false, onChatEvents: true, intervalMinutes: 15 }, lastBackupAt: '',
    };
    const responses = {
        'backup/activity': { activity: { lastRun: null, runs: [] } },
        'backup/changes': preview(),
        'backup/plan': preview(),
    };
    function element(selector) {
        if (!ui.has(selector)) ui.set(selector, { text: '', html: '', classes: new Set(), props: {} });
        const state = ui.get(selector);
        return {
            text(value) { if (value === undefined) return state.text; state.text = value; return this; },
            html(value) { if (value === undefined) return state.html; state.html = value; return this; },
            empty() { state.html = ''; return this; },
            prop(name, value) { state.props[name] = value; return this; },
            removeClass(names) { for (const name of names.split(' ')) state.classes.delete(name); return this; },
            addClass(name) { state.classes.add(name); return this; },
        };
    }
    function uploaded() {
        const at = new Date(now).toISOString();
        const files = [{ path: 'worlds/book.json', label: '世界书/测试世界书.json', bytes: 80 }];
        const lastRun = { at, uploaded: 1, skipped: 2, failed: 0 };
        return {
            uploaded: 1, downloaded: 0, uploadedFiles: files, skipped: 2, errors: [],
            lastBackupAt: at, plaintextRemaining: 0,
            activity: { lastRun, runs: [{ ...lastRun, files, errors: [] }] },
        };
    }
    async function api(action, body) {
        calls.push({ action, body });
        if (handlers.has(action)) return handlers.get(action)(body);
        if (action === 'backup/upload') return uploaded();
        if (!Object.hasOwn(responses, action)) throw new Error('Unexpected fixture API: ' + action);
        return structuredClone(responses[action]);
    }
    function schedule(fn, delay, repeat) {
        const id = nextTimer++;
        timers.set(id, { fn, at: now + delay, repeat });
        return id;
    }
    class FixtureDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const document = { visibilityState: 'visible' };
    const context = vm.createContext({
        Date: FixtureDate, document, $: element,
        window: { toastr: { success() {}, warning() {} } },
        confirm: () => true,
        setTimeout: (fn, delay) => schedule(fn, delay, 0),
        clearTimeout: id => timers.delete(id),
        setInterval: (fn, delay) => schedule(fn, delay, delay),
        clearInterval: id => timers.delete(id),
    });
    const dependencies = {
        './api.js': { api, apiWithNames: api },
        './settings.js': {
            getConfig: () => config, describeScope: () => '全部世界书',
            setActiveFields: fields => Object.assign(config, fields),
            DEFAULT_INTERVAL_MINUTES: 360, MIN_INTERVAL_MINUTES: 15, MAX_INTERVAL_MINUTES: 10080,
        },
        './cloud.js': { refreshCloud: async () => {} },
        './reload.js': { reloadTouched: async () => '' },
    };
    const modules = new Map();
    for (const [name, exports] of Object.entries(dependencies)) {
        modules.set(name, new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context }));
    }
    const panel = new vm.SourceTextModule(panelSource, { context });
    await panel.link(name => modules.get(name));
    await panel.evaluate();
    modules.set('./panel.js', panel);
    const module = new vm.SourceTextModule(backupSource, { context });
    await module.link(name => modules.get(name));
    await module.evaluate();

    async function advance(duration) {
        const until = now + duration;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            const [id, timer] = due;
            now = timer.at;
            if (timer.repeat) timer.at += timer.repeat;
            else timers.delete(id);
            await timer.fn();
            await drain();
        }
        now = until;
        await drain();
    }
    return {
        fn: module.namespace, panel: panel.namespace, config, responses, handlers, calls, ui, document,
        advance, element, uploaded,
        count: action => calls.filter(call => call.action === action).length,
        now: () => now,
        async init() { await module.namespace.resetBackupMonitor(); await advance(0); },
    };
}

test('关闭自动上传也会自动显示本地可更新范围', async () => {
    const h = await harness();
    await h.init();
    assert.equal(h.count('backup/changes'), 1);
    assert.equal(h.count('backup/upload'), 0);
    assert.match(h.ui.get('#stcb-preview-report').html, /本地可更新：世界书 1 个文件/);
    assert.match(h.ui.get('#stcb-preview-report').html, /世界书\/测试世界书.json/);
});

test('每三十秒检查，页面隐藏时暂停本地扫描', async () => {
    const h = await harness();
    await h.init();
    h.fn.startBackupMonitor();
    await h.advance(29999);
    assert.equal(h.count('backup/changes'), 1);
    await h.advance(1);
    assert.equal(h.count('backup/changes'), 2);
    h.document.visibilityState = 'hidden';
    await h.advance(30000);
    assert.equal(h.count('backup/changes'), 2);
    h.document.visibilityState = 'visible';
    h.fn.queueChanges(0);
    await h.advance(0);
    assert.equal(h.count('backup/changes'), 3);
});

test('连续聊天事件合并为一次检查，不依赖自动上传开关', async () => {
    const h = await harness();
    await h.init();
    for (let index = 0; index < 3; index++) {
        h.fn.autoQueue('auto-chat');
        await h.advance(100);
    }
    await h.advance(4900);
    assert.equal(h.count('backup/changes'), 2);
    assert.equal(h.count('backup/upload'), 0);
});

test('生成期间暂停检查和上传，生成结束后继续检查', async () => {
    const h = await harness();
    h.config.auto.enabled = true;
    await h.init();
    h.fn.setGenerating(true);
    await h.fn.checkChanges();
    await h.fn.autoMaybeRun('auto');
    assert.equal(h.count('backup/changes'), 1);
    assert.equal(h.count('backup/upload'), 0);
    h.fn.setGenerating(false);
    await h.advance(5000);
    assert.equal(h.count('backup/changes'), 2);
});

test('手动比对结果只写入备份模块', async () => {
    const h = await harness();
    await h.init();
    h.panel.setStatus('配置已保存。');
    h.panel.setAutoStatus('上次自动上传完成。');
    await h.fn.previewBackup();
    assert.match(h.ui.get('#stcb-backup-status').text, /比对完成/);
    assert.equal(h.ui.get('#stcb-status').text, '配置已保存。');
    assert.equal(h.ui.get('#stcb-auto-status').text, '上次自动上传完成。');
});

test('自动上传在自动模块列出文件，保留手动预览结果', async () => {
    const h = await harness();
    h.config.auto.enabled = true;
    await h.init();
    h.panel.setBackupStatus('比对完成。');
    h.panel.setReport('手动上传记录');
    await h.fn.autoMaybeRun('auto');
    assert.equal(h.calls.find(call => call.action === 'backup/upload').body.trigger, 'auto');
    assert.match(h.ui.get('#stcb-auto-status').text, /已上传 1 个文件/);
    assert.match(h.ui.get('#stcb-auto-report').html, /世界书\/测试世界书.json/);
    assert.equal(h.ui.get('#stcb-backup-status').text, '比对完成。');
    assert.equal(h.ui.get('#stcb-report').html, '手动上传记录');
});

test('自动上传间隔从保存的上次执行时间继续计算', async () => {
    const h = await harness();
    h.config.auto.enabled = true;
    h.responses['backup/activity'].activity.lastRun = {
        at: new Date(h.now() - 10 * 60 * 1000).toISOString(), uploaded: 0, skipped: 3, failed: 0,
    };
    await h.init();
    await h.fn.autoMaybeRun('auto');
    assert.equal(h.count('backup/upload'), 0);
    await h.advance(5 * 60 * 1000);
    await h.fn.autoMaybeRun('auto');
    assert.equal(h.count('backup/upload'), 1);
    await h.fn.autoMaybeRun('auto-chat');
    assert.equal(h.count('backup/upload'), 1);
});

test('刷新后仍显示最近实际上传的文件', async () => {
    const h = await harness();
    const activity = h.uploaded().activity;
    activity.lastRun = { ...activity.lastRun, uploaded: 0 };
    h.responses['backup/activity'] = { activity };
    await h.init();
    assert.match(h.ui.get('#stcb-auto-report').html, /测试世界书/);
    assert.match(h.ui.get('#stcb-auto-status').text, /没有待上传文件/);
});

test('切换方案后忽略上一个方案的检查响应', async () => {
    const h = await harness();
    let resolveOld;
    h.handlers.set('backup/changes', () => new Promise(resolve => { resolveOld = resolve; }));
    await h.init();
    h.config.activeProfileId = 'two';
    h.config.remotePath = 'other';
    await h.fn.resetBackupMonitor();
    h.handlers.delete('backup/changes');
    resolveOld(preview('世界书/旧方案文件.json'));
    await drain();
    h.fn.queueChanges(0);
    await h.advance(0);
    assert.doesNotMatch(h.ui.get('#stcb-preview-report').html, /旧方案文件/);
    assert.match(h.ui.get('#stcb-preview-report').html, /测试世界书/);
});

test('手动预览完成后，较早的后台响应不会覆盖它', async () => {
    const h = await harness();
    await h.init();
    let resolveOld;
    h.handlers.set('backup/changes', () => new Promise(resolve => { resolveOld = resolve; }));
    const pending = h.fn.checkChanges();
    h.responses['backup/plan'] = preview('世界书/手动检查.json');
    h.fn.queueChanges();
    await h.fn.previewBackup();
    resolveOld(preview('世界书/较早检查.json'));
    await pending;
    assert.match(h.ui.get('#stcb-preview-report').html, /手动检查/);
    assert.doesNotMatch(h.ui.get('#stcb-preview-report').html, /较早检查/);
    assert.match(h.ui.get('#stcb-backup-status').text, /比对完成/);
});

test('检查失败显示错误并保留上次结果', async () => {
    const h = await harness();
    await h.init();
    const previous = h.ui.get('#stcb-preview-report').html;
    h.handlers.set('backup/changes', () => { throw new Error('fixture offline'); });
    await h.fn.checkChanges();
    assert.match(h.ui.get('#stcb-check-status').text, /检查失败：fixture offline/);
    assert.equal(h.ui.get('#stcb-preview-report').html, previous);
    assert.equal(h.ui.get('#stcb-check-status').classes.has('is-error'), true);
});

test('自动上传失败只在自动模块报错', async () => {
    const h = await harness();
    h.config.auto.enabled = true;
    await h.init();
    h.panel.setBackupStatus('比对完成。');
    h.handlers.set('backup/upload', () => { throw new Error('fixture upload failed'); });
    await h.fn.autoMaybeRun('auto');
    assert.equal(h.ui.get('#stcb-auto-status').text, 'fixture upload failed');
    assert.equal(h.ui.get('#stcb-backup-status').text, '比对完成。');
    assert.equal(h.panel.isBusy(), false);
});

test('自动上传全部失败时显示失败文件', async () => {
    const h = await harness();
    h.config.auto.enabled = true;
    await h.init();
    h.handlers.set('backup/upload', () => {
        const result = h.uploaded();
        result.uploaded = 0;
        result.uploadedFiles = [];
        result.errors = [{ path: 'worlds/book.json', error: 'fixture file failed' }];
        Object.assign(result.activity.lastRun, { uploaded: 0, failed: 1 });
        result.activity.runs = [{ ...result.activity.lastRun, files: [], errors: result.errors }];
        return result;
    });
    await h.fn.autoMaybeRun('auto');
    assert.match(h.ui.get('#stcb-auto-status').text, /已上传 0 个文件，失败 1 个/);
    assert.doesNotMatch(h.ui.get('#stcb-auto-status').text, /没有待上传文件/);
    assert.match(h.ui.get('#stcb-auto-report').html, /worlds\/book.json/);
    assert.match(h.ui.get('#stcb-auto-report').html, /fixture file failed/);
});

test('文件名和错误文本按文字显示', async () => {
    const h = await harness();
    h.config.auto.enabled = true;
    await h.init();
    h.handlers.set('backup/upload', () => {
        const result = h.uploaded();
        result.activity.runs[0].files[0].label = '<img src=x onerror=alert(1)>';
        result.activity.runs[0].errors = [{ path: '<script>', error: '<b>failed</b>' }];
        result.activity.runs[0].failed = 1;
        return result;
    });
    await h.fn.autoMaybeRun('auto');
    const html = h.ui.get('#stcb-auto-report').html;
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<img|<script|<b>failed/);
});
