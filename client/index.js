/** SillyTavern 前端扩展入口：初始化面板，绑定配置、备份与聊天事件。 */
import { eventSource, event_types } from '/script.js';

import { buildPanel, readFormIntoConfig, setAutoStatus } from './panel.js';
import { pushConfig } from './settings.js';
import {
    bootstrap, saveConfig, testConnection, editScope,
    switchProfile, createProfile, renameActiveProfile, deleteActiveProfile,
} from './actions.js';
import {
    previewBackup, runUpload, runDownload, autoQueue, setGenerating,
    startBackupMonitor, resetBackupMonitor, queueChanges,
} from './backup.js';
import {
    refreshCloud, downloadSelected, deleteSelected, renderCloud,
    selectVisible, clearSelection, toggleOverwrite,
    toggleItem, toggleGroup, noteToggle, toggleSort, toggleLink, filterByCurrentCharacter,
} from './cloud.js';
import { ensureRecentSortOption } from './reload.js';
import { shouldFlushChat, chatLoadedAfterEvent } from './flush-guard.js';

const AUTO_INPUTS = ['#stcb-auto-enabled', '#stcb-auto-events', '#stcb-auto-minutes'].join(', ');

/* 触发自动上传检查的酒馆事件。 */
const CHAT_EVENTS = [
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'MESSAGE_SWIPED',
    'MESSAGE_UPDATED',
    'CHAT_CHANGED',
    'CHAT_CREATED',
    'GROUP_CHAT_CREATED',
];

const CHANGE_EVENTS = [
    'SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'CHARACTER_DELETED',
    'CHARACTER_RENAMED', 'PERSONA_CHANGED', 'PRESET_CHANGED', 'PRESET_DELETED', 'PRESET_RENAMED',
    'CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED',
    'SECRET_WRITTEN', 'SECRET_EDITED', 'SECRET_DELETED', 'SECRET_ROTATED',
];

// 离开页面前保存本地聊天，由 flush-guard 判定是否可执行。

let chatLoadedThisSession = false;
let loadedThisChid = null;
let loadedSelectedGroup = null;
let leaveFlushInFlight = false;

function ctx() {
    return SillyTavern.getContext();
}

/** 记录聊天加载完成时的角色或群组。 */
function rememberLoadedEntity(loaded) {
    const c = ctx();
    chatLoadedThisSession = loaded;
    loadedThisChid = loaded ? c.characterId : null;
    loadedSelectedGroup = loaded ? c.groupId : null;
}

let generating = false;

function flushState() {
    const c = ctx();
    return {
        thisChid: c.characterId,
        selectedGroup: c.groupId,
        loadedThisChid,
        loadedSelectedGroup,
        chatLoaded: chatLoadedThisSession,
        isChatSaving: !!c.isChatSaving,
        // 使用事件维护的生成状态。
        isStreaming: generating,
    };
}

/** 调用酒馆的 saveChatConditional 保存本地聊天。 */
async function flushChatOnLeave() {
    if (leaveFlushInFlight) return;
    if (!shouldFlushChat(flushState())) return;

    leaveFlushInFlight = true;
    try {
        await ctx().saveChatConditional();
    } catch (error) {
        console.warn('[SillyTavern Cloud Backup] 离开前落盘失败：', error);
    } finally {
        leaveFlushInFlight = false;
    }
}

function bindTavernEvents() {
    for (const name of CHAT_EVENTS) {
        eventSource.on(event_types[name], () => autoQueue('auto-chat'));
    }
    for (const name of CHANGE_EVENTS) {
        eventSource.on(event_types[name], () => queueChanges());
    }

    // 生成期间暂停上传与离开页面前的保存。
    eventSource.on(event_types.GENERATION_STARTED, () => {
        generating = true;
        setGenerating(true);
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        eventSource.on(event_types[name], () => {
            generating = false;
            setGenerating(false);
        });
    }

    // 单人聊天以 CHAT_LOADED 为加载完成事件；群聊使用 CHAT_CHANGED。
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const group = ctx().groupId;
        const hasGroup = group !== undefined && group !== null && group !== '';
        rememberLoadedEntity(chatLoadedAfterEvent('changed', hasGroup));
    });
    eventSource.on(event_types.CHAT_LOADED, () => {
        rememberLoadedEntity(chatLoadedAfterEvent('loaded', false));
    });

    // 监听页面隐藏和切到后台事件。
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flushChatOnLeave();
        else queueChanges(0);
    });
    window.addEventListener('focus', () => queueChanges(0));
    window.addEventListener('pagehide', () => { void flushChatOnLeave(); });
}

function bindEvents() {
    const on = (id, handler) => $(`#${id}`).on('click', handler);

    on('stcb-save-config', saveConfig);
    on('stcb-test', testConnection);

    // 按加密开关显示口令框与说明，设置随「保存配置」生效。
    $('#stcb-encrypt').on('change', function () {
        const on = $(this).prop('checked');
        $('#stcb-encrypt-fields').prop('hidden', !on);
        $('#stcb-encrypt-note').prop('hidden', !on);
    });
    on('stcb-scope', editScope);

    $('#stcb-profile').on('change', function () {
        void switchProfile($(this).val()?.toString() ?? '');
    });
    on('stcb-profile-add', createProfile);
    on('stcb-profile-rename', renameActiveProfile);
    on('stcb-profile-remove', deleteActiveProfile);

    on('stcb-preview', previewBackup);
    on('stcb-upload', () => runUpload('manual'));
    on('stcb-download', runDownload);
    $('#stcb-root .inline-drawer-header').on('click', () => queueChanges(0));

    on('stcb-cloud-refresh', () => refreshCloud(true));
    on('stcb-cloud-download', async () => { await downloadSelected(); queueChanges(0); });
    on('stcb-cloud-delete', async () => { await deleteSelected(); queueChanges(0); });
    on('stcb-cloud-select-all', selectVisible);
    on('stcb-cloud-clear-selection', clearSelection);
    on('stcb-cloud-overwrite', toggleOverwrite);
    on('stcb-cloud-sort', function () {
        const mode = toggleSort();
        $(this).find('span').text(mode === 'time' ? '按时间' : '按路径');
        $(this).find('i').attr('class',
            `fa-solid ${mode === 'time' ? 'fa-clock-rotate-left' : 'fa-arrow-down-short-wide'}`);
    });
    on('stcb-cloud-current', filterByCurrentCharacter);

    $('#stcb-cloud-search').on('input', renderCloud);
    $('#stcb-cloud-list').on('change', 'input[type="checkbox"]', function () {
        const group = this.dataset.group;
        if (group) toggleGroup(group, this.checked);
        else toggleItem(this.value, this.checked);
    });
    // 点击联动开关时阻止分组折叠。
    $('#stcb-cloud-list').on('click', 'button[data-act="link"]', function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleLink();
    });
    // 在捕获阶段监听 toggle，记录分组展开状态。
    document.querySelector('#stcb-cloud-list')?.addEventListener('toggle', event => {
        const details = event.target?.closest?.('details.stcb-cloud-group');
        if (details) noteToggle(details.dataset.group, details.open);
    }, true);

    // 自动上传设置修改后立即保存。
    $(AUTO_INPUTS).on('change', async () => {
        readFormIntoConfig();
        try {
            await pushConfig();
            await resetBackupMonitor();
        } catch (error) {
            setAutoStatus(`保存自动上传设置失败：${error.message}`, 'error');
        }
    });

    bindTavernEvents();
}

jQuery(async () => {
    buildPanel();
    bindEvents();
    // 初始化「最近导入」排序选项。
    ensureRecentSortOption();
    renderCloud();
    await bootstrap();
    startBackupMonitor();
});
