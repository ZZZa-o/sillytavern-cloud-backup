/** 面板 HTML。用小构件拼装，避免同样的 button / checkbox 标签抄十遍。 */
import { getSettings } from './settings.js';
import { escHtml, prettyDate } from './ui.js';

const attr = value => escHtml(value);

function textInput(id, value, { type = 'text', placeholder = '', autocomplete = '' } = {}) {
    const extra = autocomplete ? ` autocomplete="${attr(autocomplete)}"` : '';
    return `<input id="${id}" class="text_pole" type="${type}" value="${attr(value)}"`
        + ` placeholder="${attr(placeholder)}"${extra}>`;
}

function select(id, options, current) {
    const body = options
        .map(([value, label]) => `<option value="${attr(value)}"${value === current ? ' selected' : ''}>${escHtml(label)}</option>`)
        .join('');
    return `<select id="${id}" class="text_pole">${body}</select>`;
}

function field(label, control) {
    return `<label class="wdcb-field"><span>${escHtml(label)}</span>${control}</label>`;
}

function checkbox(id, label, isChecked) {
    return `<label class="checkbox_label"><input id="${id}" type="checkbox"${isChecked ? ' checked' : ''}>`
        + `<span>${escHtml(label)}</span></label>`;
}

function button(id, icon, label, variant = '') {
    return `<button id="${id}" class="menu_button${variant ? ` ${variant}` : ''}">`
        + `<i class="fa-solid ${icon}"></i><span>${escHtml(label)}</span></button>`;
}

function numberField(id, label, value, { min, max, step }, suffix) {
    return `<label class="wdcb-inline-field"><span>${escHtml(label)}</span>`
        + `<input id="${id}" class="text_pole" type="number" min="${min}" max="${max}" step="${step}" value="${attr(value)}">`
        + `<span>${escHtml(suffix)}</span></label>`;
}

function inlineField(label, control) {
    return `<label class="wdcb-inline-field"><span>${escHtml(label)}</span>${control}</label>`;
}

function section(title, ...blocks) {
    const heading = title ? `<div class="wdcb-section-title">${escHtml(title)}</div>` : '';
    return `<section class="wdcb-section">${heading}${blocks.join('')}</section>`;
}

const row = (cls, ...items) => `<div class="${cls}">${items.join('')}</div>`;

export function buildPanel() {
    const s = getSettings();
    const lastStatus = String(s.lastStatus || '').trim();
    const syncPill = s.lastSyncAt ? `上次同步 ${prettyDate(s.lastSyncAt)}` : '尚未同步';

    const connection = section('',
        row('wdcb-grid',
            field('WebDAV 地址', textInput('wdcb-url', s.url, { type: 'url', placeholder: 'https://example.com/dav/' })),
            field('用户名', textInput('wdcb-username', s.username, { autocomplete: 'username' })),
            field('远端目录', textInput('wdcb-remote-path', s.remotePath, { placeholder: 'SillyTavern-WebDAV-Backup' })),
            field('授权密码', textInput('wdcb-password', '', {
                type: 'password',
                autocomplete: 'new-password',
                placeholder: s.passwordSaved ? '留空则继续使用已保存密码' : '输入后点击保存密码',
            })),
        ),
        row('wdcb-actions',
            button('wdcb-save-config', 'fa-floppy-disk', '保存配置'),
            button('wdcb-save-password', 'fa-key', '保存密码'),
            button('wdcb-clear-password', 'fa-eraser', '清除密码'),
            button('wdcb-test', 'fa-plug-circle-check', '测试连接'),
        ),
    );

    const scope = section('同步范围',
        row('wdcb-checks',
            checkbox('wdcb-include-chats', '单人聊天', s.includeChats),
            checkbox('wdcb-include-group-chats', '群聊记录与群组', s.includeGroupChats),
            checkbox('wdcb-include-characters', '角色卡', s.includeCharacters),
            checkbox('wdcb-include-worlds', '世界书', s.includeWorlds),
            checkbox('wdcb-include-settings', '设置（仅快照）', s.includeSettings),
        ),
    );

    const sync = section('多端同步',
        row('wdcb-grid',
            field('本机名称', textInput('wdcb-device-name', s.deviceName, { placeholder: '例如 台式机 / 笔记本' })),
            field('同步方向', select('wdcb-sync-direction', [
                ['two-way', '双向同步'],
                ['upload-only', '仅上传（本机覆盖远端）'],
                ['download-only', '仅下载（远端覆盖本机）'],
            ], s.syncDirection)),
        ),
        row('wdcb-actions',
            button('wdcb-sync-preview', 'fa-list-check', '预览变更'),
            button('wdcb-sync-now', 'fa-arrows-rotate', '开始同步', 'primary'),
        ),
        '<div id="wdcb-sync-report" class="wdcb-sync-report"></div>',
    );

    const snapshot = section('全量快照与恢复',
        row('wdcb-actions',
            button('wdcb-backup-now', 'fa-cloud-arrow-up', '创建快照'),
            button('wdcb-refresh-list', 'fa-rotate', '刷新清单'),
        ),
        row('wdcb-restore-row',
            '<select id="wdcb-backup-list" class="text_pole"><option value="">尚未读取快照清单</option></select>',
            button('wdcb-restore', 'fa-clock-rotate-left', '恢复'),
            button('wdcb-delete', 'fa-trash-can', '删除', 'danger'),
        ),
        '<div id="wdcb-backup-meta" class="wdcb-meta"></div>',
    );

    const auto = `<section class="wdcb-section wdcb-section-auto">`
        + `<div class="wdcb-section-title">自动执行</div>`
        + row('wdcb-auto-row',
            checkbox('wdcb-auto-enabled', '启用', s.autoEnabled),
            checkbox('wdcb-auto-events', '聊天变化后检查', s.autoOnChatEvents),
            inlineField('动作', select('wdcb-auto-mode', [
                ['sync', '增量同步'],
                ['snapshot', 'zip 快照'],
            ], s.autoMode)),
            numberField('wdcb-auto-hours', '间隔', s.autoIntervalHours, { min: 0.25, max: 168, step: 0.25 }, '小时'),
            numberField('wdcb-retention', '快照保留', s.retention, { min: 1, max: 200, step: 1 }, '份'),
        )
        + `</section>`;

    const html = `
        <div id="wdcb-root" class="wdcb-shell">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-cloud-arrow-up"></i> WebDAV Chat Backup</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    ${row('wdcb-statusline',
                        '<span id="wdcb-helper-status" class="wdcb-pill is-muted">检查中</span>',
                        `<span id="wdcb-password-state" class="wdcb-pill ${s.passwordSaved ? 'is-ok' : 'is-muted'}">${s.passwordSaved ? '密码已保存' : '未保存密码'}</span>`,
                        `<span id="wdcb-last-sync" class="wdcb-pill is-muted">${escHtml(syncPill)}</span>`,
                    )}
                    ${connection}
                    ${scope}
                    ${sync}
                    ${snapshot}
                    ${auto}
                    <div id="wdcb-status" class="wdcb-status ${lastStatus ? 'is-info' : ''}">${escHtml(lastStatus)}</div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);
}
