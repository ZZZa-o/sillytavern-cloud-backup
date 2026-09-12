/**
 * 云端文件的分组、搜索、排序、下载与删除。
 * selected 保存勾选状态，搜索过滤后仍保留选择。
 */
import { apiWithNames } from './api.js';
import { reloadTouched } from './reload.js';
import { currentCharacterName } from './tavern.js';
import {
    escHtml, prettyBytes, prettyDate,
    setCloudStatus, withBusy, isBusy,
} from './panel.js';

// 分组顺序：备份类别在前，元数据与其他文件在后。
const GROUP_ORDER = [
    '角色卡', '聊天记录', '世界书', '用户人设', 'API 配置',
    '预设', 'QR', '美化', '背景图片', '设置', '其他', '插件元数据',
];

// 只拆分浏览分组，保留已有网盘路径和下载映射。
const DIRECTORY_GROUPS = new Map([
    ['预设/OpenAI Settings', '预设'],
    ['预设/QuickReplies', 'QR'],
    ['美化/themes', '美化'],
    ['美化/backgrounds', '背景图片'],
]);

const GROUP_CHARACTERS = '角色卡';
const GROUP_CHATS = '聊天记录';
const GROUP_PERSONAS = '用户人设';
const PERSONA_FILE = 'persona.json';

let items = [];
const selected = new Set();
// 记录展开的分组，刷新列表时清空。
const expanded = new Set();

// path 按路径排序；time 按修改时间倒序。
let sortMode = 'path';

// 默认联动选择角色卡及其聊天记录。
let linkChats = true;

// 默认关闭覆盖。
let overwriteLocal = false;

export function toggleOverwrite() {
    if (isBusy()) return overwriteLocal;
    overwriteLocal = !overwriteLocal;
    $('#stcb-cloud-overwrite').attr('aria-pressed', String(overwriteLocal)).attr('title', overwriteLocal
        ? '覆盖已开启：下载时替换本地对应内容'
        : '覆盖已关闭：角色卡、人设保留同名；其他重名内容加（1）、（2）');
    return overwriteLocal;
}

function keyword() {
    return $('#stcb-cloud-search').val()?.toString().trim().toLowerCase() ?? '';
}

function visibleItems() {
    const word = keyword();
    if (!word) return items;
    return items.filter(item => `${item.remote} ${item.local} ${item.label || ''} ${item.group}`.toLowerCase().includes(word));
}

function displayItem(item) {
    const parts = item.remote.split('/');
    const group = DIRECTORY_GROUPS.get(parts.slice(0, 2).join('/'));
    if (!group || parts.length < 3) return item;
    return { ...item, group, displayPath: parts.slice(2).join('/') };
}

function groupOf(name) {
    const index = GROUP_ORDER.indexOf(name);
    return index === -1 ? GROUP_ORDER.length : index;
}

/** 组内排序；按时间排序时将缺少 modified 的文件置后。 */
function sortEntries(entries) {
    if (sortMode !== 'time') {
        return entries.sort((a, b) => a.remote.localeCompare(b.remote, 'zh-Hans-CN'));
    }
    return entries.sort((a, b) => {
        const left = Date.parse(a.modified) || 0;
        const right = Date.parse(b.modified) || 0;
        if (left !== right) return right - left;
        return a.remote.localeCompare(b.remote, 'zh-Hans-CN');
    });
}

// 角色卡 ↔ 聊天记录联动

/** 从角色卡本体路径（角色卡/<角色名>.png）提取角色名。 */
function characterNameOf(remote) {
    const parts = String(remote).split('/');
    if (parts.length !== 2 || parts[0] !== GROUP_CHARACTERS) return '';
    return parts[1].replace(/\.[^.]+$/, '');
}

/** 列出指定角色的单人聊天文件。 */
function chatsOfCharacter(name) {
    const prefix = `${GROUP_CHATS}/${name}/`;
    return items.filter(item => item.remote.startsWith(prefix));
}

export function isLinked() {
    return linkChats;
}

export function toggleLink() {
    linkChats = !linkChats;
    renderCloud();
    return linkChats;
}

export function getSortMode() {
    return sortMode;
}

export function toggleSort() {
    sortMode = sortMode === 'path' ? 'time' : 'path';
    renderCloud();
    return sortMode;
}

/** 用当前角色名填充云端文件搜索框。 */
export function filterByCurrentCharacter() {
    const name = currentCharacterName();
    if (!name) {
        setCloudStatus('请先打开一个角色。', 'warn');
        return;
    }
    $('#stcb-cloud-search').val(name);
    renderCloud();
    setCloudStatus('');
}

export function renderCloud() {
    const list = $('#stcb-cloud-list');
    const scrollTop = list.scrollTop();
    const visible = visibleItems();

    if (!items.length) {
        list.html('<div class="stcb-cloud-empty">暂无云端文件，点击「刷新」加载。</div>');
        $('#stcb-cloud-meta').text('');
        updateSelectionControls(visible);
        return;
    }
    if (!visible.length) {
        list.html('<div class="stcb-cloud-empty">没有匹配的文件。</div>');
        renderMeta();
        return;
    }

    const groups = new Map();
    for (const item of visible) {
        if (!groups.has(item.group)) groups.set(item.group, []);
        groups.get(item.group).push(item);
    }

    const html = [...groups.entries()]
        .sort((a, b) => groupOf(a[0]) - groupOf(b[0]))
        .map(([name, entries]) => {
            const shownEntries = name === GROUP_PERSONAS ? foldPersonas(entries) : entries;
            const rows = sortEntries(shownEntries).map(item => {
                const checked = selected.has(item.remote) ? ' checked' : '';
                // 显示分组内的相对路径。
                const shown = item.displayPath || item.remote.split('/').slice(1).join('/') || item.remote;
                // 将人设及头像显示为一行。
                if (item.folded) {
                    return `<label class="stcb-cloud-item">`
                        + `<input type="checkbox" value="${escHtml(item.remote)}"${checked}>`
                        + `<span class="stcb-cloud-name" title="${escHtml(item.folder)}">${escHtml(item.label)}</span>`
                        + `<small>${escHtml(prettyBytes(item.size))} · ${escHtml(prettyDate(item.modified))}</small>`
                        + `</label>`;
                }
                // 优先显示后端提供的人设名，附带真实文件名。
                const title = item.label || shown;
                const trail = item.label ? `${shown} · ` : '';
                return `<label class="stcb-cloud-item">`
                    + `<input type="checkbox" value="${escHtml(item.remote)}"${checked}>`
                    + `<span class="stcb-cloud-name" title="${escHtml(item.remote)}">${escHtml(title)}</span>`
                    + `<small>${escHtml(trail)}${escHtml(prettyBytes(item.size))} · ${escHtml(prettyDate(item.modified))}</small>`
                    + `</label>`;
            }).join('');
            const note = shownEntries.some(item => item.folded)
                ? '<div class="stcb-meta">每个人设连同头像一起选择。</div>' : '';
            const allChecked = entries.every(item => selected.has(item.remote));
            // 搜索时展开匹配分组。
            const open = keyword() || expanded.has(name) ? ' open' : '';
            // 角色卡分组标题右端挂联动开关：勾一张卡要不要连聊天一起带上
            const link = name === GROUP_CHARACTERS
                ? `<button type="button" class="stcb-cloud-link${linkChats ? ' is-on' : ''}"`
                    + ` data-act="link" aria-label="联动选择聊天记录" aria-pressed="${linkChats}"${isBusy() ? ' disabled' : ''} title="${linkChats
                        ? '联动已开启：同时选择角色卡和聊天'
                        : '联动已关闭：仅选择角色卡'}">`
                    + `<i class="fa-solid ${linkChats ? 'fa-link' : 'fa-link-slash'}" aria-hidden="true"></i></button>`
                : '';
            return `<details class="stcb-cloud-group" data-group="${escHtml(name)}"${open}>`
                + `<summary>`
                + `<input type="checkbox" class="stcb-cloud-group-check" data-group="${escHtml(name)}"${allChecked ? ' checked' : ''}>`
                + `<span>${escHtml(name)} · ${shownEntries.length}</span>${link}</summary>`
                + `<div class="stcb-cloud-rows">${note}${rows}</div></details>`;
        })
        .join('');

    // 重绘勾选和联动状态时，保持正在浏览的位置。
    list.html(html).scrollTop(scrollTop);
    renderMeta();
}

function updateSelectionControls(visible) {
    const counts = new Map();
    for (const item of visible) {
        if (!counts.has(item.group)) counts.set(item.group, { total: 0, checked: 0 });
        const count = counts.get(item.group);
        count.total++;
        if (selected.has(item.remote)) count.checked++;
    }
    $('#stcb-cloud-list .stcb-cloud-group-check').each(function () {
        const count = counts.get(this.dataset.group);
        this.checked = !!count && count.checked === count.total;
        this.indeterminate = !!count && count.checked > 0 && count.checked < count.total;
    });
    const controls = [
        ['#stcb-cloud-select-all', !visible.length || visible.every(item => selected.has(item.remote))],
        ['#stcb-cloud-clear-selection', selected.size === 0],
    ];
    for (const [selector, disabled] of controls) {
        $(selector).attr('data-stcb-disabled', String(disabled)).prop('disabled', disabled || isBusy());
    }
}

function renderMeta() {
    const visible = visibleItems();
    const word = keyword();
    const parts = [`共 ${items.length} 个文件`];
    if (word) parts.push(`筛选出 ${visible.length} 个`);
    if (selected.size) parts.push(`已选 ${selected.size} 个`);
    $('#stcb-cloud-meta').text(parts.join('，'));
    updateSelectionControls(visible);
}

/** 记录分组展开状态并在重绘时恢复。 */
export function noteToggle(group, open) {
    if (open) expanded.add(group);
    else expanded.delete(group);
}

/**
 * 更新远端文件勾选状态，并按联动设置选择角色聊天。
 * 返回是否修改了其他分组。
 */
function applyToggle(remote, checked) {
    const apply = value => (checked ? selected.add(value) : selected.delete(value));
    apply(remote);

    // 同一人设文件夹内的 persona.json 和头像一起选中或取消。
    const folder = personaFolderOf(remote);
    if (folder) {
        const siblings = items.filter(item => item.remote.startsWith(folder));
        for (const item of siblings) apply(item.remote);
        return siblings.length > 1;
    }

    if (!linkChats) return false;
    const name = characterNameOf(remote);
    if (!name) return false;

    const chats = chatsOfCharacter(name);
    for (const chat of chats) apply(chat.remote);
    return chats.length > 0;
}

/**
 * 将每个人设文件夹合并为一行，以 persona.json 作为勾选项。
 * 大小取文件夹总和，时间取最新值；旧布局的平铺文件逐行显示。
 */
function foldPersonas(entries) {
    const folders = new Map();
    const out = [];

    for (const item of entries) {
        const folder = personaFolderOf(item.remote);
        if (!folder) {
            out.push(item);
            continue;
        }
        const group = folders.get(folder);
        if (group) group.push(item);
        else folders.set(folder, [item]);
    }

    for (const [folder, group] of folders) {
        const anchor = group.find(item => item.remote.endsWith(`/${PERSONA_FILE}`)) || group[0];
        out.push({
            ...anchor,
            folded: true,
            folder,
            // 使用文件夹名作为人设名。
            label: folder.split('/')[1],
            size: group.reduce((sum, item) => sum + (item.size || 0), 0),
            modified: group.map(item => item.modified).filter(Boolean).sort().pop() || '',
        });
    }

    return out;
}

/** 返回文件所属的人设文件夹前缀；其他路径返回空串。 */
function personaFolderOf(remote) {
    const parts = String(remote).split('/');
    if (parts.length !== 3 || parts[0] !== GROUP_PERSONAS) return '';
    return `${parts[0]}/${parts[1]}/`;
}

/** 勾选/取消单个文件。 */
export function toggleItem(remote, checked) {
    // 联动修改其他分组后重绘列表。
    if (applyToggle(remote, checked)) renderCloud();
    else renderMeta();
}

/** 勾选/取消整组（只作用于当前可见的那些，配合搜索使用）。 */
export function toggleGroup(group, checked) {
    for (const item of visibleItems()) {
        if (item.group !== group) continue;
        applyToggle(item.remote, checked);
    }
    renderCloud();
}

/** 全选当前筛选结果，包括收起分组内的文件，并沿用角色聊天与人设联动。 */
export function selectVisible() {
    for (const item of visibleItems()) applyToggle(item.remote, true);
    renderCloud();
}

/** 清空所有勾选，包括被搜索条件隐藏的文件。 */
export function clearSelection() {
    selected.clear();
    renderCloud();
}

export async function refreshCloud(showBusy = true) {
    const load = async () => {
        const data = await apiWithNames('cloud/list');
        items = data.items.map(displayItem);
        // 刷新后收起全部分组。
        expanded.clear();
        // 从选择集中移除云端已删除的文件。
        const alive = new Set(items.map(item => item.remote));
        for (const remote of [...selected]) {
            if (!alive.has(remote)) selected.delete(remote);
        }
        renderCloud();
    };

    if (!showBusy) {
        try {
            await load();
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 读取云端文件失败：', error);
        }
        return;
    }

    await withBusy('正在读取云端文件...', async () => {
        await load();
        setCloudStatus('');
    }, setCloudStatus);
}

function selectedPaths() {
    return [...selected];
}

export async function downloadSelected() {
    const paths = selectedPaths();
    if (!paths.length) {
        setCloudStatus('请先选择要下载的文件。', 'warn');
        return;
    }
    const overwrite = overwriteLocal;
    const policy = overwrite
        ? '本机同名文件将被覆盖，不保留副本。'
        : '保留本地内容。角色卡和用户人设保留同名，其他重名内容自动加（1）、（2）。';
    if (!confirm(`下载选中的 ${paths.length} 个文件？${policy}`)) return;

    await withBusy('正在下载云端文件...', async () => {
        const data = await apiWithNames('cloud/download', { paths, overwrite });
        const reload = await reloadTouched(data);

        const extra = [];
        if (data.errors?.length) extra.push(`失败 ${data.errors.length} 个`);
        setCloudStatus(`下载完成：${data.downloaded} 个${extra.length ? `（${extra.join('，')}）` : ''}。${reload.message}`,
            data.errors?.length || reload.needsReload ? 'warn' : 'ok');
    }, setCloudStatus);
}

export async function deleteSelected() {
    const paths = selectedPaths();
    if (!paths.length) {
        setCloudStatus('请先选择要删除的文件。', 'warn');
        return;
    }
    const meta = paths.filter(remote => items.find(item => item.remote === remote)?.group === '插件元数据');
    const warning = meta.length
        ? `\n\n含 ${meta.length} 个插件元数据文件；删除加密校验文件可能导致备份无法恢复。`
        : '';
    if (!confirm(`从云端永久删除 ${paths.length} 个文件？此操作不可撤销。${warning}`)) return;

    await withBusy('正在删除云端文件...', async () => {
        const data = await apiWithNames('cloud/delete', { paths });
        setCloudStatus(`已删除 ${data.deleted} 个云端文件${data.errors?.length ? `，${data.errors.length} 个失败` : ''}。`,
            data.errors?.length ? 'warn' : 'ok');
        selected.clear();
        await refreshCloud(false);
    }, setCloudStatus);
}
