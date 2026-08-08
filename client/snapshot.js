/** zip 全量快照：创建、清单、恢复、删除。 */
import { getSettings, saveSettings, readFormIntoSettings } from './settings.js';
import { apiWithSettings } from './api.js';
import { escHtml, prettyBytes, prettyDate, setStatus, notify, withBusy } from './ui.js';

function renderList(items = []) {
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
        renderList(data.items || []);
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
