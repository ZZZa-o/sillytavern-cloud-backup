/**
 * SillyTavern 前端扩展入口。
 * 只负责建面板、绑事件、启动定时器，具体实现在同目录的各模块：
 *
 *   settings.js  默认值、读写、表单映射
 *   ui.js        忙碌态、状态栏、格式化、withBusy 包装
 *   api.js       与服务端插件通信、密码与连接测试
 *   panel.js     面板 HTML
 *   sync.js      多端同步
 *   snapshot.js  zip 全量快照
 *   auto.js      自动执行
 */
import { eventSource, event_types } from '/script.js';

import { readFormIntoSettings } from './settings.js';
import { setStatus } from './ui.js';
import { checkHelper, savePassword, clearPassword, testConnection } from './api.js';
import { buildPanel } from './panel.js';
import { previewSync, runSync } from './sync.js';
import { createSnapshot, refreshList, restoreSnapshot, deleteSnapshot, renderSelectedMeta } from './snapshot.js';
import * as auto from './auto.js';

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
        auto.syncTimer();
        setStatus('配置已保存。', 'ok');
    });
    on('wdcb-save-password', savePassword);
    on('wdcb-clear-password', clearPassword);
    on('wdcb-test', () => testConnection(() => refreshList(false)));
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
        auto.syncTimer();
    });

    for (const name of CHAT_EVENTS) {
        const event = event_types[name];
        if (event) eventSource.on(event, () => auto.queue('auto-chat'));
    }

    window.addEventListener('pagehide', () => auto.maybeRun('auto-pagehide'));
}

jQuery(async () => {
    buildPanel();
    bindEvents();
    auto.syncTimer();
    await checkHelper();
});
