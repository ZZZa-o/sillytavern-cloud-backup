/** 全部动作：保存配置、测试连接、预览、上传、下载、自动执行。 */
import { api, apiWithNames } from './api.js';
import {
    getConfig, loadConfig, pushConfig, describeScope, setScopeDirs, setChatCounts, setSynthLists,
    addProfile, renameProfile, removeProfile, setActiveProfile, activeProfile,
    MIN_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES,
} from './settings.js';
import {
    escHtml,
    setStatus, notify, setReport, withBusy, isBusy,
    fillForm, renderPasswordState, renderEncryptState, renderScopeText, renderLastBackup, readFormIntoConfig,
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
        renderEncryptState(data.encryption);
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

/**
 * 保存配置。
 *
 * 首次开启加密时拦一道确认 —— 口令丢了云端数据就真的回不来了，没有找回渠道，
 * 这件事必须让用户在点下去之前看到一次。已经开着的方案再保存就不再打扰。
 */
export async function saveConfig() {
    const before = getConfig().encryption || {};
    const wasEnabled = !!before.enabled;
    readFormIntoConfig();
    const password = $('#stcb-password').val()?.toString() ?? '';
    const passphrase = $('#stcb-passphrase').val()?.toString() ?? '';
    const nowEnabled = !!getConfig().encryption?.enabled;

    if (nowEnabled && !passphrase && !before.hasPassphrase) {
        setStatus('已勾选加密，但还没有填写加密口令。', 'error');
        return;
    }

    if (nowEnabled && !wasEnabled) {
        const ok = confirm(
            '开启加密后，上传到网盘的文件将无法在网盘网页端直接打开，只能通过本插件取回。\n\n'
            + '加密口令丢失后，云端数据无法恢复——没有任何找回渠道。\n'
            + '在其他设备上同步时，必须填写完全相同的口令。\n\n'
            + '确定开启吗？',
        );
        if (!ok) {
            // 用户反悔了，把勾去掉再重画，免得界面停在"看起来开着"的状态
            getConfig().encryption.enabled = false;
            fillForm();
            setStatus('已取消，加密未开启。', 'info');
            return;
        }
    }

    await withBusy('正在保存配置...', async () => {
        await pushConfig(password, { passphrase });
        fillForm();
        autoTimer();
        setStatus(`配置已保存。当前范围：${describeScope()}`, 'ok');
        notify('success', 'WebDAV 配置已保存');
    }, '保存配置失败。');
}

// ---------------------------------------------------------------------------
// 方案：一套连接信息一条。范围与自动上传是全局的，不跟着方案走
// ---------------------------------------------------------------------------

/**
 * 切换方案。
 *
 * 先把表单上的改动写回原方案再切，否则用户刚改完地址就换方案，那几笔就丢了。
 * 切完立刻落盘 —— 用户的心理模型是"选中即生效"，不该再逼他点一次保存配置。
 */
export async function switchProfile(id) {
    readFormIntoConfig();
    if (!setActiveProfile(id)) return;

    await withBusy('正在切换方案...', async () => {
        await pushConfig();
        fillForm();
        autoTimer();
        setStatus(`已切换到方案「${activeProfile().name}」。`, 'ok');
        await refreshCloud(false);
    }, '切换方案失败。');
}

export async function createProfile() {
    const name = prompt('新方案的名字：', '新方案');
    if (name === null) return;

    readFormIntoConfig();
    addProfile(name.trim());

    await withBusy('正在新建方案...', async () => {
        await pushConfig();
        fillForm();
        setStatus('方案已新建。填好地址与密码后点「保存配置」。', 'ok');
    }, '新建方案失败。');
}

export async function renameActiveProfile() {
    const profile = activeProfile();
    const name = prompt('方案改叫：', profile.name);
    if (name === null || !name.trim()) return;

    readFormIntoConfig();
    renameProfile(profile.id, name.trim());

    await withBusy('正在重命名...', async () => {
        await pushConfig();
        fillForm();
        setStatus(`方案已改名为「${activeProfile().name}」。`, 'ok');
    }, '重命名失败。');
}

/** 只删本地这条连接配置，云端文件一个都不动。 */
export async function deleteActiveProfile() {
    const profile = activeProfile();
    if (getConfig().profiles.length <= 1) {
        setStatus('至少要保留一个方案。', 'warn');
        return;
    }
    if (!confirm(`删除方案「${profile.name}」？\n\n只删本机保存的地址与密码，云端文件不受影响。`)) return;

    readFormIntoConfig();
    removeProfile(profile.id);

    await withBusy('正在删除方案...', async () => {
        await pushConfig();
        fillForm();
        autoTimer();
        setStatus(`方案已删除，当前为「${activeProfile().name}」。`, 'ok');
        await refreshCloud(false);
    }, '删除方案失败。');
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

/**
 * 「云端还剩 N 个明文」的提示。
 *
 * 开启加密不会自动重传存量文件——内容没变哈希也没变，比对时算作相同，这是有意为之：
 * 一次性重传全部数据不该由一个复选框悄悄触发。但用户得知道云端还留着什么，
 * 否则他会以为勾上开关就万事大吉了。
 */
function plaintextNotice(count) {
    if (!Number(count)) return '';
    return `<div class="stcb-meta stcb-encrypt-warn">云端还有 <b>${Number(count)}</b> 个文件是开启加密前上传的明文。`
        + '它们不会被自动替换。要全部转成密文，请在「云端文件」里删掉它们，再上传一次。</div>';
}

export async function previewBackup() {
    await withBusy('正在比对两端差异...', async () => {
        const data = await apiWithNames('backup/plan');
        const plan = data.plan || {};
        const counts = plan.counts || {};

        if (!counts.upload && !counts.download) {
            setReport(`<div class="stcb-meta">范围：${escHtml(data.scopeText || describeScope())}<br>`
                + `两端已经一致，无需变更（${counts.unchanged || 0} 个文件相同）。</div>`
                + plaintextNotice(plan.plaintextRemaining));
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
            + (plan.truncated ? '<div class="stcb-meta">列表仅显示前 40 项。</div>' : '')
            + plaintextNotice(plan.plaintextRemaining));

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
        + errors
        + plaintextNotice(data.plaintextRemaining));
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
let generating = false;

/** 酒馆开始/结束生成时由 index.js 通知。 */
export function setGenerating(value) {
    generating = !!value;
}

function intervalMs() {
    return Math.max(MIN_INTERVAL_MINUTES, Number(getConfig().auto.intervalMinutes) || DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}

export async function autoMaybeRun(reason) {
    const c = getConfig();
    if (!c.auto.enabled || isBusy() || !c.url) return;
    // 生成中不传：这会儿磁盘上的 .jsonl 可能是半截回复，或者还停在上一轮。
    // 注意别在这里推进 lastAutoAt —— 那样生成结束后还得空等一整个间隔
    if (generating) return;
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
