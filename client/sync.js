/** 多端同步：预览差异、执行同步、渲染结果。 */
import { getSettings, saveSettings, readFormIntoSettings } from './settings.js';
import { apiWithSettings, updateSyncPill } from './api.js';
import { escHtml, setStatus, notify, setReport, withBusy } from './ui.js';

const ACTION_LABELS = {
    upload: '上传到远端',
    download: '下载到本机',
    conflict: '冲突待处理',
    deleteLocal: '删除本机文件',
    deleteRemote: '删除远端文件',
};

const ACTIONS = Object.keys(ACTION_LABELS);

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
    const present = ACTIONS.filter(action => Number(counts[action]) > 0);

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

function renderResult(data) {
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
        const total = ACTIONS.reduce((sum, action) => sum + (Number(counts[action]) || 0), 0);
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
        renderResult(data);

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
