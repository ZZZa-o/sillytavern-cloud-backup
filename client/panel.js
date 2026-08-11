/** 面板：HTML 搭建、状态栏、忙碌态与通用格式化。 */
import { getConfig, describeScope } from './settings.js';

// ---------------------------------------------------------------------------
// 格式化与状态
// ---------------------------------------------------------------------------

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

/**
 * 只禁用按钮，不动输入框 —— 上传期间用户还能继续填地址或改密码，
 * 早先连 input 一起禁用会把正在输入的内容打断。
 */
export function setBusy(value) {
    busy = value;
    $('#wdcb-root button').prop('disabled', value);
}

export function setStatus(message, type = 'info') {
    const text = String(message || '').trim();
    const status = $('#wdcb-status').removeClass('is-info is-ok is-warn is-error').text(text);
    if (text) status.addClass(`is-${type}`);
}

export function notify(type, message) {
    if (typeof window.toastr?.[type] === 'function') {
        window.toastr[type](message);
    }
}

export function setReport(html) {
    $('#wdcb-report').html(html);
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

// ---------------------------------------------------------------------------
// 面板 HTML。用小构件拼装，避免同样的 button / checkbox 标签抄十遍。
// ---------------------------------------------------------------------------

const attr = value => escHtml(value);

function textInput(id, value, { type = 'text', placeholder = '', autocomplete = '' } = {}) {
    const extra = autocomplete ? ` autocomplete="${attr(autocomplete)}"` : '';
    return `<input id="${id}" class="text_pole" type="${type}" value="${attr(value)}"`
        + ` placeholder="${attr(placeholder)}"${extra}>`;
}

function field(label, control) {
    return `<label class="wdcb-field"><span>${escHtml(label)}</span>${control}</label>`;
}

function checkbox(id, label, isChecked) {
    return `<label class="checkbox_label"><input id="${id}" type="checkbox"${isChecked ? ' checked' : ''}>`
        + `<span>${escHtml(label)}</span></label>`;
}

// type="button" 是必须的：没有它，按钮在某些主题的表单容器里会触发提交，表现为"点了没反应"
export function button(id, icon, label, variant = '') {
    return `<button type="button" id="${id}" class="menu_button${variant ? ` ${variant}` : ''}">`
        + `<i class="fa-solid ${icon}"></i><span>${escHtml(label)}</span></button>`;
}

function numberField(id, label, value, { min, max, step }, suffix) {
    return `<label class="wdcb-inline-field"><span>${escHtml(label)}</span>`
        + `<input id="${id}" class="text_pole" type="number" min="${min}" max="${max}" step="${step}" value="${attr(value)}">`
        + `<span>${escHtml(suffix)}</span></label>`;
}

function section(title, ...blocks) {
    const heading = title ? `<div class="wdcb-section-title">${escHtml(title)}</div>` : '';
    return `<section class="wdcb-section">${heading}${blocks.join('')}</section>`;
}

const row = (cls, ...items) => `<div class="${cls}">${items.join('')}</div>`;

export function buildPanel() {
    const c = getConfig();

    const connection = section('',
        row('wdcb-grid',
            field('WebDAV 地址', textInput('wdcb-url', c.url, { type: 'url', placeholder: 'https://dav.jianguoyun.com/dav/' })),
            field('用户名', textInput('wdcb-username', c.username, { autocomplete: 'username' })),
            field('远端目录', textInput('wdcb-remote-path', c.remotePath, { placeholder: 'SillyTavern-WebDAV-Backup' })),
            field('授权密码', textInput('wdcb-password', '', {
                type: 'password',
                autocomplete: 'new-password',
                placeholder: c.hasPassword ? '已保存，留空则不修改' : '填入后点保存配置',
            })),
        ),
        row('wdcb-actions',
            button('wdcb-save-config', 'fa-floppy-disk', '保存配置', 'primary'),
            button('wdcb-test', 'fa-plug-circle-check', '测试连接'),
        ),
    );

    const scope = section('备份范围',
        button('wdcb-scope', 'fa-list-check', '范围'),
        `<div id="wdcb-scope-text" class="wdcb-meta">当前已选择同步范围：${escHtml(describeScope())}</div>`,
    );

    const backup = section('备份',
        row('wdcb-actions',
            button('wdcb-preview', 'fa-eye', '预览变更'),
            button('wdcb-upload', 'fa-cloud-arrow-up', '上传到云端', 'primary'),
            button('wdcb-download', 'fa-cloud-arrow-down', '从云端下载'),
        ),
        '<div id="wdcb-report" class="wdcb-report"></div>',
    );

    const cloud = section('云端文件',
        row('wdcb-actions',
            button('wdcb-cloud-refresh', 'fa-rotate', '刷新'),
            button('wdcb-cloud-download', 'fa-download', '下载选中'),
            button('wdcb-cloud-delete', 'fa-trash-can', '删除选中', 'danger'),
        ),
        '<input type="search" id="wdcb-cloud-search" class="text_pole wdcb-cloud-search" placeholder="搜索云端文件…">',
        '<div id="wdcb-cloud-list" class="wdcb-cloud-list"></div>',
        '<div id="wdcb-cloud-meta" class="wdcb-meta"></div>',
    );

    const auto = `<section class="wdcb-section wdcb-section-auto">`
        + `<div class="wdcb-section-title">自动上传</div>`
        + row('wdcb-auto-row',
            checkbox('wdcb-auto-enabled', '启用', c.auto.enabled),
            checkbox('wdcb-auto-events', '聊天变化后检查', c.auto.onChatEvents),
            numberField('wdcb-auto-hours', '间隔', c.auto.intervalHours, { min: 0.25, max: 168, step: 0.25 }, '小时'),
        )
        + `</section>`;

    const html = `
        <div id="wdcb-root" class="wdcb-shell">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-cloud-arrow-up"></i> 聊天云备份</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    ${row('wdcb-statusline',
                        '<span id="wdcb-helper-status" class="wdcb-pill is-muted">检查中</span>',
                        `<span id="wdcb-password-state" class="wdcb-pill ${c.hasPassword ? 'is-ok' : 'is-muted'}">${c.hasPassword ? '密码已保存' : '未保存密码'}</span>`,
                        '<span id="wdcb-last-backup" class="wdcb-pill is-muted">尚未备份</span>',
                    )}
                    ${connection}
                    ${scope}
                    ${backup}
                    ${cloud}
                    ${auto}
                    <div id="wdcb-status" class="wdcb-status"></div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);
}

/** 后端配置到手后重刷输入框；密码框永远不回显。 */
export function fillForm() {
    const c = getConfig();
    $('#wdcb-url').val(c.url);
    $('#wdcb-username').val(c.username);
    $('#wdcb-remote-path').val(c.remotePath);
    $('#wdcb-password').val('').attr('placeholder', c.hasPassword ? '已保存，留空则不修改' : '填入后点保存配置');
    $('#wdcb-auto-enabled').prop('checked', c.auto.enabled);
    $('#wdcb-auto-events').prop('checked', c.auto.onChatEvents);
    $('#wdcb-auto-hours').val(c.auto.intervalHours);
    renderPasswordState(c.hasPassword);
    renderScopeText();
}

export function renderPasswordState(saved) {
    $('#wdcb-password-state')
        .toggleClass('is-ok', !!saved)
        .toggleClass('is-muted', !saved)
        .text(saved ? '密码已保存' : '未保存密码');
}

export function renderScopeText() {
    $('#wdcb-scope-text').text(`当前已选择同步范围：${describeScope()}`);
}

export function renderLastBackup(value) {
    $('#wdcb-last-backup').text(value ? `上次备份 ${prettyDate(value)}` : '尚未备份');
}

/** 把面板上的连接与自动执行输入写回内存配置。范围不在这里，它由弹窗直接改。 */
export function readFormIntoConfig() {
    const c = getConfig();
    const val = id => $(`#${id}`).val()?.toString() ?? '';
    c.url = val('wdcb-url').trim();
    c.username = val('wdcb-username').trim();
    c.remotePath = val('wdcb-remote-path').trim() || 'SillyTavern-WebDAV-Backup';
    c.auto.enabled = $('#wdcb-auto-enabled').prop('checked');
    c.auto.onChatEvents = $('#wdcb-auto-events').prop('checked');
    c.auto.intervalHours = Math.max(0.25, Number(val('wdcb-auto-hours')) || 6);
    return c;
}
