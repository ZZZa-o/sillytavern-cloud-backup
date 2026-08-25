/** 全部动作：保存配置、测试连接、预览、上传、下载、自动执行。 */
import { api, apiWithNames } from './api.js';
import { getConfig, loadConfig, pushConfig, describeScope, setScopeDirs, setChatCounts, setSynthLists } from './settings.js';
import {
    escHtml,
    setStatus, notify, setReport, withBusy, isBusy,
    fillForm, renderPasswordState, renderScopeText, renderLastBackup, readFormIntoConfig,
} from './panel.js';
import { openScopePopup } from './scope.js';
import { setEmbeddedBooks } from './tavern.js';
import { reloadTouched } from './reload.js';
import { refreshCloud } from './cloud.js';

// ---------------------------------------------------------------------------
// 后端状态与配置
// ---------------------------------------------------------------------------

export async function checkHelper() {
    try {
        const data = await api('status');
        $('#stcb-helper-status').removeClass('is-muted is-error').addClass('is-ok').text('后端已连接');
        renderPasswordState(!!data.hasPassword);
        renderLastBackup(data.lastBackupAt);
        setScopeDirs(data.scopeDirs);
        setChatCounts(data.chatCounts);
        setSynthLists(data);
        return true;
    } catch (error) {
        $('#stcb-helper-status').removeClass('is-muted is-ok').addClass('is-error').text('后端未加载');
        setStatus(`${error.message}（服务端插件只在酒馆启动时加载一次，装好后需要重启酒馆）`, 'error');
        return false;
    }
}

/** 面板初始化：先看后端在不在，在的话把配置拉下来填进表单。 */
export async function bootstrap() {
    if (!await checkHelper()) return;
    try {
        await loadConfig();
        fillForm();
    } catch (error) {
        setStatus(`读取配置失败：${error.message}`, 'error');
    }
    // 不 await：卡多时首次解析要几秒，没必要卡住面板。名单到了再把范围文案重刷一遍。
    refreshEmbeddedBooks().then(renderScopeText);
}

/**
 * 拉取后端解析出的内嵌世界书名单。
 * 失败只是内嵌的书可能重新出现在列表里，不该阻断任何操作。
 */
export async function refreshEmbeddedBooks() {
    try {
        const data = await api('cards/embedded-worlds');
        setEmbeddedBooks(data.books);
    } catch (error) {
        console.warn('[SillyTavern Cloud Backup] 读取内嵌世界书名单失败：', error);
    }
}

export async function saveConfig() {
    readFormIntoConfig();
    const password = $('#stcb-password').val()?.toString() ?? '';

    await withBusy('正在保存配置...', async () => {
        await pushConfig(password);
        fillForm();
        autoTimer();
        setStatus(`配置已保存。当前范围：${describeScope()}`, 'ok');
        notify('success', 'WebDAV 配置已保存');
    }, '保存配置失败。');
}

export async function testConnection() {
    await withBusy('正在测试连接...', async () => {
        const data = await api('test');
        setStatus(data.message || '连接测试通过。', 'ok');
        notify('success', 'WebDAV 连接测试通过');
        await refreshCloud(false);
    }, '连接测试失败。');
}

/** 范围弹窗点了确定就立刻落盘，免得用户以为选完就生效、结果没保存。 */
export async function editScope() {
    // 弹窗要按最新数据渲染：内嵌世界书名单决定哪些世界书该隐藏，
    // status 里的目录清单与每张卡的聊天条数决定文件夹标题上写什么
    await Promise.all([refreshEmbeddedBooks(), checkHelper()]);
    const confirmed = await openScopePopup();
    if (!confirmed) return;
    await withBusy('正在保存备份范围...', async () => {
        await pushConfig();
        renderScopeText();
        setStatus(`备份范围已保存：${describeScope()}`, 'ok');
    }, '保存备份范围失败。');
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

const REASON_LABELS = {
    'local-only': '云端没有',
    'remote-only': '本机没有',
    differs: '两端内容不同',
    'remote-unindexed': '云端文件无索引记录',
};

function pill(label, value) {
    return `<span class="stcb-pill is-muted">${escHtml(label)} ${value}</span>`;
}

function group(summary, lines, open = false) {
    const body = lines.map(line => `<li>${line}</li>`).join('');
    return `<details class="stcb-plan-group"${open ? ' open' : ''}>`
        + `<summary>${escHtml(summary)}</summary>`
        + `<ul class="stcb-plan-list">${body}</ul></details>`;
}

function planLines(entries) {
    return entries.map(item =>
        `${escHtml(item.path)}<br><small>${escHtml(REASON_LABELS[item.reason] || item.reason)}</small>`);
}

export async function previewBackup() {
    await withBusy('正在比对两端差异...', async () => {
        const data = await apiWithNames('backup/plan');
        const plan = data.plan || {};
        const counts = plan.counts || {};

        if (!counts.upload && !counts.download) {
            setReport(`<div class="stcb-meta">范围：${escHtml(data.scopeText || describeScope())}<br>`
                + `两端已经一致，无需变更（${counts.unchanged || 0} 个文件相同）。</div>`);
            setStatus('比对完成：两端已一致。', 'ok');
            return;
        }

        const blocks = [];
        if (counts.upload) blocks.push(group(`点「上传到云端」会推送 · ${counts.upload}`, planLines(plan.upload || [])));
        if (counts.download) blocks.push(group(`点「从云端下载」会拉取 · ${counts.download}`, planLines(plan.download || [])));

        setReport(`<div class="stcb-meta">范围：${escHtml(data.scopeText || describeScope())}`
            + `（相同 ${counts.unchanged || 0}）<br>`
            + `两端内容不同的文件会同时出现在上下两个清单里，按你点哪个按钮决定以谁为准。</div>`
            + blocks.join('')
            + (plan.truncated ? '<div class="stcb-meta">列表仅显示前 40 项。</div>' : ''));

        setStatus(`比对完成：可上传 ${counts.upload || 0} 项，可下载 ${counts.download || 0} 项。`, 'ok');
    }, '比对失败。');
}

function renderResult(data, title) {
    const pills = [
        ['上传', data.uploaded],
        ['下载', data.downloaded],
        ['跳过相同', data.skipped],
    ].filter(([, value]) => Number(value) > 0)
        .map(([label, value]) => pill(label, value))
        .join('');

    const errors = data.errors?.length
        ? group(`失败项 · ${data.errors.length}`, data.errors.map(item =>
            `${escHtml(item.path)}<br><small>${escHtml(item.error)}</small>`), true)
        : '';

    setReport(`<div class="stcb-meta">${escHtml(title)}</div>`
        + `<div class="stcb-statusline">${pills || pill('无变化', '')}</div>`
        + errors);
}

export async function runUpload(reason = 'manual') {
    const c = getConfig();
    if (!c.url) {
        setStatus('请先填写 WebDAV 地址并保存配置。', 'warn');
        return;
    }

    await withBusy(reason === 'manual' ? '正在上传到云端...' : '自动上传进行中...', async () => {
        const data = await apiWithNames('backup/upload');
        renderLastBackup(data.lastBackupAt);
        renderResult(data, `上传完成 · 范围：${describeScope()}`);

        const summary = data.uploaded ? `上传 ${data.uploaded} 个文件` : '云端已是最新';
        if (data.errors?.length) {
            setStatus(`${summary}，${data.errors.length} 项失败。`, 'warn');
            notify('warning', `上传完成，${data.errors.length} 项失败`);
        } else {
            setStatus(`${summary}（跳过相同 ${data.skipped || 0} 个）。`, 'ok');
            if (reason === 'manual') notify('success', `WebDAV 备份完成：${summary}`);
        }
        await refreshCloud(false);
    }, '上传失败。');
}

export async function runDownload() {
    const c = getConfig();
    if (!c.url) {
        setStatus('请先填写 WebDAV 地址并保存配置。', 'warn');
        return;
    }
    if (!confirm(`从云端下载范围内的文件到本机？\n\n范围：${describeScope()}\n本机同名文件会被云端版本覆盖。`)) return;

    await withBusy('正在从云端下载...', async () => {
        const data = await apiWithNames('backup/download');
        renderLastBackup(data.lastBackupAt);
        renderResult(data, `下载完成 · 范围：${describeScope()}`);

        // 角色卡与世界书直接热刷进酒馆，跟手动导入一样，不用重载页面
        const needsReload = await reloadTouched(data);

        const summary = data.downloaded ? `下载 ${data.downloaded} 个文件` : '本机已是最新';
        if (data.errors?.length) {
            setStatus(`${summary}，${data.errors.length} 项失败。`, 'warn');
            notify('warning', `下载完成，${data.errors.length} 项失败`);
        } else {
            setStatus(`${summary}（跳过相同 ${data.skipped || 0} 个）。${needsReload}`, needsReload ? 'warn' : 'ok');
            notify('success', `WebDAV 下载完成：${summary}`);
        }
    }, '下载失败。');
}

// ---------------------------------------------------------------------------
// 自动执行：只做自动上传
// ---------------------------------------------------------------------------

const TICK_MS = 60 * 1000;
const EVENT_DEBOUNCE_MS = 5000;

let timer = null;
let debounceTimer = null;
let lastAutoAt = 0;

function intervalMs() {
    const hours = Math.max(0.25, Number(getConfig().auto.intervalHours) || 6);
    return hours * 60 * 60 * 1000;
}

export async function autoMaybeRun(reason) {
    const c = getConfig();
    if (!c.auto.enabled || isBusy() || !c.url) return;
    if (Date.now() - lastAutoAt < intervalMs()) return;
    lastAutoAt = Date.now();
    await runUpload(reason);
}

export function autoQueue(reason) {
    const c = getConfig();
    if (!c.auto.enabled || !c.auto.onChatEvents) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => autoMaybeRun(reason), EVENT_DEBOUNCE_MS);
}

export function autoTimer() {
    clearInterval(timer);
    timer = null;
    if (!getConfig().auto.enabled) return;
    timer = setInterval(() => autoMaybeRun('auto'), TICK_MS);
}
