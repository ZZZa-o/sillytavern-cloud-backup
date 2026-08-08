/** 全部动作：连接与密码、多端同步、zip 快照、自动执行。 */
import { getRequestHeaders } from '/script.js';

import {
    SECRET_KEY, DEFAULT_SETTINGS,
    getSettings, saveSettings, readFormIntoSettings, getPayloadSettings,
} from './settings.js';
import {
    escHtml, prettyBytes, prettyDate,
    setStatus, notify, setReport, withBusy, isBusy,
} from './panel.js';

const API_BASE = '/api/plugins/webdav-chat-backup';

export async function api(action, payload = {}) {
    const response = await fetch(`${API_BASE}/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { error: text };
    }
    if (!response.ok || data.ok === false) {
        throw new Error(data.error || response.statusText || '请求失败');
    }
    return data;
}

/** 带上当前表单设置调用后端。 */
function apiWithSettings(action, extra = {}) {
    return api(action, { settings: getPayloadSettings(), ...extra });
}

// ---------------------------------------------------------------------------
// 连接与密码
// ---------------------------------------------------------------------------

function updateSyncPill() {
    const s = getSettings();
    $('#wdcb-last-sync').text(s.lastSyncAt ? `上次同步 ${prettyDate(s.lastSyncAt)}` : '尚未同步');
}

function renderPasswordState(saved) {
    $('#wdcb-password-state')
        .toggleClass('is-ok', saved)
        .toggleClass('is-muted', !saved)
        .text(saved ? '密码已保存' : '未保存密码');
}

export async function checkHelper() {
    try {
        const data = await api('status');
        $('#wdcb-helper-status').removeClass('is-muted is-error').addClass('is-ok').text('后端已连接');

        const s = getSettings();
        s.passwordSaved = !!data.hasPassword || !!s.passwordSaved;
        if (data.lastSyncAt) s.lastSyncAt = data.lastSyncAt;
        if (data.device && !s.deviceName) {
            s.deviceName = data.device;
            $('#wdcb-device-name').val(data.device);
        }
        renderPasswordState(!!s.passwordSaved);
        updateSyncPill();
        saveSettings();
        return true;
    } catch {
        $('#wdcb-helper-status').removeClass('is-muted is-ok').addClass('is-error').text('后端未加载');
        return false;
    }
}

export async function savePassword() {
    const value = $('#wdcb-password').val()?.toString() ?? '';
    if (!value) {
        setStatus('没有输入新密码，已保留当前密码。', 'warn');
        return;
    }
    await withBusy('', async () => {
        const response = await fetch('/api/secrets/write', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: SECRET_KEY, value, label: '聊天云同步 (WebDAV)' }),
        });
        if (!response.ok) throw new Error('密码保存失败');
        getSettings().passwordSaved = true;
        $('#wdcb-password').val('');
        renderPasswordState(true);
        saveSettings();
        setStatus('密码已保存。', 'ok');
        notify('success', 'WebDAV 密码已保存');
        await checkHelper();
    }, '密码保存失败。');
}

export async function clearPassword() {
    if (!confirm('清除已保存的 WebDAV 授权密码？')) return;
    await withBusy('', async () => {
        const response = await fetch('/api/secrets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: SECRET_KEY }),
        });
        if (!response.ok && response.status !== 204) throw new Error('密码清除失败');
        getSettings().passwordSaved = false;
        renderPasswordState(false);
        saveSettings();
        setStatus('密码已清除。', 'ok');
        notify('info', 'WebDAV 密码已清除');
    }, '密码清除失败。');
}

export async function testConnection() {
    readFormIntoSettings();
    await withBusy('正在测试连接...', async () => {
        const data = await apiWithSettings('test');
        setStatus(data.message || '连接测试通过。', 'ok');
        notify('success', 'WebDAV 连接测试通过');
        await refreshList(false);
    }, '连接测试失败。');
}

// ---------------------------------------------------------------------------
// 多端同步
// ---------------------------------------------------------------------------

const ACTION_LABELS = {
    upload: '上传到远端',
    download: '下载到本机',
    conflict: '冲突待处理',
    deleteLocal: '删除本机文件',
    deleteRemote: '删除远端文件',
};

const PLAN_ACTIONS = Object.keys(ACTION_LABELS);

function pill(label, value) {
    return `<span class="wdcb-pill is-muted">${escHtml(label)} ${value}</span>`;
}

function group(summary, items, open = false) {
    const body = items.map(item => `<li>${item}</li>`).join('');
    return `<details class="wdcb-plan-group"${open ? ' open' : ''}>`
        + `<summary>${escHtml(summary)}</summary>`
        + `<ul class="wdcb-plan-list">${body}</ul></details>`;
}

function renderPlan(plan, title) {
    const counts = plan.counts || {};
    const present = PLAN_ACTIONS.filter(action => Number(counts[action]) > 0);

    if (!present.length) {
        setReport(`<div class="wdcb-meta">${escHtml(title)}：两端已经一致，无需变更`
            + `（${counts.unchanged || 0} 个文件已同步）。</div>`);
        return;
    }

    const sections = present
        .map(action => group(
            `${ACTION_LABELS[action]} · ${counts[action]}`,
            (plan[action] || []).map(item => escHtml(item.path)),
        ))
        .join('');

    setReport(`<div class="wdcb-meta">${escHtml(title)}（未变更 ${counts.unchanged || 0}）</div>`
        + sections
        + (plan.truncated ? '<div class="wdcb-meta">列表仅显示前 40 项。</div>' : ''));
}

function renderSyncResult(data) {
    const pills = [
        ['上传', data.uploaded],
        ['下载', data.downloaded],
        ['冲突', data.conflicts],
        ['删除本机', data.deletedLocal],
        ['删除远端', data.deletedRemote],
        ['未变更', data.unchanged],
        ['已跳过', data.skipped],
    ].filter(([, value]) => Number(value) > 0)
        .map(([label, value]) => pill(label, value))
        .join('');

    const conflicts = data.conflictFiles?.length
        ? group(`冲突分支 · ${data.conflictFiles.length}`, data.conflictFiles.map(item =>
            `${escHtml(item.path)}<br><small>本机版本另存为：${escHtml(item.kept)}</small>`), true)
        : '';

    const errors = data.errors?.length
        ? group(`失败项 · ${data.errors.length}`, data.errors.map(item =>
            `${escHtml(item.path)}<br><small>${escHtml(item.action)}：${escHtml(item.error)}</small>`), true)
        : '';

    const protection = data.protectionDir
        ? `<div class="wdcb-meta">被覆盖或删除的本机文件已备份到：${escHtml(data.protectionDir)}</div>`
        : '';

    setReport(`<div class="wdcb-statusline">${pills || pill('两端一致', '')}</div>`
        + conflicts + errors + protection);
}

export async function previewSync() {
    readFormIntoSettings();
    await withBusy('正在比对两端差异...', async () => {
        const data = await apiWithSettings('sync/plan');
        const plan = data.plan || {};
        renderPlan(plan, `预览（本机：${data.device || '未知'}）`);
        const counts = plan.counts || {};
        const total = PLAN_ACTIONS.reduce((sum, action) => sum + (Number(counts[action]) || 0), 0);
        setStatus(total ? `比对完成：${total} 项待处理。` : '比对完成：两端已一致。', 'ok');
    }, '比对失败。');
}

export async function runSync(reason = 'manual') {
    readFormIntoSettings();
    const s = getSettings();
    if (!s.url) {
        setStatus('请先填写 WebDAV 地址。', 'warn');
        return;
    }

    await withBusy(reason === 'manual' ? '正在同步...' : '自动同步进行中...', async () => {
        const data = await apiWithSettings('sync/apply', { reason });

        s.lastSyncAt = data.lastSyncAt || new Date().toISOString();
        if (data.device && !s.deviceName) s.deviceName = data.device;
        saveSettings();
        updateSyncPill();
        renderSyncResult(data);

        const parts = [
            ['上传', data.uploaded],
            ['下载', data.downloaded],
            ['冲突', data.conflicts],
            ['删除本机', data.deletedLocal],
            ['删除远端', data.deletedRemote],
        ].filter(([, value]) => Number(value) > 0).map(([label, value]) => `${label} ${value}`);
        const summary = parts.length ? parts.join('，') : '两端已一致';

        if (data.errors?.length) {
            setStatus(`同步完成但有 ${data.errors.length} 项失败：${summary}`, 'warn');
            notify('warning', `WebDAV 同步完成，${data.errors.length} 项失败`);
        } else {
            setStatus(`同步完成：${summary}。`, 'ok');
            if (reason === 'manual') notify('success', `WebDAV 同步完成：${summary}`);
        }

        // 浏览器里缓存的是同步前的内容，不刷新的话下次保存会把刚拉下来的覆盖掉
        if (data.downloaded || data.conflicts || data.deletedLocal) {
            notify('info', '本地聊天文件已变化，建议刷新页面以加载最新内容');
        }
    }, '同步失败。');
}

// ---------------------------------------------------------------------------
// zip 快照
// ---------------------------------------------------------------------------

function renderBackupList(items = []) {
    const select = $('#wdcb-backup-list').empty();
    if (!items.length) {
        select.append('<option value="">没有找到快照</option>');
        $('#wdcb-backup-meta').text('');
        return;
    }
    for (const item of items) {
        const label = `${item.name}  ·  ${prettyBytes(item.size)}  ·  ${prettyDate(item.modified)}`;
        select.append(`<option value="${escHtml(item.name)}" data-size="${escHtml(item.size)}"`
            + ` data-modified="${escHtml(item.modified)}">${escHtml(label)}</option>`);
    }
    renderSelectedMeta();
}

export function renderSelectedMeta() {
    const option = $('#wdcb-backup-list option:selected');
    if (!option.val()) {
        $('#wdcb-backup-meta').text('');
        return;
    }
    $('#wdcb-backup-meta').text(
        `${option.val()} / ${prettyBytes(option.data('size'))} / ${prettyDate(option.data('modified'))}`,
    );
}

export async function refreshList(showBusy = true) {
    readFormIntoSettings();
    const load = async () => {
        const data = await apiWithSettings('list');
        renderBackupList(data.items || []);
        return data.items?.length || 0;
    };

    if (!showBusy) {
        // 作为其他动作的收尾调用，失败不该盖掉主动作的状态提示
        try {
            await load();
        } catch (error) {
            console.warn('[WebDAV Chat Backup] 读取快照清单失败：', error);
        }
        return;
    }

    await withBusy('正在读取快照清单...', async () => {
        setStatus(`已读取 ${await load()} 个快照。`, 'ok');
    }, '读取快照清单失败。');
}

export async function createSnapshot(reason = 'manual') {
    readFormIntoSettings();
    await withBusy(reason === 'manual' ? '正在创建快照...' : '自动快照进行中...', async () => {
        const data = await apiWithSettings('backup', { reason });
        const s = getSettings();
        s.lastBackupAt = data.createdAt || new Date().toISOString();
        s.lastBackupFile = data.fileName || '';
        saveSettings();
        setStatus(`快照完成：${data.fileName || ''}（${prettyBytes(data.size)}，${data.files || 0} 个文件）`, 'ok');
        notify('success', 'WebDAV 快照完成');
        await refreshList(false);
    }, '快照失败。');
}

function selectedFileName() {
    return $('#wdcb-backup-list').val()?.toString() || '';
}

export async function restoreSnapshot() {
    readFormIntoSettings();
    const fileName = selectedFileName();
    if (!fileName) {
        setStatus('请选择一个快照。', 'warn');
        return;
    }
    if (!confirm(`恢复快照：${fileName}？同名文件会先保存本地保护副本。`)) return;

    await withBusy('正在恢复快照...', async () => {
        const data = await apiWithSettings('restore', { fileName });
        setStatus(`恢复完成：写入 ${data.restored || 0} 个文件，保护副本 ${data.protected || 0} 个。`, 'ok');
        notify('success', 'WebDAV 快照已恢复');
        notify('info', '建议刷新页面以加载恢复后的内容');
    }, '恢复失败。');
}

export async function deleteSnapshot() {
    readFormIntoSettings();
    const fileName = selectedFileName();
    if (!fileName) {
        setStatus('请选择一个快照。', 'warn');
        return;
    }
    if (!confirm(`删除远端快照：${fileName}？`)) return;

    await withBusy('正在删除远端快照...', async () => {
        await apiWithSettings('delete', { fileName });
        setStatus('远端快照已删除。', 'ok');
        notify('info', '远端快照已删除');
        await refreshList(false);
    }, '删除失败。');
}

// ---------------------------------------------------------------------------
// 自动执行
// ---------------------------------------------------------------------------

const TICK_MS = 60 * 1000;
const EVENT_DEBOUNCE_MS = 5000;

let autoTimer = null;
let autoDebounce = null;

function autoIntervalMs() {
    const hours = Math.max(0.25, Number(getSettings().autoIntervalHours) || DEFAULT_SETTINGS.autoIntervalHours);
    return hours * 60 * 60 * 1000;
}

/** 上次自动动作的时间，按当前模式取对应的时间戳。 */
function autoLastRunAt() {
    const s = getSettings();
    const value = s.autoMode === 'snapshot' ? s.lastBackupAt : s.lastSyncAt;
    return value ? new Date(value).getTime() : 0;
}

export async function autoMaybeRun(reason) {
    const s = getSettings();
    if (!s.autoEnabled || isBusy() || !s.url) return;
    if (Date.now() - autoLastRunAt() < autoIntervalMs()) return;
    if (s.autoMode === 'snapshot') await createSnapshot(reason);
    else await runSync(reason);
}

export function autoQueue(reason) {
    const s = getSettings();
    if (!s.autoEnabled || !s.autoOnChatEvents) return;
    clearTimeout(autoDebounce);
    autoDebounce = setTimeout(() => autoMaybeRun(reason), EVENT_DEBOUNCE_MS);
}

export function autoSyncTimer() {
    clearInterval(autoTimer);
    autoTimer = null;
    if (!getSettings().autoEnabled) return;
    autoTimer = setInterval(() => autoMaybeRun('auto'), TICK_MS);
}
