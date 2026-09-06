/** 面板：HTML 搭建、状态栏、忙碌态与通用格式化。 */
import {
    getConfig, describeScope, setActiveFields,
    DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES,
} from './settings.js';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';

// 格式化与状态

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

/** 更新按钮的禁用状态。 */
export function setBusy(value) {
    busy = value;
    $('#stcb-root button').prop('disabled', value);
}

function writeStatus(selector, message, type) {
    const text = String(message || '').trim();
    const status = $(selector).removeClass('is-info is-ok is-warn is-error').text(text);
    if (text) status.addClass(`is-${type}`);
}

export function setStatus(message, type = 'info') {
    writeStatus('#stcb-status', message, type);
}

export function setBackupStatus(message, type = 'info') {
    writeStatus('#stcb-backup-status', message, type);
}

export function setAutoStatus(message, type = 'info') {
    writeStatus('#stcb-auto-status', message, type);
}

export function setCheckStatus(message, type = 'info') {
    writeStatus('#stcb-check-status', message, type);
}

/** 更新云端文件区域的状态行。 */
export function setCloudStatus(message, type = 'info') {
    writeStatus('#stcb-cloud-status', message, type);
}

export function notify(type, message) {
    if (typeof window.toastr?.[type] === 'function') {
        window.toastr[type](message);
    }
}

export function setReport(html) {
    $('#stcb-report').html(html);
}

/** 执行动作并显示错误，结束后恢复按钮。 */
export async function withBusy(pendingMessage, fn, status = setStatus) {
    setBusy(true);
    if (pendingMessage) status(pendingMessage, 'info');
    try {
        return await fn();
    } catch (error) {
        status(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

// 面板 HTML 与通用控件。

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

// 统一使用 type="button" 创建操作按钮。
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
        // 每个方案保存一套连接信息，范围与自动上传设置全局共用。
        row('stcb-profile-row',
            `<label class="stcb-inline-field stcb-profile-field"><span>方案</span>`
            + `<select id="stcb-profile" class="text_pole"></select></label>`,
            row('stcb-actions stcb-profile-actions',
                button('stcb-profile-add', 'fa-plus', '新建'),
                button('stcb-profile-rename', 'fa-pen', '重命名'),
                button('stcb-profile-remove', 'fa-trash-can', '删除', 'danger'),
            ),
        ),
        row('stcb-grid',
            field('WebDAV 地址', textInput('stcb-url', c.url, { type: 'url', placeholder: 'https://dav.jianguoyun.com/dav/' })),
            field('用户名', textInput('stcb-username', c.username, { autocomplete: 'username' })),
            field('远端目录', textInput('stcb-remote-path', c.remotePath, { placeholder: DEFAULT_REMOTE_PATH })),
            field('授权密码', textInput('stcb-password', '', {
                type: 'password',
                autocomplete: 'new-password',
                placeholder: c.hasPassword ? '已保存，留空则不修改' : '填入后点保存配置',
            })),
        ),
        // 显示当前方案的加密设置，随连接配置一起保存。
        row('stcb-encrypt-row',
            checkbox('stcb-encrypt', '加密上传的文件', !!c.encryption?.enabled),
        ),
        `<div id="stcb-encrypt-fields" class="stcb-encrypt-fields"${c.encryption?.enabled ? '' : ' hidden'}>`
        // 在文本框中回显当前加密口令。
        + field('加密口令', textInput('stcb-passphrase', c.encryption?.passphrase || '', {
            autocomplete: 'off',
            placeholder: '填入后点保存配置',
        }))
        + '</div>',
        row('stcb-actions',
            button('stcb-save-config', 'fa-floppy-disk', '保存配置', 'primary'),
            button('stcb-test', 'fa-plug-circle-check', '测试连接'),
        ),
        // 在保存按钮下方显示加密说明。
        `<div id="stcb-encrypt-note" class="stcb-meta stcb-encrypt-warn"${c.encryption?.enabled ? '' : ' hidden'}>`
        + '口令丢失<b>无法恢复</b>，换设备请使用同一口令。'
        + '仅加密内容，文件名与大小仍可见。</div>',
        '<div id="stcb-status" class="stcb-status" role="status"></div>',
    );

    const scope = section('备份范围',
        row('stcb-actions',
            button('stcb-scope', 'fa-list-check', '范围'),
        ),
        `<div id="stcb-scope-text" class="stcb-meta">备份范围：${escHtml(describeScope())}</div>`,
    );

    const backup = section('备份',
        row('stcb-actions',
            button('stcb-preview', 'fa-eye', '预览变更'),
            button('stcb-upload', 'fa-cloud-arrow-up', '上传到云端', 'primary'),
            button('stcb-download', 'fa-cloud-arrow-down', '从云端下载'),
        ),
        '<div id="stcb-backup-status" class="stcb-status" role="status"></div>',
        '<div id="stcb-preview-report" class="stcb-report" aria-live="polite"></div>',
        '<div id="stcb-check-status" class="stcb-status stcb-check-status"></div>',
        '<div id="stcb-report" class="stcb-report"></div>',
    );

    const cloud = section('云端文件',
        // 两组操作按钮共用工具条，位于标题右侧。
        row('stcb-cloud-toolbar',
            row('stcb-actions stcb-cloud-actions',
                button('stcb-cloud-refresh', 'fa-rotate', '刷新'),
                button('stcb-cloud-download', 'fa-download', '下载'),
                button('stcb-cloud-delete', 'fa-trash-can', '删除', 'danger'),
            ),
            row('stcb-actions stcb-cloud-actions',
                button('stcb-cloud-sort', 'fa-arrow-down-short-wide', '按路径'),
                button('stcb-cloud-current', 'fa-user', '当前'),
            ),
        ),
        '<input type="search" id="stcb-cloud-search" class="text_pole stcb-cloud-search" placeholder="搜索云端文件…">',
        '<div id="stcb-cloud-list" class="stcb-cloud-list"></div>',
        '<div id="stcb-cloud-meta" class="stcb-meta"></div>',
        // 在云端文件区域底部显示操作结果。
        '<div id="stcb-cloud-status" class="stcb-status stcb-cloud-status"></div>',
    );

    const auto = `<section class="stcb-section stcb-section-auto">`
        + `<div class="stcb-section-title">自动上传</div>`
        + row('stcb-auto-row',
            checkbox('stcb-auto-enabled', '启用', c.auto.enabled),
            checkbox('stcb-auto-events', '聊天变化后检查', c.auto.onChatEvents),
            numberField('stcb-auto-minutes', '间隔', c.auto.intervalMinutes, {
                min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES, step: 5,
            }, '分钟'),
        )
        + '<div id="stcb-auto-status" class="stcb-status" role="status"></div>'
        + '<div id="stcb-auto-report" class="stcb-report"></div>'
        + '</section>';

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
                        `<span id="stcb-encrypt-state" class="stcb-pill is-muted">未加密</span>`,
                        '<span id="stcb-last-backup" class="stcb-pill is-muted">尚未备份</span>',
                    )}
                    ${connection}
                    ${scope}
                    ${backup}
                    ${cloud}
                    ${auto}
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);
}

/** 用后端配置更新表单；WebDAV 授权密码框保持空白。 */
export function fillForm() {
    const c = getConfig();
    renderProfileSelect();
    $('#stcb-url').val(c.url);
    $('#stcb-username').val(c.username);
    $('#stcb-remote-path').val(c.remotePath);
    $('#stcb-password').val('').attr('placeholder', c.hasPassword ? '已保存，留空则不修改' : '填入后点保存配置');
    $('#stcb-auto-enabled').prop('checked', c.auto.enabled);
    $('#stcb-auto-events').prop('checked', c.auto.onChatEvents);
    $('#stcb-auto-minutes').val(c.auto.intervalMinutes);
    renderPasswordState(c.hasPassword);
    renderEncryptState(c.encryption);
    renderScopeText();
    renderLastBackup(c.lastBackupAt);
}

/** 显示未加密、缺口令或已加密状态，同步口令框与说明的显隐。 */
export function renderEncryptState(encryption) {
    const enabled = !!encryption?.enabled;
    const ready = enabled && !!encryption?.hasPassphrase;
    const pill = $('#stcb-encrypt-state').removeClass('is-ok is-muted is-warn');
    if (!enabled) pill.addClass('is-muted').text('未加密');
    else if (ready) pill.addClass('is-ok').text('已加密');
    else pill.addClass('is-warn').text('缺口令');

    $('#stcb-encrypt').prop('checked', enabled);
    $('#stcb-encrypt-fields').prop('hidden', !enabled);
    $('#stcb-encrypt-note').prop('hidden', !enabled);
    // 回填当前方案的加密口令。
    $('#stcb-passphrase').val(encryption?.passphrase || '');
}

/** 方案下拉框的选项跟着 profiles 走；选中项即当前方案。 */
export function renderProfileSelect() {
    const c = getConfig();
    const options = c.profiles
        .map(item => `<option value="${escHtml(item.id)}">${escHtml(item.name)}</option>`)
        .join('');
    $('#stcb-profile').html(options).val(c.activeProfileId);
    // 仅剩一个方案时禁用删除。
    $('#stcb-profile-remove').prop('disabled', c.profiles.length <= 1);
}

export function renderPasswordState(saved) {
    $('#stcb-password-state')
        .toggleClass('is-ok', !!saved)
        .toggleClass('is-muted', !saved)
        .text(saved ? '密码已保存' : '未保存密码');
}

export function renderScopeText() {
    $('#stcb-scope-text').text(`备份范围：${describeScope()}`);
}

export function renderLastBackup(value) {
    $('#stcb-last-backup').text(value ? `上次备份 ${prettyDate(value)}` : '尚未备份');
}

/**
 * 将连接及加密输入写入当前方案，更新全局自动上传设置。
 * 备份范围由范围弹窗修改。
 */
export function readFormIntoConfig() {
    const c = getConfig();
    const val = id => $(`#${id}`).val()?.toString() ?? '';
    setActiveFields({
        url: val('stcb-url').trim(),
        username: val('stcb-username').trim(),
        remotePath: val('stcb-remote-path').trim() || DEFAULT_REMOTE_PATH,
        // 保存输入的口令，并合并当前口令的已保存状态。
        encryption: {
            enabled: $('#stcb-encrypt').prop('checked'),
            hasPassphrase: !!val('stcb-passphrase') || !!getConfig().encryption?.hasPassphrase,
            passphrase: val('stcb-passphrase'),
        },
    });
    c.auto.enabled = $('#stcb-auto-enabled').prop('checked');
    c.auto.onChatEvents = $('#stcb-auto-events').prop('checked');
    c.auto.intervalMinutes = Math.min(
        MAX_INTERVAL_MINUTES,
        Math.max(MIN_INTERVAL_MINUTES, Number(val('stcb-auto-minutes')) || DEFAULT_INTERVAL_MINUTES),
    );
    return c;
}
