/** 连接配置、方案管理与备份范围设置。 */
import { api } from './api.js';
import {
    getConfig, loadConfig, pushConfig, setScopeDirs, setChatCounts, setSynthLists,
    addProfile, renameProfile, removeProfile, setActiveProfile, activeProfile,
} from './settings.js';
import {
    setStatus, withBusy,
    fillForm, renderPasswordState, renderEncryptState, renderScopeText, renderLastBackup, readFormIntoConfig,
} from './panel.js';
import { openScopePopup } from './scope.js';
import { setEmbeddedBooks } from './tavern.js';
import { resetBackupMonitor } from './backup.js';
import { refreshCloud } from './cloud.js';

// 后端状态与配置

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
        setStatus(error.message, 'error');
        return false;
    }
}

/** 初始化面板：检查后端状态并加载配置。 */
export async function bootstrap() {
    if (!await checkHelper()) return;
    try {
        await loadConfig();
        fillForm();
        await resetBackupMonitor();
    } catch (error) {
        setStatus(`读取配置失败：${error.message}`, 'error');
    }
    // 异步加载内嵌世界书名单，完成后更新范围文案。
    refreshEmbeddedBooks().then(renderScopeText);
}

/** 尝试加载后端解析的内嵌世界书名单。 */
export async function refreshEmbeddedBooks() {
    try {
        const data = await api('cards/embedded-worlds');
        setEmbeddedBooks(data.books);
    } catch (error) {
        console.warn('[SillyTavern Cloud Backup] 读取内嵌世界书名单失败：', error);
    }
}

/** 保存配置；首次开启加密时请求确认。 */
export async function saveConfig() {
    const before = getConfig().encryption || {};
    const wasEnabled = !!before.enabled;
    readFormIntoConfig();
    const password = $('#stcb-password').val()?.toString() ?? '';
    const passphrase = $('#stcb-passphrase').val()?.toString() ?? '';
    const nowEnabled = !!getConfig().encryption?.enabled;

    // 开启加密时要求填写口令。
    if (nowEnabled && !passphrase) {
        setStatus('请填写加密口令。', 'error');
        return;
    }

    if (nowEnabled && !wasEnabled) {
        const ok = confirm(
            '开启加密？\n\n文件需通过本插件取回；口令丢失无法恢复，换设备请使用同一口令。',
        );
        if (!ok) {
            // 取消确认时关闭加密勾选并更新显示。
            getConfig().encryption.enabled = false;
            fillForm();
            setStatus('已取消，加密未开启。', 'info');
            return;
        }
    }

    await withBusy('正在保存配置...', async () => {
        await pushConfig(password, { passphrase });
        fillForm();
        await resetBackupMonitor();
        setStatus('配置已保存。', 'ok');
    });
}

// WebDAV 方案管理；备份范围与自动上传设置全局共用。

/** 保存当前方案的表单内容，切换方案后立即落盘。 */
export async function switchProfile(id) {
    readFormIntoConfig();
    if (!setActiveProfile(id)) return;

    await withBusy('正在切换方案...', async () => {
        await pushConfig();
        fillForm();
        await resetBackupMonitor();
        setStatus(`已切换到方案「${activeProfile().name}」。`, 'ok', 3000);
        await refreshCloud(false);
    });
}

export async function createProfile() {
    const name = prompt('新方案的名字：', '新方案');
    if (name === null) return;

    readFormIntoConfig();
    addProfile(name.trim());

    await withBusy('正在新建方案...', async () => {
        await pushConfig();
        fillForm();
        await resetBackupMonitor();
        setStatus('方案已新建，请填写连接信息并保存。', 'ok');
    });
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
        setStatus(`方案已改名为「${activeProfile().name}」。`, 'ok', 3000);
    });
}

/** 删除本机连接方案，保留云端文件。 */
export async function deleteActiveProfile() {
    const profile = activeProfile();
    if (getConfig().profiles.length <= 1) {
        setStatus('至少要保留一个方案。', 'warn');
        return;
    }
    if (!confirm(`删除方案「${profile.name}」？\n\n仅删除本机配置，保留云端文件。`)) return;

    readFormIntoConfig();
    removeProfile(profile.id);

    await withBusy('正在删除方案...', async () => {
        await pushConfig();
        fillForm();
        await resetBackupMonitor();
        setStatus(`方案已删除，当前为「${activeProfile().name}」。`, 'ok', 3000);
        await refreshCloud(false);
    });
}

export async function testConnection() {
    await withBusy('正在测试连接...', async () => {
        const data = await api('test');
        setStatus(data.message, 'ok');
        await refreshCloud(false);
    });
}

/** 确认备份范围后立即保存。 */
export async function editScope() {
    // 刷新内嵌世界书名单、目录清单与聊天统计后打开弹窗。
    await Promise.all([refreshEmbeddedBooks(), checkHelper()]);
    const confirmed = await openScopePopup();
    if (!confirmed) return;
    await withBusy('正在保存备份范围...', async () => {
        await pushConfig();
        renderScopeText();
        await resetBackupMonitor();
        setStatus('备份范围已保存。', 'ok');
    });
}
