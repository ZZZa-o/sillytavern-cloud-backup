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
    $('#stcb-root button').prop('disabled', value);
}

export function setStatus(message, type = 'info') {
    const text = String(message || '').trim();
    const status = $('#stcb-status').removeClass('is-info is-ok is-warn is-error').text(text);
    if (text) status.addClass(`is-${type}`);
}

export function notify(type, message) {
    if (typeof window.toastr?.[type] === 'function') {
        window.toastr[type](message);
    }
}

export function setReport(html) {
    $('#stcb-report').html(html);
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
    return `<label class="stcb-field"><span>${escHtml(label)}</span>${control}</label>`;
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
    return `<label class="stcb-inline-field"><span>${escHtml(label)}</span>`
        + `<input id="${id}" class="text_pole" type="number" min="${min}" max="${max}" step="${step}" value="${attr(value)}">`
        + `<span>${escHtml(suffix)}</span></label>`;
}

function section(title, ...blocks) {
    const heading = title ? `<div class="stcb-section-title">${escHtml(title)}</div>` : '';
    return `<section class="stcb-section">${heading}${blocks.join('')}</section>`;
}

const row = (cls, ...items) => `<div class="${cls}">${items.join('')}</div>`;

export function buildPanel() {
    const c = getConfig();

    const connection = section('',
        row('stcb-grid',
            field('WebDAV 地址', textInput('stcb-url', c.url, { type: 'url', placeholder: 'https://dav.jianguoyun.com/dav/' })),
            field('用户名', textInput('stcb-username', c.username, { autocomplete: 'username' })),
            field('远端目录', textInput('stcb-remote-path', c.remotePath, { placeholder: 'SillyTavern-WebDAV-Backup' })),
            field('授权密码', textInput('stcb-password', '', {
                type: 'password',
                autocomplete: 'new-password',
                placeholder: c.hasPassword ? '已保存，留空则不修改' : '填入后点保存配置',
            })),
        ),
        row('stcb-actions',
            button('stcb-save-config', 'fa-floppy-disk', '保存配置', 'primary'),
            button('stcb-test', 'fa-plug-circle-check', '测试连接'),
        ),
    );

    const scope = section('备份范围',
        button('stcb-scope', 'fa-list-check', '范围'),
        `<div id="stcb-scope-text" class="stcb-meta">当前已选择同步范围：${escHtml(describeScope())}</div>`,
    );

    const backup = section('备份',
        row('stcb-actions',
            button('stcb-preview', 'fa-eye', '预览变更'),
            button('stcb-upload', 'fa-cloud-arrow-up', '上传到云端', 'primary'),
            button('stcb-download', 'fa-cloud-arrow-down', '从云端下载'),
        ),
        '<div id="stcb-report" class="stcb-report"></div>',
    );

    const cloud = section('云端文件',
        row('stcb-actions',
            button('stcb-cloud-refresh', 'fa-rotate', '刷新'),
            button('stcb-cloud-download', 'fa-download', '下载选中'),
            button('stcb-cloud-delete', 'fa-trash-can', '删除选中', 'danger'),
        ),
        row('stcb-actions',
            button('stcb-cloud-sort', 'fa-arrow-down-short-wide', '按路径'),
            button('stcb-cloud-current', 'fa-user', '当前角色'),
        ),
        '<input type="search" id="stcb-cloud-search" class="text_pole stcb-cloud-search" placeholder="搜索云端文件…">',
        '<div id="stcb-cloud-list" class="stcb-cloud-list"></div>',
        '<div id="stcb-cloud-meta" class="stcb-meta"></div>',
    );

    const auto = `<section class="stcb-section stcb-section-auto">`
        + `<div class="stcb-section-title">自动上传</div>`
        + row('stcb-auto-row',
            checkbox('stcb-auto-enabled', '启用', c.auto.enabled),
            checkbox('stcb-auto-events', '聊天变化后检查', c.auto.onChatEvents),
            numberField('stcb-auto-hours', '间隔', c.auto.intervalHours, { min: 0.25, max: 168, step: 0.25 }, '小时'),
        )
        + `</section>`;

    const html = `
        <div id="stcb-root" class="stcb-shell">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-cloud-arrow-up"></i> 酒馆云备份</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    ${row('stcb-statusline',
                        '<span id="stcb-helper-status" class="stcb-pill is-muted">检查中</span>',
                        `<span id="stcb-password-state" class="stcb-pill ${c.hasPassword ? 'is-ok' : 'is-muted'}">${c.hasPassword ? '密码已保存' : '未保存密码'}</span>`,
                        '<span id="stcb-last-backup" class="stcb-pill is-muted">尚未备份</span>',
                    )}
                    ${connection}
                    ${scope}
                    ${backup}
                    ${cloud}
                    ${auto}
                    <div id="stcb-status" class="stcb-status"></div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);
}

/** 后端配置到手后重刷输入框；密码框永远不回显。 */
export function fillForm() {
    const c = getConfig();
    $('#stcb-url').val(c.url);
    $('#stcb-username').val(c.username);
    $('#stcb-remote-path').val(c.remotePath);
    $('#stcb-password').val('').attr('placeholder', c.hasPassword ? '已保存，留空则不修改' : '填入后点保存配置');
    $('#stcb-auto-enabled').prop('checked', c.auto.enabled);
    $('#stcb-auto-events').prop('checked', c.auto.onChatEvents);
    $('#stcb-auto-hours').val(c.auto.intervalHours);
    renderPasswordState(c.hasPassword);
    renderScopeText();
}

export function renderPasswordState(saved) {
    $('#stcb-password-state')
        .toggleClass('is-ok', !!saved)
        .toggleClass('is-muted', !saved)
        .text(saved ? '密码已保存' : '未保存密码');
}

export function renderScopeText() {
    $('#stcb-scope-text').text(`当前已选择同步范围：${describeScope()}`);
}

export function renderLastBackup(value) {
    $('#stcb-last-backup').text(value ? `上次备份 ${prettyDate(value)}` : '尚未备份');
}

/** 把面板上的连接与自动执行输入写回内存配置。范围不在这里，它由弹窗直接改。 */
export function readFormIntoConfig() {
    const c = getConfig();
    const val = id => $(`#${id}`).val()?.toString() ?? '';
    c.url = val('stcb-url').trim();
    c.username = val('stcb-username').trim();
    c.remotePath = val('stcb-remote-path').trim() || 'SillyTavern-WebDAV-Backup';
    c.auto.enabled = $('#stcb-auto-enabled').prop('checked');
    c.auto.onChatEvents = $('#stcb-auto-events').prop('checked');
    c.auto.intervalHours = Math.max(0.25, Number(val('stcb-auto-hours')) || 6);
    return c;
}
