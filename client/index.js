/**
 * SillyTavern 前端扩展入口。各文件分工：
 *
 *   index.js     入口：建面板、绑事件（本文件）
 *   api.js       后端调用与角色名映射
 *   settings.js  配置内存副本与范围判定
 *   panel.js     面板 HTML、状态栏与格式化
 *   scope.js     备份范围弹窗（一级四类 → 二级多选）
 *   cloud.js     云端文件管理
 *   actions.js   全部动作：保存、测试、预览、上传、下载、自动执行
 */
import { eventSource, event_types } from '/script.js';

import { buildPanel, readFormIntoConfig } from './panel.js';
import { pushConfig } from './settings.js';
import {
    bootstrap, saveConfig, testConnection, editScope,
    previewBackup, runUpload, runDownload,
    autoMaybeRun, autoQueue, autoTimer,
} from './actions.js';
import { refreshCloud, downloadSelected, deleteSelected, renderCloud, toggleItem, toggleGroup, noteToggle } from './cloud.js';

const AUTO_INPUTS = ['#wdcb-auto-enabled', '#wdcb-auto-events', '#wdcb-auto-hours'].join(', ');

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

    on('wdcb-save-config', saveConfig);
    on('wdcb-test', testConnection);
    on('wdcb-scope', editScope);

    on('wdcb-preview', previewBackup);
    on('wdcb-upload', () => runUpload('manual'));
    on('wdcb-download', runDownload);

    on('wdcb-cloud-refresh', () => refreshCloud(true));
    on('wdcb-cloud-download', downloadSelected);
    on('wdcb-cloud-delete', deleteSelected);

    $('#wdcb-cloud-search').on('input', renderCloud);
    $('#wdcb-cloud-list').on('change', 'input[type="checkbox"]', function () {
        const group = this.dataset.group;
        if (group) toggleGroup(group, this.checked);
        else toggleItem(this.value, this.checked);
    });
    // details 的展开状态得自己记，重渲染会把 DOM 整个换掉。
    // toggle 事件不冒泡，jQuery 的事件委托接不到，只能用捕获阶段。
    document.querySelector('#wdcb-cloud-list')?.addEventListener('toggle', event => {
        const details = event.target?.closest?.('details.wdcb-cloud-group');
        if (details) noteToggle(details.dataset.group, details.open);
    }, true);

    // 自动执行的开关改完就落盘，不必再点一次保存配置
    $(AUTO_INPUTS).on('change', async () => {
        readFormIntoConfig();
        autoTimer();
        try {
            await pushConfig();
        } catch (error) {
            console.warn('[WebDAV Chat Backup] 保存自动执行设置失败：', error);
        }
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
    renderCloud();
    await bootstrap();
    autoTimer();
});
