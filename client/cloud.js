/**
 * 云端文件管理：列出网盘里的备份文件，按四个文件夹分组，可搜索、可勾选下载或删除。
 *
 * 勾选状态记在 selected 里而不是读 DOM —— 搜索过滤会把没匹配上的行整个移除，
 * 靠 DOM 记状态的话一搜索就丢选择。
 */
import { apiWithNames } from './api.js';
import { reloadTouched } from './reload.js';
import {
    escHtml, prettyBytes, prettyDate,
    setStatus, notify, withBusy,
} from './panel.js';

// 分组显示顺序：常用的四类在前，元数据与认不出来的垫底
const GROUP_ORDER = ['角色卡', '聊天记录', '世界书', '设置', '其他', '插件元数据'];

let items = [];
const selected = new Set();
// 手动展开过的分组。刷新时清空 —— 列表初始一律折叠，只露出分组标题
const expanded = new Set();

function keyword() {
    return $('#wdcb-cloud-search').val()?.toString().trim().toLowerCase() ?? '';
}

function visibleItems() {
    const word = keyword();
    if (!word) return items;
    return items.filter(item => `${item.remote} ${item.local}`.toLowerCase().includes(word));
}

function groupOf(name) {
    const index = GROUP_ORDER.indexOf(name);
    return index === -1 ? GROUP_ORDER.length : index;
}

export function renderCloud() {
    const list = $('#wdcb-cloud-list');
    const visible = visibleItems();

    if (!items.length) {
        list.html('<div class="wdcb-cloud-empty">还没有读取云端文件，点「刷新」。</div>');
        $('#wdcb-cloud-meta').text('');
        return;
    }
    if (!visible.length) {
        list.html('<div class="wdcb-cloud-empty">没有匹配的文件。</div>');
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
            const rows = entries.map(item => {
                const checked = selected.has(item.remote) ? ' checked' : '';
                // 只显示分组下的相对路径，前缀已经写在分组标题上了
                const shown = item.remote.split('/').slice(1).join('/') || item.remote;
                return `<label class="wdcb-cloud-item">`
                    + `<input type="checkbox" value="${escHtml(item.remote)}"${checked}>`
                    + `<span class="wdcb-cloud-name">${escHtml(shown)}</span>`
                    + `<small>${escHtml(prettyBytes(item.size))} · ${escHtml(prettyDate(item.modified))}</small>`
                    + `</label>`;
            }).join('');
            const allChecked = entries.every(item => selected.has(item.remote));
            // 搜索时强制展开，否则搜到了却看不见
            const open = keyword() || expanded.has(name) ? ' open' : '';
            return `<details class="wdcb-cloud-group" data-group="${escHtml(name)}"${open}>`
                + `<summary>`
                + `<input type="checkbox" class="wdcb-cloud-group-check" data-group="${escHtml(name)}"${allChecked ? ' checked' : ''}>`
                + `<span>${escHtml(name)} · ${entries.length}</span></summary>`
                + `<div class="wdcb-cloud-rows">${rows}</div></details>`;
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
    $('#wdcb-cloud-meta').text(parts.join('，'));
}

/** 记住用户手动展开了哪些分组，重渲染时（比如整组勾选）不至于又全折回去。 */
export function noteToggle(group, open) {
    if (open) expanded.add(group);
    else expanded.delete(group);
}

/** 勾选/取消单个文件。 */
export function toggleItem(remote, checked) {
    if (checked) selected.add(remote);
    else selected.delete(remote);
    renderMeta();
}

/** 勾选/取消整组（只作用于当前可见的那些，配合搜索使用）。 */
export function toggleGroup(group, checked) {
    for (const item of visibleItems()) {
        if (item.group !== group) continue;
        if (checked) selected.add(item.remote);
        else selected.delete(item.remote);
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
            console.warn('[WebDAV Chat Backup] 读取云端文件失败：', error);
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
        const needsReload = await reloadTouched(data.touched);

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
