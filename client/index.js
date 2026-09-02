/**
 * SillyTavern 前端扩展入口。各文件分工：
 *
 *   index.js       入口：建面板、绑事件（本文件）
 *   api.js         后端调用与角色名映射
 *   settings.js    配置内存副本与范围判定
 *   panel.js       面板 HTML、状态栏与格式化
 *   scope.js       备份范围弹窗（一级四类 → 二级多选）
 *   cloud.js       云端文件管理
 *   actions.js     全部动作：保存、测试、预览、上传、下载、自动执行
 *   flush-guard.js 离开页面前该不该逼酒馆落盘（纯函数）
 */
import { eventSource, event_types } from '/script.js';

import { buildPanel, readFormIntoConfig } from './panel.js';
import { pushConfig } from './settings.js';
import {
    bootstrap, saveConfig, testConnection, editScope,
    previewBackup, runUpload, runDownload,
    autoQueue, autoTimer, setGenerating,
    switchProfile, createProfile, renameActiveProfile, deleteActiveProfile,
} from './actions.js';
import {
    refreshCloud, downloadSelected, deleteSelected, renderCloud,
    toggleItem, toggleGroup, noteToggle, toggleSort, toggleLink, filterByCurrentCharacter,
} from './cloud.js';
import { ensureRecentSortOption } from './reload.js';
import { shouldFlushChat, chatLoadedAfterEvent } from './flush-guard.js';

const AUTO_INPUTS = ['#stcb-auto-enabled', '#stcb-auto-events', '#stcb-auto-minutes'].join(', ');

/*
 * 触发一次"该检查是否自动上传了"的酒馆事件。
 *
 * 没有 MESSAGE_SWIPED —— 重 roll 时它在生成开始前就发出来了，
 * 那时新回复还没影子，赶着上传只会把上一轮的状态传上去。用户选定哪一条之后，
 * 总会跟着一次 MESSAGE_SENT 或切聊天，那时再传不迟。
 */
const CHAT_EVENTS = [
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'MESSAGE_EDITED',
    'MESSAGE_DELETED',
    'CHAT_CHANGED',
    'CHAT_CREATED',
    'GROUP_CHAT_CREATED',
];

// ---------------------------------------------------------------------------
// 离开页面前把聊天落盘
//
// 自动上传扫的是磁盘上的 .jsonl，而聊天在酒馆内存里 —— 关标签页时最后几条
// 消息未必已经写下去。所以先喊酒馆自己存一次，存不存得成由 flush-guard 判定。
// ---------------------------------------------------------------------------

let chatLoadedThisSession = false;
let loadedThisChid = null;
let loadedSelectedGroup = null;
let leaveFlushInFlight = false;

function ctx() {
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
    } catch (error) {
        console.warn('[SillyTavern Cloud Backup] 取 context 失败：', error);
    }
    return {};
}

/** 记下"聊天加载完成那一刻停在哪个角色/群组"，供之后比对有没有切走。 */
function rememberLoadedEntity(loaded) {
    const c = ctx();
    chatLoadedThisSession = loaded;
    loadedThisChid = loaded ? (c.characterId ?? c.this_chid ?? null) : null;
    loadedSelectedGroup = loaded ? (c.groupId ?? c.selected_group ?? null) : null;
}

let generating = false;

function flushState() {
    const c = ctx();
    return {
        thisChid: c.characterId ?? c.this_chid,
        selectedGroup: c.groupId ?? c.selected_group,
        loadedThisChid,
        loadedSelectedGroup,
        chatLoaded: chatLoadedThisSession,
        isChatSaving: !!c.isChatSaving,
        // 自己记的这个标志比翻 context 里的内部对象可靠
        isStreaming: generating,
    };
}

/**
 * 只做本地落盘，不碰云端。
 *
 * pagehide 之后浏览器随时可能把页面冻掉，一次 WebDAV 往返根本没保证跑得完；
 * 而 saveChatConditional 是酒馆自己的同步存盘路径，快得多。云端那一趟留给
 * 下次启动或定时器 —— 那时磁盘上已经是完整的，传上去的才是对的。
 */
async function flushChatOnLeave() {
    if (leaveFlushInFlight) return;
    if (!shouldFlushChat(flushState())) return;

    const save = ctx().saveChatConditional;
    if (typeof save !== 'function') return;

    leaveFlushInFlight = true;
    try {
        await save();
    } catch (error) {
        console.warn('[SillyTavern Cloud Backup] 离开前落盘失败：', error);
    } finally {
        leaveFlushInFlight = false;
    }
}

function bindTavernEvents() {
    for (const name of CHAT_EVENTS) {
        const event = event_types[name];
        if (event) eventSource.on(event, () => autoQueue('auto-chat'));
    }

    // 生成中不上传，也不落盘 —— 这会儿最后一条消息是半截的
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            generating = true;
            setGenerating(true);
        });
    }
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        const event = event_types[name];
        if (event) {
            eventSource.on(event, () => {
                generating = false;
                setGenerating(false);
            });
        }
    }

    // 单人聊天：CHAT_CHANGED 之后还会来一发 CHAT_LOADED，以后者为准。
    // 群聊：只发 CHAT_CHANGED，永远等不到 CHAT_LOADED，必须认它
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            const c = ctx();
            const group = c.groupId ?? c.selected_group;
            const hasGroup = group !== undefined && group !== null && group !== '';
            rememberLoadedEntity(chatLoadedAfterEvent('changed', hasGroup));
        });
    }
    // 老版本 context 可能没导出这个键，事件名本身是稳定的
    eventSource.on(event_types.CHAT_LOADED || 'chatLoaded', () => {
        rememberLoadedEntity(chatLoadedAfterEvent('loaded', false));
    });

    // 手机上切后台比关标签页常见得多，两个都要接
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flushChatOnLeave();
    });
    window.addEventListener('pagehide', () => { void flushChatOnLeave(); });
}

function bindEvents() {
    const on = (id, handler) => $(`#${id}`).on('click', handler);

    on('stcb-save-config', saveConfig);
    on('stcb-test', testConnection);

    // 勾上才展开口令框。只管显隐，不落盘 —— 加密开关跟着「保存配置」一起生效，
    // 免得用户刚勾上还没填口令就被后端拒绝连接
    $('#stcb-encrypt').on('change', function () {
        $('#stcb-encrypt-fields').prop('hidden', !$(this).prop('checked'));
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

    on('stcb-cloud-refresh', () => refreshCloud(true));
    on('stcb-cloud-download', downloadSelected);
    on('stcb-cloud-delete', deleteSelected);
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
    // 联动开关长在分组标题里，点它不该顺带把 details 展开或收起
    $('#stcb-cloud-list').on('click', 'button[data-act="link"]', function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleLink();
    });
    // details 的展开状态得自己记，重渲染会把 DOM 整个换掉。
    // toggle 事件不冒泡，jQuery 的事件委托接不到，只能用捕获阶段。
    document.querySelector('#stcb-cloud-list')?.addEventListener('toggle', event => {
        const details = event.target?.closest?.('details.stcb-cloud-group');
        if (details) noteToggle(details.dataset.group, details.open);
    }, true);

    // 自动执行的开关改完就落盘，不必再点一次保存配置
    $(AUTO_INPUTS).on('change', async () => {
        readFormIntoConfig();
        autoTimer();
        try {
            await pushConfig();
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 保存自动执行设置失败：', error);
        }
    });

    // 面板每次重建都会重绑上面那些（它们挂在新 DOM 上），但酒馆事件与 window
    // 监听器是全局的，重复绑会叠加成好几份，热重载插件时就会发生
    if (!window.__stcbTavernBound) {
        window.__stcbTavernBound = true;
        bindTavernEvents();
    }
}

jQuery(async () => {
    buildPanel();
    bindEvents();
    // 排序选项要早点补上：用户上次就停在「最近导入」的话，
    // 酒馆已经按它排好了列表，下拉框却因为找不到这个选项而显示空白
    ensureRecentSortOption();
    renderCloud();
    await bootstrap();
    autoTimer();
});
