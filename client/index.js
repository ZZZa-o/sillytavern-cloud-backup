/**
 * SillyTavern 前端扩展入口。四个文件各管一摊：
 *
 *   index.js     入口：建面板、绑事件（本文件）
 *   settings.js  设置读写与表单映射
 *   panel.js     面板 HTML、状态栏与格式化
 *   actions.js   全部动作：连接、密码、同步、快照、自动执行
 */
import { eventSource, event_types } from '/script.js';

import { readFormIntoSettings } from './settings.js';
import { buildPanel, setStatus } from './panel.js';
import {
    checkHelper, savePassword, clearPassword, testConnection,
    previewSync, runSync,
    createSnapshot, refreshList, restoreSnapshot, deleteSnapshot, renderSelectedMeta,
    autoMaybeRun, autoQueue, autoSyncTimer,
} from './actions.js';

const FORM_INPUTS = [
    '#wdcb-root input[type="checkbox"]',
    '#wdcb-auto-hours',
    '#wdcb-retention',
    '#wdcb-url',
    '#wdcb-username',
    '#wdcb-remote-path',
    '#wdcb-device-name',
    '#wdcb-sync-direction',
    '#wdcb-auto-mode',
].join(', ');

const CHAT_EVENTS = [
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'MESSAGE_SWIPED',
    'CHAT_CHANGED',
    'CHAT_CREATED',
    'GROUP_CHAT_CREATED',
];

function bindEvents() {
    const on = (id, handler) => $(`#${id}`).on('click', handler);

    on('wdcb-save-config', () => {
        readFormIntoSettings();
        autoSyncTimer();
        setStatus('配置已保存。', 'ok');
    });
    on('wdcb-save-password', savePassword);
    on('wdcb-clear-password', clearPassword);
    on('wdcb-test', testConnection);
    on('wdcb-sync-preview', previewSync);
    on('wdcb-sync-now', () => runSync('manual'));
    on('wdcb-backup-now', () => createSnapshot('manual'));
    on('wdcb-refresh-list', () => refreshList(true));
    on('wdcb-restore', restoreSnapshot);
    on('wdcb-delete', deleteSnapshot);

    $('#wdcb-backup-list').on('change', renderSelectedMeta);

    // 定时器只在表单变动时重建：间隔和开关都来自这里
    $(FORM_INPUTS).on('change', () => {
        readFormIntoSettings();
        autoSyncTimer();
    });

    for (const name of CHAT_EVENTS) {
        const event = event_types[name];
        if (event) eventSource.on(event, () => autoQueue('auto-chat'));
    }

    window.addEventListener('pagehide', () => autoMaybeRun('auto-pagehide'));
}

jQuery(async () => {
    buildPanel();
    bindEvents();
    autoSyncTimer();
    await checkHelper();
});
