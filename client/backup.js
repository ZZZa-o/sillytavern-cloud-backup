/** 变更预览、手动备份、自动检查与上传记录。 */
import { api, apiWithNames } from './api.js';
import { getConfig, describeScope, setActiveFields } from './settings.js';
import {
    escHtml, prettyDate, prettyBytes, setReport, notify, withBusy, isBusy,
    setBackupStatus, setAutoStatus, setCheckStatus, renderLastBackup,
} from './panel.js';
import { reloadTouched } from './reload.js';
import { refreshCloud } from './cloud.js';

const CATEGORY_LABELS = {
    characters: '角色卡', chats: '聊天记录', worlds: '世界书', personas: '用户人设',
    presets: '预设', themes: '美化', apiProfiles: 'API 配置', other: '其他文件',
};
const REASON_LABELS = {
    'local-only': '云端没有', 'remote-only': '本机没有',
    differs: '两端内容不同', 'remote-unindexed': '云端文件无索引记录',
};
const CHECK_MS = 30 * 1000;
const DEBOUNCE_MS = 5000;

let timer = null;
let changeTimer = null;
let autoTimer = null;
let checking = false;
let ready = false;
let generating = false;
let sequence = 0;
let lastAutoAt = 0;
let previewKey = '';
let historyKey = '';

function contextKey() {
    const c = getConfig();
    return JSON.stringify([c.activeProfileId, c.url, c.username, c.remotePath, c.scope]);
}

function group(summary, lines, open = false) {
    return `<details class="stcb-plan-group"${open ? ' open' : ''}>`
        + `<summary>${escHtml(summary)}</summary>`
        + `<ul class="stcb-plan-list">${lines.map(line => `<li>${line}</li>`).join('')}</ul></details>`;
}

function fileLines(files) {
    return files.map(file => `${escHtml(file.label)} <small>${prettyBytes(file.bytes)}</small>`);
}

function errorLines(errors) {
    return errors.map(item => `${escHtml(item.path)}<br><small>${escHtml(item.error)}</small>`);
}

function plaintextNotice(count) {
    if (!count) return '';
    return `<div class="stcb-meta stcb-encrypt-warn">云端还有 <b>${count}</b> 个未加密文件。`
        + '确认本机副本完整后，删除对应云端文件并重新上传。</div>';
}

function renderPreview(data) {
    const { plan, scopeText } = data;
    const { counts } = plan;
    const key = JSON.stringify([scopeText, counts, plan.upload, plan.download, plan.uploadCategories, plan.plaintextRemaining]);
    if (key !== previewKey) {
        previewKey = key;
        const range = Object.entries(plan.uploadCategories)
            .map(([category, count]) => `${CATEGORY_LABELS[category]} ${count} 个文件`).join('、');
        const summary = counts.upload ? `本地可更新：${range}。` : '本地暂无待上传文件。';
        const blocks = [];
        const lines = items => items.map(item =>
            `${escHtml(item.label)}<br><small>${escHtml(REASON_LABELS[item.reason])}</small>`);
        if (counts.upload) blocks.push(group(`可上传 ${counts.upload} 个文件`, lines(plan.upload), true));
        if (counts.download) blocks.push(group(`可下载 ${counts.download} 个文件`, lines(plan.download)));
        $('#stcb-preview-report').html(
            `<div class="stcb-change-summary${counts.upload ? ' has-changes' : ''}">${escHtml(summary)}</div>`
            + `<div class="stcb-meta">范围：${escHtml(scopeText)} · 相同 ${counts.unchanged} 个文件</div>`
            + (blocks.length ? '<div class="stcb-meta">上传以本机为准，下载以云端为准。</div>' : '')
            + blocks.join('')
            + (plan.truncated ? '<div class="stcb-meta">每个清单显示前 40 项。</div>' : '')
            + plaintextNotice(plan.plaintextRemaining),
        );
    }
    setCheckStatus(`已检查：${prettyDate(plan.checkedAt)}`, 'ok');
}

function renderAutoActivity(activity) {
    const key = JSON.stringify(activity.runs);
    if (key !== historyKey) {
        historyKey = key;
        const html = activity.runs.map((run, index) => {
            const failed = run.failed ? `，失败 ${run.failed} 个` : '';
            return group(`${prettyDate(run.at)} · 已上传 ${run.uploaded} 个${failed}`,
                [...fileLines(run.files), ...errorLines(run.errors)], index === 0);
        }).join('');
        $('#stcb-auto-report').html(html || '<div class="stcb-meta">暂无自动上传记录。</div>');
    }
    if (activity.lastRun !== null) {
        const run = activity.lastRun;
        const text = run.uploaded || run.failed ? `已上传 ${run.uploaded} 个文件` : '没有待上传文件';
        const failed = run.failed ? `，失败 ${run.failed} 个` : '';
        setAutoStatus(`${prettyDate(run.at)} · ${text}${failed}。`, run.failed ? 'warn' : 'ok');
    } else {
        setAutoStatus(getConfig().auto.enabled ? '等待自动上传。' : '');
    }
}

/** 切换方案或保存范围后加载该方案的上传记录。 */
export async function resetBackupMonitor() {
    sequence++;
    ready = false;
    previewKey = '';
    historyKey = '';
    setReport('');
    setBackupStatus('');
    $('#stcb-preview-report').empty();
    $('#stcb-auto-report').empty();
    setAutoStatus('');
    const key = contextKey();
    const c = getConfig();
    if (!c.url) {
        setCheckStatus('请先保存 WebDAV 配置。');
        renderAutoActivity({ lastRun: null, runs: [] });
        return;
    }
    setCheckStatus('等待检查变更。');
    try {
        const { activity } = await api('backup/activity');
        if (key !== contextKey()) return;
        const lastRun = activity.lastRun === null ? 0 : Date.parse(activity.lastRun.at);
        lastAutoAt = Math.max(lastRun, c.lastBackupAt ? Date.parse(c.lastBackupAt) : 0);
        renderAutoActivity(activity);
        ready = true;
        queueChanges(0);
    } catch (error) {
        if (key === contextKey()) setAutoStatus(`读取上传记录失败：${error.message}`, 'error');
    }
}

export async function checkChanges() {
    if (!ready || checking || isBusy() || generating || document.visibilityState !== 'visible') return;
    const key = contextKey();
    const request = ++sequence;
    checking = true;
    try {
        const data = await apiWithNames('backup/changes');
        if (request === sequence && key === contextKey()) renderPreview(data);
    } catch (error) {
        if (request === sequence && key === contextKey()) setCheckStatus(`检查失败：${error.message}`, 'error');
    } finally {
        checking = false;
    }
}

export function queueChanges(delay = DEBOUNCE_MS) {
    sequence++;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { void checkChanges(); }, delay);
}

export async function previewBackup() {
    sequence++;
    const key = contextKey();
    return withBusy('正在比对两端差异...', async () => {
        const data = await apiWithNames('backup/plan');
        if (key !== contextKey()) return;
        sequence++;
        renderPreview(data);
        const { upload, download } = data.plan.counts;
        setBackupStatus(upload || download
            ? `比对完成：可上传 ${upload} 项，可下载 ${download} 项。`
            : '比对完成：两端已一致。', 'ok');
    }, setBackupStatus);
}

function renderResult(data, title) {
    const counts = [['上传', data.uploaded], ['下载', data.downloaded], ['跳过相同', data.skipped]]
        .filter(([, value]) => value > 0)
        .map(([label, value]) => `<span class="stcb-pill is-muted">${label} ${value}</span>`).join('');
    setReport(`<div class="stcb-meta">${escHtml(title)}</div>`
        + `<div class="stcb-statusline">${counts}</div>`
        + (data.uploadedFiles.length ? group('已上传文件', fileLines(data.uploadedFiles), true) : '')
        + (data.errors.length ? group(`失败 ${data.errors.length} 项`, errorLines(data.errors), true) : '')
        + plaintextNotice(data.plaintextRemaining));
}

export async function runUpload(reason) {
    const automatic = reason !== 'manual';
    const status = automatic ? setAutoStatus : setBackupStatus;
    if (!getConfig().url) {
        status('请先填写 WebDAV 地址并保存配置。', 'warn');
        return;
    }
    sequence++;
    const key = contextKey();
    return withBusy(automatic ? '自动上传进行中...' : '正在上传到云端...', async () => {
        const data = await apiWithNames('backup/upload', { trigger: automatic ? 'auto' : 'manual' });
        if (key !== contextKey()) return;
        setActiveFields({ lastBackupAt: data.lastBackupAt });
        renderLastBackup(data.lastBackupAt);
        lastAutoAt = Date.parse(data.lastBackupAt);
        if (automatic) {
            renderAutoActivity(data.activity);
        } else {
            renderResult(data, '上传完成');
            const summary = data.uploaded ? `上传 ${data.uploaded} 个文件` : '云端已是最新';
            status(`${summary}，跳过相同 ${data.skipped} 个${data.errors.length ? `，失败 ${data.errors.length} 个` : ''}。`,
                data.errors.length ? 'warn' : 'ok');
            notify(data.errors.length ? 'warning' : 'success', summary);
            await refreshCloud(false);
        }
        queueChanges(0);
        return data;
    }, status);
}

export async function runDownload() {
    if (!getConfig().url) {
        setBackupStatus('请先填写 WebDAV 地址并保存配置。', 'warn');
        return;
    }
    if (!confirm(`下载以下范围的文件？\n\n范围：${describeScope()}。\n本机同名文件将被覆盖，不保留副本。`)) return;
    sequence++;
    const key = contextKey();
    return withBusy('正在从云端下载...', async () => {
        const data = await apiWithNames('backup/download');
        if (key !== contextKey()) return;
        setActiveFields({ lastBackupAt: data.lastBackupAt });
        renderLastBackup(data.lastBackupAt);
        renderResult(data, '下载完成');
        const needsReload = await reloadTouched(data);
        const summary = data.downloaded ? `下载 ${data.downloaded} 个文件` : '本机已是最新';
        setBackupStatus(`${summary}，跳过相同 ${data.skipped} 个${data.errors.length ? `，失败 ${data.errors.length} 个` : ''}。${needsReload}`,
            data.errors.length || needsReload ? 'warn' : 'ok');
        notify(data.errors.length ? 'warning' : 'success', summary);
        queueChanges(0);
        return data;
    }, setBackupStatus);
}

export function setGenerating(value) {
    generating = value;
    if (!value) queueChanges();
}

export async function autoMaybeRun(reason) {
    const c = getConfig();
    if (!ready || !c.auto.enabled || isBusy() || generating) return;
    if (Date.now() - lastAutoAt < c.auto.intervalMinutes * 60 * 1000) return;
    lastAutoAt = Date.now();
    await runUpload(reason);
}

export function autoQueue(reason) {
    queueChanges();
    const c = getConfig();
    if (!c.auto.enabled || !c.auto.onChatEvents) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { void autoMaybeRun(reason); }, DEBOUNCE_MS);
}

export function startBackupMonitor() {
    clearInterval(timer);
    timer = setInterval(async () => {
        await checkChanges();
        await autoMaybeRun('auto');
    }, CHECK_MS);
}
