/** 面板通用状态与格式化。业务模块通过 withBusy 统一处理忙碌态和错误提示。 */
import { getSettings, saveSettings } from './settings.js';

export function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function prettyDate(value) {
    if (!value) return '尚未备份';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function prettyBytes(size) {
    const num = Number(size) || 0;
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
    return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

let busy = false;

export function isBusy() {
    return busy;
}

export function setBusy(value) {
    busy = value;
    $('#wdcb-root button, #wdcb-root input, #wdcb-root select').prop('disabled', value);
}

export function setStatus(message, type = 'info') {
    const text = String(message || '').trim();
    getSettings().lastStatus = text;
    saveSettings();
    const status = $('#wdcb-status').removeClass('is-info is-ok is-warn is-error').text(text);
    if (text) status.addClass(`is-${type}`);
}

export function notify(type, message) {
    if (typeof window.toastr?.[type] === 'function') {
        window.toastr[type](message);
    }
}

export function setReport(html) {
    $('#wdcb-sync-report').html(html);
}

/**
 * 包住"置忙 → 执行 → 出错则显示 → 复位"这套每个动作都要写一遍的样板。
 * fn 抛错时把消息写进状态栏，返回 undefined。
 */
export async function withBusy(pendingMessage, fn, fallbackError = '操作失败。') {
    setBusy(true);
    if (pendingMessage) setStatus(pendingMessage, 'info');
    try {
        return await fn();
    } catch (error) {
        setStatus(error?.message || fallbackError, 'error');
        return undefined;
    } finally {
        setBusy(false);
    }
}
