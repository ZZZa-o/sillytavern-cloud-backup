/** 与服务端插件通信，以及密码与连接相关的动作。 */
import { getRequestHeaders } from '/script.js';

import { SECRET_KEY, getSettings, saveSettings, readFormIntoSettings, getPayloadSettings } from './settings.js';
import { setStatus, notify, withBusy, prettyDate } from './ui.js';

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
export function apiWithSettings(action, extra = {}) {
    return api(action, { settings: getPayloadSettings(), ...extra });
}

export function updateSyncPill() {
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
            body: JSON.stringify({ key: SECRET_KEY, value, label: 'WebDAV Chat Backup' }),
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

export async function testConnection(onSuccess) {
    readFormIntoSettings();
    await withBusy('正在测试连接...', async () => {
        const data = await apiWithSettings('test');
        setStatus(data.message || '连接测试通过。', 'ok');
        notify('success', 'WebDAV 连接测试通过');
        if (onSuccess) await onSuccess();
    }, '连接测试失败。');
}
