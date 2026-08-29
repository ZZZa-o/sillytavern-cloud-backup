/**
 * 云端文件管理：列出网盘里的备份文件，按文件夹分组，可搜索、可排序、可勾选下载或删除。
 *
 * 勾选状态记在 selected 里而不是读 DOM —— 搜索过滤会把没匹配上的行整个移除，
 * 靠 DOM 记状态的话一搜索就丢选择。
 */
import { apiWithNames } from './api.js';
import { reloadTouched } from './reload.js';
import { currentCharacterName } from './tavern.js';
import {
    escHtml, prettyBytes, prettyDate,
    setStatus, notify, withBusy,
} from './panel.js';

// 分组显示顺序：常用的几类在前，元数据与认不出来的垫底
const GROUP_ORDER = [
    '角色卡', '聊天记录', '世界书', '用户人设', 'API 配置',
    '预设', '美化', '设置', '其他', '插件元数据',
];

const GROUP_CHARACTERS = '角色卡';
const GROUP_CHATS = '聊天记录';
const GROUP_PERSONAS = '用户人设';
const PERSONA_FILE = 'persona.json';

let items = [];
const selected = new Set();
// 手动展开过的分组。刷新时清空 —— 列表初始一律折叠，只露出分组标题
const expanded = new Set();

// 'path' 按远端路径排，'time' 按修改时间倒序。
// 跨设备接续聊天时要找的永远是"刚传上去的那条"，按时间排它就在最上面。
let sortMode = 'path';

// 角色卡与它的聊天记录联动：勾一张卡就连它的聊天一起勾上。
// 默认开 —— 换台机器拉一个角色，要的就是"卡带着聊天一起来"。
let linkChats = true;

function keyword() {
    return $('#stcb-cloud-search').val()?.toString().trim().toLowerCase() ?? '';
}

function visibleItems() {
    const word = keyword();
    if (!word) return items;
    return items.filter(item => `${item.remote} ${item.local} ${item.label || ''}`.toLowerCase().includes(word));
}

function groupOf(name) {
    const index = GROUP_ORDER.indexOf(name);
    return index === -1 ? GROUP_ORDER.length : index;
}

/** 组内排序。按时间排时缺 modified 的垫底，免得它们插在最新的前面。 */
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

// ---------------------------------------------------------------------------
// 角色卡 ↔ 聊天记录联动
// ---------------------------------------------------------------------------

/**
 * 角色卡条目对应的角色名。
 *
 * 只认卡本体（`角色卡/<角色名>.png`，正好两段）。更深的是角色的附件目录，
 * 勾一张附件图不该把整个角色的聊天都拽进来。
 */
function characterNameOf(remote) {
    const parts = String(remote).split('/');
    if (parts.length !== 2 || parts[0] !== GROUP_CHARACTERS) return '';
    return parts[1].replace(/\.[^.]+$/, '');
}

/** 某个角色名下的全部聊天文件（含它在群聊里的那些？不含 —— 群聊不隶属角色）。 */
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

/** 把搜索框填成当前正在聊的角色名。云端按角色名存放，搜它就能把卡与聊天一起筛出来。 */
export function filterByCurrentCharacter() {
    const name = currentCharacterName();
    if (!name) {
        setStatus('酒馆里还没打开任何角色。', 'warn');
        return;
    }
    $('#stcb-cloud-search').val(name);
    renderCloud();
    setStatus(`已筛选出「${name}」的云端文件。`, 'ok');
}

export function renderCloud() {
    const list = $('#stcb-cloud-list');
    const visible = visibleItems();

    if (!items.length) {
        list.html('<div class="stcb-cloud-empty">还没有读取云端文件，点「刷新」。</div>');
        $('#stcb-cloud-meta').text('');
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
                // 只显示分组下的相对路径，前缀已经写在分组标题上了
                const shown = item.remote.split('/').slice(1).join('/') || item.remote;
                // 折起来的人设：一行就是一整个人设，勾一次连头像一起下载
                if (item.folded) {
                    return `<label class="stcb-cloud-item">`
                        + `<input type="checkbox" value="${escHtml(item.remote)}"${checked}>`
                        + `<span class="stcb-cloud-name" title="${escHtml(item.folder)}">${escHtml(item.label)}</span>`
                        + `<small>整个人设 · ${escHtml(prettyBytes(item.size))} · ${escHtml(prettyDate(item.modified))}</small>`
                        + `</label>`;
                }
                // 人设头像的文件名是个时间戳，认不出是谁 —— 后端给了人设名就显示名字，
                // 真实文件名退到后面的小字里，仍然看得见
                const title = item.label || shown;
                const trail = item.label ? `${shown} · ` : '';
                return `<label class="stcb-cloud-item">`
                    + `<input type="checkbox" value="${escHtml(item.remote)}"${checked}>`
                    + `<span class="stcb-cloud-name" title="${escHtml(shown)}">${escHtml(title)}</span>`
                    + `<small>${escHtml(trail)}${escHtml(prettyBytes(item.size))} · ${escHtml(prettyDate(item.modified))}</small>`
                    + `</label>`;
            }).join('');
            const allChecked = entries.every(item => selected.has(item.remote));
            // 搜索时强制展开，否则搜到了却看不见
            const open = keyword() || expanded.has(name) ? ' open' : '';
            // 角色卡分组标题右端挂联动开关：勾一张卡要不要连聊天一起带上
            const link = name === GROUP_CHARACTERS
                ? `<button type="button" class="stcb-cloud-link${linkChats ? ' is-on' : ''}"`
                    + ` data-act="link" title="${linkChats
                        ? '已联动：勾角色卡会连它的聊天记录一起勾上'
                        : '未联动：只勾角色卡本身'}">`
                    + `<i class="fa-solid ${linkChats ? 'fa-link' : 'fa-link-slash'}"></i></button>`
                : '';
            return `<details class="stcb-cloud-group" data-group="${escHtml(name)}"${open}>`
                + `<summary>`
                + `<input type="checkbox" class="stcb-cloud-group-check" data-group="${escHtml(name)}"${allChecked ? ' checked' : ''}>`
                + `<span>${escHtml(name)} · ${shownEntries.length}</span>${link}</summary>`
                + `<div class="stcb-cloud-rows">${rows}</div></details>`;
        })
        .join('');

    list.html(html);
    renderMeta();
}

function renderMeta() {
    const visible = visibleItems();
    const word = keyword();
    const parts = [`共 ${items.length} 个文件`];
    if (word) parts.push(`筛选出 ${visible.length} 个`);
    if (selected.size) parts.push(`已选 ${selected.size} 个`);
    parts.push(sortMode === 'time' ? '按修改时间排序' : '按路径排序');
    $('#stcb-cloud-meta').text(parts.join('，'));
}

/** 记住用户手动展开了哪些分组，重渲染时（比如整组勾选）不至于又全折回去。 */
export function noteToggle(group, open) {
    if (open) expanded.add(group);
    else expanded.delete(group);
}

/**
 * 勾上/取消一个远端文件，不触发重绘。
 * 联动开着且这是张角色卡时，把它名下的聊天记录一并带上 —— 换台机器要的是能接着聊，
 * 光有卡没有聊天等于白拉。返回是否动到了别的分组。
 */
function applyToggle(remote, checked) {
    const apply = value => (checked ? selected.add(value) : selected.delete(value));
    apply(remote);

    // 一个人设是一整个文件夹：persona.json（名字、描述、注入设置）+ 头像图。
    // 只拉头像不拉 persona.json，酒馆里出现的会是个叫 [Unnamed Persona] 的空壳，
    // 所以这个文件夹里的东西一律同进同出
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
 * 一个人设在列表里只占一行。
 *
 * 网盘上一个人设是一整个文件夹（persona.json + 头像），但对用户来说那就是"一个人设"，
 * 分成两行摆着既啰嗦又容易只勾一半。这里把每个文件夹折成一条：
 * 大小是文件夹合计，时间取最新的那个，勾选落在 persona.json 上 ——
 * applyToggle 会把同文件夹的头像一起带上，所以勾一次就是整个人设。
 *
 * 旧布局那些平铺在 用户人设/ 下的文件不成文件夹，原样逐行显示。
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
            // 文件夹名就是人设名
            label: folder.split('/')[1],
            size: group.reduce((sum, item) => sum + (item.size || 0), 0),
            modified: group.map(item => item.modified).filter(Boolean).sort().pop() || '',
        });
    }

    return out;
}

/**
 * 这个远端文件属于哪个人设文件夹，返回带斜杠的前缀（用户人设/沈知微/）。
 * 不在人设文件夹里（旧布局的平铺头像、别的分组）返回空串。
 */
function personaFolderOf(remote) {
    const parts = String(remote).split('/');
    if (parts.length !== 3 || parts[0] !== GROUP_PERSONAS) return '';
    return `${parts[0]}/${parts[1]}/`;
}

/** 勾选/取消单个文件。 */
export function toggleItem(remote, checked) {
    // 联动会改到聊天记录分组里的勾选态，光更新计数不够，得整表重画
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

export async function refreshCloud(showBusy = true) {
    const load = async () => {
        const data = await apiWithNames('cloud/list');
        items = data.items || [];
        // 刷新后一律收起，让用户先看到分组全貌
        expanded.clear();
        // 云端删掉的文件不该继续留在选择集里
        const alive = new Set(items.map(item => item.remote));
        for (const remote of [...selected]) {
            if (!alive.has(remote)) selected.delete(remote);
        }
        renderCloud();
        return items.length;
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
        setStatus(`云端共 ${await load()} 个文件。`, 'ok');
    }, '读取云端文件失败。');
}

function selectedPaths() {
    return [...selected];
}

export async function downloadSelected() {
    const paths = selectedPaths();
    if (!paths.length) {
        setStatus('请先勾选要下载的云端文件。', 'warn');
        return;
    }
    if (!confirm(`下载 ${paths.length} 个云端文件到本机？本机同名文件会被覆盖。`)) return;

    await withBusy('正在下载云端文件...', async () => {
        const data = await apiWithNames('cloud/download', { paths });
        const needsReload = await reloadTouched(data);

        const extra = [];
        if (data.fallbackDir) extra.push(`无法对应到酒馆目录的文件已放到 ${data.fallbackDir}`);
        if (data.errors?.length) extra.push(`失败 ${data.errors.length} 个`);
        setStatus(`下载完成：${data.downloaded} 个${extra.length ? `（${extra.join('，')}）` : ''}。${needsReload}`,
            data.errors?.length || needsReload ? 'warn' : 'ok');
        notify('success', `已下载 ${data.downloaded} 个云端文件`);
    }, '下载失败。');
}

export async function deleteSelected() {
    const paths = selectedPaths();
    if (!paths.length) {
        setStatus('请先勾选要删除的云端文件。', 'warn');
        return;
    }
    const meta = paths.filter(remote => items.find(item => item.remote === remote)?.group === '插件元数据');
    const warning = meta.length
        ? `\n\n其中 ${meta.length} 个是插件元数据，删掉后下次备份会重新全量比对。`
        : '';
    if (!confirm(`从云端永久删除 ${paths.length} 个文件？此操作不可撤销。${warning}`)) return;

    await withBusy('正在删除云端文件...', async () => {
        const data = await apiWithNames('cloud/delete', { paths });
        setStatus(`已删除 ${data.deleted} 个云端文件${data.errors?.length ? `，${data.errors.length} 个失败` : ''}。`,
            data.errors?.length ? 'warn' : 'ok');
        notify('info', `已删除 ${data.deleted} 个云端文件`);
        selected.clear();
        await refreshCloud(false);
    }, '删除失败。');
}
