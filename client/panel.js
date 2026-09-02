/** 面板：HTML 搭建、状态栏、忙碌态与通用格式化。 */
import {
    getConfig, describeScope, setActiveFields,
    DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES,
} from './settings.js';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';

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
        // 方案 = 一套连接信息。范围与自动上传是全局的，切方案不跟着变
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
        row('stcb-actions',
            button('stcb-save-config', 'fa-floppy-disk', '保存配置', 'primary'),
            button('stcb-test', 'fa-plug-circle-check', '测试连接'),
        ),
        // 加密属于当前方案，不是全局开关 —— 自建 NAS 那套方案可以不开，
        // 免得网盘网页端点开文件全是打不开的密文
        row('stcb-encrypt-row',
            checkbox('stcb-encrypt', '加密上传的文件', !!c.encryption?.enabled),
        ),
        `<div id="stcb-encrypt-fields" class="stcb-encrypt-fields"${c.encryption?.enabled ? '' : ' hidden'}>`
        + field('加密口令', textInput('stcb-passphrase', '', {
            type: 'password',
            autocomplete: 'new-password',
            placeholder: c.encryption?.hasPassphrase ? '已保存，留空则不修改' : '填入后点保存配置',
        }))
        + '<div class="stcb-meta stcb-encrypt-warn">口令丢失后云端数据<b>无法恢复</b>；'
        + '换设备同步时必须填写同一个口令。仅加密文件内容，文件名与大小仍对网盘可见。</div>'
        + '</div>',
    );

    const scope = section('备份范围',
        row('stcb-actions',
            button('stcb-scope', 'fa-list-check', '范围'),
        ),
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
        // 两组按钮包一层，整体推到标题右边，排成一行五个。
        //
        // 文字压到两个字是必须的：面板固定 375px 宽，标题占 50px，
        // 「下载选中」这种四字标签会让五个按钮撑到 344px，加起来超宽，
        // 整条工具条就会被挤到标题下一行去。短标签合计 272px，正好放得下
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
                        `<span id="stcb-encrypt-state" class="stcb-pill is-muted">未加密</span>`,
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

/**
 * 加密状态。三种情况要分清楚 —— 中间那种是最危险的：开了开关却没口令，
 * 用户会以为已经加密了，实际上后端会拒绝连接（resolveConfig 里拦着）。
 */
export function renderEncryptState(encryption) {
    const enabled = !!encryption?.enabled;
    const ready = enabled && !!encryption?.hasPassphrase;
    const pill = $('#stcb-encrypt-state').removeClass('is-ok is-muted is-warn');
    if (!enabled) pill.addClass('is-muted').text('未加密');
    else if (ready) pill.addClass('is-ok').text('已加密');
    else pill.addClass('is-warn').text('缺口令');

    $('#stcb-encrypt').prop('checked', enabled);
    $('#stcb-encrypt-fields').prop('hidden', !enabled);
    $('#stcb-passphrase').val('').attr(
        'placeholder',
        encryption?.hasPassphrase ? '已保存，留空则不修改' : '填入后点保存配置',
    );
}

/** 方案下拉框的选项跟着 profiles 走；选中项即当前方案。 */
export function renderProfileSelect() {
    const c = getConfig();
    const options = c.profiles
        .map(item => `<option value="${escHtml(item.id)}">${escHtml(item.name)}</option>`)
        .join('');
    $('#stcb-profile').html(options).val(c.activeProfileId);
    // 只剩一条时不给删，删光了就没法备份了
    $('#stcb-profile-remove').prop('disabled', c.profiles.length <= 1);
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

/**
 * 把面板上的连接与自动执行输入写回内存配置。范围不在这里，它由弹窗直接改。
 * 连接四项属于当前方案，走 setActiveFields 写进 profiles，顶层那份只是投影。
 */
export function readFormIntoConfig() {
    const c = getConfig();
    const val = id => $(`#${id}`).val()?.toString() ?? '';
    setActiveFields({
        url: val('stcb-url').trim(),
        username: val('stcb-username').trim(),
        remotePath: val('stcb-remote-path').trim() || DEFAULT_REMOTE_PATH,
        // hasPassphrase 由后端说了算，这里只写开关；口令走 pushConfig 的参数
        encryption: {
            enabled: $('#stcb-encrypt').prop('checked'),
            hasPassphrase: !!getConfig().encryption?.hasPassphrase,
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
