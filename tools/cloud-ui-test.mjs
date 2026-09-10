/** 验证云端分类和批量选择最终提交的文件路径，不访问真实网盘。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sources = Object.fromEntries(['cloud', 'panel'].map(name => [
    name, fs.readFileSync(new URL(`../client/${name}.js`, import.meta.url), 'utf8'),
]));
const fixture = [
    ['角色卡/阿岚.png', '角色卡'],
    ['角色卡/小雨.png', '角色卡'],
    ['聊天记录/阿岚/早晨.jsonl', '聊天记录'],
    ['聊天记录/阿岚/夜晚.jsonl', '聊天记录'],
    ['聊天记录/小雨/对话.jsonl', '聊天记录'],
    ['用户人设/旅人/persona.json', '用户人设'],
    ['用户人设/旅人/avatar.png', '用户人设'],
    ['预设/OpenAI Settings/日常.json', '预设'],
    ['预设/QuickReplies/指令.json', '预设'],
    ['预设/QuickReplies/子目录/助手.json', '预设'],
    ['美化/themes/深色.json', '美化'],
    ['美化/backgrounds/书房.jpg', '美化'],
    ['预设/旧文件.json', '预设'],
    ['未知目录/文件.json', '其他'],
    ['.stcb/index.json', '插件元数据'],
].map(([remote, group]) => ({ remote, group, local: '', size: 100, modified: '2026-09-10T00:00:00Z' }));

async function harness(initial = fixture) {
    const ui = new Map();
    const calls = [];
    const handlers = new Map();
    let files = structuredClone(initial);
    let groups = [];
    const buttonIds = ['#stcb-cloud-select-all', '#stcb-cloud-clear-selection', '#stcb-cloud-refresh'];
    function state(selector) {
        if (!ui.has(selector)) ui.set(selector, { text: '', html: '', value: '', scrollTop: 0, attrs: {}, props: {} });
        return ui.get(selector);
    }
    function element(selector) {
        let nodes;
        if (selector === '#stcb-cloud-list .stcb-cloud-group-check') nodes = groups;
        else if (selector === '#stcb-root button') nodes = buttonIds.map(state);
        else if (selector === '#stcb-root button[data-stcb-disabled="true"]') nodes = buttonIds.map(state).filter(n => n.attrs['data-stcb-disabled'] === 'true');
        else nodes = [state(selector)];
        return {
            val(value) { if (value === undefined) return nodes[0]?.value; nodes.forEach(n => n.value = value); return this; },
            text(value) { if (value === undefined) return nodes[0]?.text; nodes.forEach(n => n.text = value); return this; },
            html(value) {
                if (value === undefined) return nodes[0]?.html;
                nodes.forEach(n => { n.html = value; n.scrollTop = 0; });
                if (selector === '#stcb-cloud-list') groups = [...value.matchAll(/class="stcb-cloud-group-check" data-group="([^"]+)"/g)]
                    .map(match => ({ dataset: { group: match[1] }, checked: false, indeterminate: false }));
                return this;
            },
            scrollTop(value) { if (value === undefined) return nodes[0]?.scrollTop; nodes.forEach(n => n.scrollTop = value); return this; },
            prop(key, value) { if (value === undefined) return nodes[0]?.props[key]; nodes.forEach(n => n.props[key] = value); return this; },
            attr(key, value) { if (value === undefined) return nodes[0]?.attrs[key]; nodes.forEach(n => n.attrs[key] = value); return this; },
            each(fn) { nodes.forEach((node, i) => fn.call(node, i, node)); return this; },
            removeClass() { return this; }, addClass() { return this; },
        };
    }
    async function api(action, body) {
        calls.push({ action, body });
        if (handlers.has(action)) return handlers.get(action)(body);
        if (action === 'cloud/list') return { items: structuredClone(files) };
        if (action === 'cloud/download') return { downloaded: body.paths.length, errors: [] };
        throw new Error('Unexpected fixture API: ' + action);
    }
    const context = vm.createContext({ $: element, window: {}, confirm: () => true, console });
    const dependencies = {
        './api.js': { apiWithNames: api },
        './reload.js': { reloadTouched: async () => '' },
        './tavern.js': { currentCharacterName: () => '阿岚' },
        './settings.js': {
            getConfig: () => ({}), describeScope: () => '', setActiveFields() {},
            DEFAULT_INTERVAL_MINUTES: 360, MIN_INTERVAL_MINUTES: 15, MAX_INTERVAL_MINUTES: 10080,
        },
    };
    const modules = new Map();
    for (const [name, exports] of Object.entries(dependencies)) {
        modules.set(name, new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context }));
    }
    const panel = new vm.SourceTextModule(sources.panel, { context });
    await panel.link(name => modules.get(name));
    await panel.evaluate();
    modules.set('./panel.js', panel);
    const cloud = new vm.SourceTextModule(sources.cloud, { context });
    await cloud.link(name => modules.get(name));
    await cloud.evaluate();
    return {
        fn: cloud.namespace, panel: panel.namespace, ui, calls, handlers, element,
        group: name => groups.find(group => group.dataset.group === name),
        replaceFiles: value => { files = structuredClone(value); },
        async search(word) { element('#stcb-cloud-search').val(word); cloud.namespace.renderCloud(); },
        async paths() {
            const before = calls.length;
            await cloud.namespace.downloadSelected();
            const call = calls.slice(before).find(call => call.action === 'cloud/download');
            return call ? Array.from(call.body.paths).sort() : [];
        },
    };
}

test('旧网盘路径分成四个同级类别，QR 和背景仅提交各自的原始路径', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    for (const group of ['预设', 'QR', '美化', '背景图片', '其他', '插件元数据']) assert.ok(h.group(group));
    h.fn.toggleGroup('QR', true);
    assert.deepEqual(await h.paths(), ['预设/QuickReplies/子目录/助手.json', '预设/QuickReplies/指令.json'].sort());
    h.fn.clearSelection();
    h.fn.toggleGroup('背景图片', true);
    assert.deepEqual(await h.paths(), ['美化/backgrounds/书房.jpg']);
    h.fn.clearSelection();
    h.fn.toggleGroup('预设', true);
    assert.deepEqual(await h.paths(), ['预设/OpenAI Settings/日常.json', '预设/旧文件.json'].sort());
});

test('全选包含收起文件夹内的所有文件，分类不改变提交路径', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    assert.doesNotMatch(h.ui.get('#stcb-cloud-list').html, /data-group="[^"]+" open>/);
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), fixture.map(item => item.remote).sort());
    assert.equal(h.ui.get('#stcb-cloud-select-all').props.disabled, true);
});

test('按新分类名称筛选后全选，不选中其他分类', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    await h.search('QR');
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), ['预设/QuickReplies/子目录/助手.json', '预设/QuickReplies/指令.json'].sort());
    h.fn.clearSelection();
    await h.search('背景图片');
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), ['美化/backgrounds/书房.jpg']);
});

test('筛选后的角色卡全选沿用聊天联动，关闭后仅选择角色卡', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    await h.search('角色卡/阿岚.png');
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), ['角色卡/阿岚.png', '聊天记录/阿岚/早晨.jsonl', '聊天记录/阿岚/夜晚.jsonl'].sort());
    h.fn.clearSelection();
    h.fn.toggleLink();
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), ['角色卡/阿岚.png']);
});

test('只搜到人设头像时，全选仍包含对应 persona.json', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    await h.search('avatar.png');
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), ['用户人设/旅人/avatar.png', '用户人设/旅人/persona.json']);
});

test('取消选择清空隐藏勾选；无匹配时不会新增选择', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    h.fn.selectVisible();
    await h.search('不存在的文件');
    assert.equal(h.ui.get('#stcb-cloud-clear-selection').props.disabled, false);
    h.fn.clearSelection();
    h.fn.selectVisible();
    assert.deepEqual(await h.paths(), []);
    assert.equal(h.ui.get('#stcb-cloud-clear-selection').props.disabled, true);
    await h.search('');
    assert.deepEqual(await h.paths(), []);
});

test('单文件勾选更新分组的半选和全选状态', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    h.fn.toggleItem('预设/QuickReplies/指令.json', true);
    assert.equal(h.group('QR').checked, false);
    assert.equal(h.group('QR').indeterminate, true);
    h.fn.toggleItem('预设/QuickReplies/子目录/助手.json', true);
    assert.equal(h.group('QR').checked, true);
    assert.equal(h.group('QR').indeterminate, false);
    h.fn.clearSelection();
    assert.equal(h.group('QR').checked, false);
    assert.equal(h.group('QR').indeterminate, false);
});

test('全选、清空和切换联动保留列表滚动位置及展开状态', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    h.fn.noteToggle('角色卡', true);
    h.fn.renderCloud();
    h.element('#stcb-cloud-list').scrollTop(140);
    for (const action of ['selectVisible', 'clearSelection', 'toggleLink']) {
        h.fn[action]();
        assert.equal(h.element('#stcb-cloud-list').scrollTop(), 140);
        assert.match(h.ui.get('#stcb-cloud-list').html, /data-group="角色卡" open>/);
    }
});

test('刷新结束后保留正确禁用态，忙碌中重绘不会启用选择图标', async () => {
    const h = await harness([]);
    await h.fn.refreshCloud();
    assert.equal(h.ui.get('#stcb-cloud-select-all').props.disabled, true);
    assert.equal(h.ui.get('#stcb-cloud-clear-selection').props.disabled, true);
    h.replaceFiles(fixture);
    await h.fn.refreshCloud();
    assert.equal(h.ui.get('#stcb-cloud-select-all').props.disabled, false);
    assert.equal(h.ui.get('#stcb-cloud-clear-selection').props.disabled, true);
    h.fn.selectVisible();
    h.panel.setBusy(true);
    await h.search('QR');
    assert.equal(h.ui.get('#stcb-cloud-clear-selection').props.disabled, true);
    h.panel.setBusy(false);
    assert.equal(h.ui.get('#stcb-cloud-clear-selection').props.disabled, false);
    assert.equal(h.ui.get('#stcb-cloud-select-all').props.disabled, true);
});

test('刷新后剔除已消失文件，仍保留存活文件的勾选', async () => {
    const h = await harness();
    await h.fn.refreshCloud();
    h.fn.selectVisible();
    h.replaceFiles(fixture.filter(item => item.group === '美化'));
    await h.fn.refreshCloud();
    assert.deepEqual(await h.paths(), ['美化/backgrounds/书房.jpg', '美化/themes/深色.json']);
});
