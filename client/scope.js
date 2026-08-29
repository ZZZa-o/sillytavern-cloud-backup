/**
 * 备份范围弹窗。
 *
 *   一级：角色卡 / 聊天记录 / 世界书 / 预设 / 美化 / 设置 六个按钮，已选的外边框加粗。
 *   二级：三种形态 ——
 *         角色卡是文件夹列表：一张卡一块，默认收起，展开后是它的聊天记录，逐条可勾。
 *           聊天明细在展开那一刻才向后端要 —— 卡多起来一次性回传能到几百 KB。
 *         世界书是平铺多选列表，带搜索、全选、取消全选。
 *         预设与美化也是文件夹列表：按目录折叠，展开逐个勾具体的预设与主题；
 *           背景图没有明细（都是图片，列出来没意义），只有一个整类开关。
 *         设置没有二级 —— 只有 settings.json 一个文件。
 */
import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';

import { api } from './api.js';
import { characterEntries, worldEntries, currentAvatar, embeddedWorldNames } from './tavern.js';
import {
    getConfig, describeScope, scopeEnabled, selectionCount, selectionEmpty,
    getScopeDirs, dirSelection, ensureDirSelection, getChatCount, getSynthList,
    chatCountsSupplied, synthListsSupplied,
} from './settings.js';
import { escHtml, prettyBytes } from './panel.js';

/**
 * 后端没送来这项数据时说的话。
 *
 * 绝不能退回「酒馆里还没有用户人设」那种说法 —— 那是在撒谎，
 * 用户会去翻自己的酒馆找问题，而真正的毛病在服务端插件那一侧。
 */
const BACKEND_TOO_OLD = '后端插件没有返回这项数据。多半是服务端插件还是旧版，'
    + '或者更新了文件但没重启酒馆 —— 服务端插件只在酒馆启动时加载一次，光刷新页面没用。'
    + '请更新 plugins/sillytavern-cloud-backup 后彻底关掉酒馆进程再重开。';

/** 因为已内嵌在角色卡里而没有列出来的世界书数量。 */
function embeddedWorldCount() {
    return embeddedWorldNames().length;
}

/** 角色卡文件名去扩展名 —— 它就是这个角色的聊天目录名。 */
function stemOf(avatar) {
    return String(avatar || '').replace(/\.[^.]+$/, '');
}

/**
 * 触屏设备（手机、平板）。
 * 用指针精度判断而不是 UA —— 带触摸屏的笔记本会被算进来，
 * 代价只是少一次自动聚焦，比误判成桌面直接弹出输入法轻得多。
 */
function isTouchScreen() {
    return window.matchMedia?.('(pointer: coarse)')?.matches === true;
}

// kind 决定二级视图长什么样：cards 是角色卡文件夹，dirs 是目录文件夹，list 是平铺多选
const PICKERS = {
    characters: { title: '选择角色卡与聊天记录', empty: '酒馆里还没有角色卡。', view: 'cards' },
    personas: {
        title: '选择用户人设',
        empty: '酒馆里还没有用户人设。',
        view: 'list',
        entries: () => getSynthList('personas'),
    },
    presets: { title: '选择预设', empty: '没有可备份的预设。', view: 'dirs', group: 'presets' },
    themes: { title: '选择美化', empty: '没有可备份的美化文件。', view: 'dirs', group: 'themes' },
    worlds: { title: '选择世界书', empty: '没有需要单独备份的世界书。', view: 'list', entries: worldEntries },
    apiProfiles: {
        title: '选择 API 配置',
        empty: '酒馆里还没有 API 连接配置。',
        view: 'list',
        entries: () => getSynthList('apiProfiles').map(item => ({
            ...item,
            // 备份会把这个配置引用的密钥明文一起带上，界面上要说清楚
            note: item.hasSecret ? '含密钥明文' : '无密钥',
            warn: item.hasSecret,
        })),
    },
};

// 目录/角色卡的展开状态。键是 `组:标识`，弹窗关掉也留着，下次点进来还是老样子
const expanded = new Set();
const folderKey = (group, key) => `${group}:${key}`;

// 某个角色的聊天明细。展开那一刻才拉，拉过就留着，反复折叠不再打扰后端
const chatCache = new Map();
const chatLoading = new Set();
// 拉失败的原因，按角色目录名记。空列表到底是"没有"还是"没拉到"全靠它分辨
const chatErrors = new Map();

/** 目录里有几项可备份：有明细的按文件数，整类开关的算一项。 */
function dirWeight(dir) {
    if (!dir.files) return 0;
    return dir.detail ? dir.files : 1;
}

/** 某一组里已勾中的项数与总项数。 */
function groupTally(group, scope = getConfig().scope) {
    let chosen = 0;
    let total = 0;
    for (const dir of getScopeDirs(group)) {
        total += dirWeight(dir);
        if (!dir.files) continue;
        const selection = dirSelection(scope, group, dir.key);
        if (selectionEmpty(selection)) continue;
        chosen += dir.detail ? (selection.all ? dir.files : selection.selected.length) : 1;
    }
    return { chosen, total };
}

function popupHtml() {
    return `
        <div class="stcb-scope-popup">
            <div class="stcb-scope-view" data-view="root">
                <div class="stcb-scope-buttons">
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="characters"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="personas"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="presets"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="themes"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="worlds"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="apiProfiles"></button>
                </div>
                <div class="stcb-scope-note">当前已选择同步范围：<b data-role="note"></b></div>
                <div class="stcb-scope-hint">
                    角色卡点进去是文件夹，展开一张卡就能勾它名下的某几条聊天；
                    「含聊天记录」一键把所选角色的聊天全带上，群聊与群组也跟着这个开关走。<br>
                    用户人设备份的是人设名、描述与注入设置，连同头像一起。网盘上一个人设占一个文件夹（以人设名命名），
                    下载时只动你勾的那个人设，本机其他人设不受影响。<br>
                    预设与美化点进去按目录展开，可以勾到具体某个预设、某个主题。<br>
                    背景图只备份你自己上传的，酒馆自带的那批风景图不会传。<br>
                    世界书只列独立的那些；已内嵌在角色卡里的不会重复出现，跟着角色卡一起备份。<br>
                    <b>API 配置</b>逐个勾选连接配置档，网盘上一档一个文件（以配置名命名），
                    <b>会连它引用的 API 密钥明文与代理密码一起备份</b>；下载时只合并你勾的那一档，不动你的其他设置。
                </div>
            </div>

            <div class="stcb-scope-view" data-view="picker" hidden>
                <div class="stcb-scope-head">
                    <button type="button" class="menu_button" data-act="back">
                        <i class="fa-solid fa-chevron-left"></i><span>返回</span>
                    </button>
                    <b data-role="picker-title"></b>
                </div>
                <input type="search" class="text_pole stcb-scope-search" placeholder="搜索…">
                <div class="stcb-scope-head">
                    <button type="button" class="menu_button" data-act="all"><span>全选</span></button>
                    <button type="button" class="menu_button" data-act="none"><span>取消全选</span></button>
                    <button type="button" class="menu_button" data-act="current" hidden><span>仅当前角色</span></button>
                    <button type="button" class="menu_button stcb-scope-toggle" data-act="chats" hidden>
                        <i class="fa-solid fa-comments"></i><span>含聊天记录</span>
                    </button>
                </div>
                <div class="stcb-scope-list" data-role="list"></div>
                <div class="stcb-scope-count" data-role="count"></div>
            </div>
        </div>
    `;
}

/**
 * 打开范围弹窗。返回 true 表示用户点了确定，范围已写进内存配置，调用方负责落盘。
 * 点取消则原样还原，内存配置不留痕迹。
 */
export async function openScopePopup() {
    const scope = getConfig().scope;
    const original = JSON.parse(JSON.stringify(scope));
    // 聊天文件是聊着聊着就多出来的，缓存留到下次打开就是旧的了
    chatCache.clear();
    chatErrors.clear();

    const root = document.createElement('div');
    root.innerHTML = popupHtml();
    const view = name => root.querySelector(`.stcb-scope-view[data-view="${name}"]`);
    const pick = role => root.querySelector(`[data-role="${role}"]`);

    let activeKind = '';

    // ---- 一级 ----

    const renderRoot = () => {
        const enabled = scopeEnabled(scope);
        for (const btn of root.querySelectorAll('.stcb-scope-btn')) {
            const kind = btn.dataset.kind;
            btn.classList.toggle('is-selected', !!enabled[kind]);
            btn.innerHTML = `<span>${escHtml(buttonLabel(kind, scope))}</span>`;
        }
        pick('note').textContent = describeScope(scope);
    };

    const showRoot = () => {
        activeKind = '';
        view('picker').hidden = true;
        view('root').hidden = false;
        renderRoot();
    };

    root.querySelector('.stcb-scope-buttons').addEventListener('click', event => {
        const btn = event.target.closest('.stcb-scope-btn');
        if (!btn) return;
        openPicker(btn.dataset.kind);
    });

    // ---- 二级：公共外壳 ----

    const searchInput = root.querySelector('.stcb-scope-search');
    const keyword = () => searchInput.value.trim().toLowerCase();
    const act = name => root.querySelector(`[data-act="${name}"]`);

    const openPicker = (kind) => {
        activeKind = kind;
        const meta = PICKERS[kind];
        pick('picker-title').textContent = meta.title;
        // 「仅当前角色」与「含聊天记录」都只对角色卡有意义
        act('current').hidden = meta.view !== 'cards';
        act('chats').hidden = meta.view !== 'cards';
        searchInput.value = '';
        // 目录文件夹默认全展开：一共就两个目录，先折叠只会多一次点击。
        // 角色卡相反 —— 几十上百张，默认收起才看得清全貌（用户明确要的）
        if (meta.view === 'dirs') {
            for (const dir of getScopeDirs(meta.group)) {
                if (dir.detail) expanded.add(folderKey(meta.group, dir.key));
            }
        }
        view('root').hidden = true;
        view('picker').hidden = false;
        renderList();
        // 手机上别抢焦点 —— 一点进分类就弹出输入法，挡住半屏列表，
        // 而进来的人十有八九是想直接翻列表，不是想搜索。要搜的自己点搜索框。
        if (!isTouchScreen()) searchInput.focus();
    };

    const renderList = () => {
        const meta = PICKERS[activeKind];
        if (meta.view === 'dirs') renderFolders(meta);
        else if (meta.view === 'cards') renderCards(meta);
        else renderEntries(meta);
        renderChatsToggle();
    };

    /** 「含聊天记录」按钮的选中态：只要有聊天在范围内就加深。 */
    const renderChatsToggle = () => {
        act('chats').classList.toggle('is-on', !selectionEmpty(scope.chats));
    };

    // ---- 二级 A：角色卡文件夹（展开是它名下的聊天记录） ----

    /** 聊天在不在范围内：全选态看 skip，精确态看 selected。 */
    const chatChecked = (value) => {
        const chats = scope.chats;
        if (chats.all) return !(chats.skip || []).includes(value);
        return (chats.selected || []).includes(value);
    };

    const toggleChat = (value, checked) => {
        const chats = scope.chats;
        if (chats.all) {
            // 全选态下只记"排除了哪几条"，不必把全集列出来 —— 明细本就是按需加载的
            const skip = new Set(chats.skip || []);
            if (checked) skip.delete(value);
            else skip.add(value);
            chats.skip = [...skip];
            return;
        }
        const selected = new Set(chats.selected || []);
        if (checked) selected.add(value);
        else selected.delete(value);
        chats.selected = [...selected];
    };

    /** 拉某个角色的聊天明细。失败不阻断，展开处给一句话就够。 */
    const loadChats = async (stem) => {
        if (chatCache.has(stem) || chatLoading.has(stem)) return;
        chatLoading.add(stem);
        try {
            const data = await api('chats/list', { stem });
            chatErrors.delete(stem);
            chatCache.set(stem, Array.isArray(data.entries) ? data.entries : []);
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 读取聊天列表失败：', error);
            // 旧版后端没有 chats/list 这个路由，酒馆会回 404。
            // 把它和"这个角色真的没聊天"分开，否则用户根本无从下手
            chatErrors.set(stem, String(error?.message || error));
            chatCache.set(stem, []);
        } finally {
            chatLoading.delete(stem);
            if (activeKind === 'characters') renderList();
        }
    };

    const renderCards = (meta) => {
        const selection = scope.characters;
        const entries = characterEntries();
        const word = keyword();
        const visible = word
            ? entries.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(word))
            : entries;
        const current = currentAvatar();
        const chatsKnown = chatCountsSupplied();

        if (!entries.length) {
            pick('list').innerHTML = `<div class="stcb-scope-empty">${escHtml(meta.empty)}</div>`;
            pick('count').textContent = '';
            return;
        }
        if (!visible.length) {
            pick('list').innerHTML = '<div class="stcb-scope-empty">没有匹配的角色。</div>';
            pick('count').textContent = '';
            return;
        }

        pick('list').innerHTML = visible.map(item => {
            const stem = stemOf(item.value);
            const checked = selection.all || selection.selected.includes(item.value);
            const count = getChatCount(stem);
            const open = expanded.has(folderKey('characters', stem));

            const tag = item.value === current ? '<small class="stcb-scope-tag">当前</small>' : '';
            // 后端没送聊天条数时不能写"无聊天记录" —— 那是在替后端的毛病背锅
            const note = count.files
                ? `${count.files} 条聊天 · ${prettyBytes(count.bytes)}`
                : (chatsKnown ? '无聊天记录' : '后端未提供聊天数据');

            let rows = '';
            if (open) {
                const chats = chatCache.get(stem);
                if (!chats) {
                    rows = '<div class="stcb-scope-empty">正在读取聊天列表…</div>';
                    loadChats(stem);
                } else if (!chats.length) {
                    const failed = chatErrors.get(stem);
                    rows = failed
                        ? `<div class="stcb-scope-empty is-warn">读取聊天列表失败：${escHtml(failed)}<br>${escHtml(BACKEND_TOO_OLD)}</div>`
                        : '<div class="stcb-scope-empty">这个角色还没有聊天记录。</div>';
                } else {
                    rows = chats.map(chat => `<label class="stcb-scope-folder-item">`
                        + `<input type="checkbox" data-role="chat" value="${escHtml(chat.value)}"`
                        + `${chatChecked(chat.value) ? ' checked' : ''}>`
                        + `<span>${escHtml(chat.label)}</span>`
                        + `<small>${escHtml(prettyBytes(chat.bytes))}</small></label>`).join('');
                }
            }

            return `<div class="stcb-scope-folder${open ? ' is-open' : ''}" data-stem="${escHtml(stem)}">`
                + `<div class="stcb-scope-folder-head" data-act="fold">`
                + `<input type="checkbox" data-role="card" value="${escHtml(item.value)}"${checked ? ' checked' : ''}>`
                + `<i class="fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} stcb-scope-folder-caret"></i>`
                + `<span>${escHtml(item.label)}</span>${tag}`
                + `<small>${escHtml(note)}</small></div>`
                + (open ? `<div class="stcb-scope-folder-rows">${rows}</div>` : '')
                + `</div>`;
        }).join('');

        const parts = [`已选 ${selectionCount(selection, entries.length)} / ${entries.length} 张卡`];
        if (word) parts.push(`筛选出 ${visible.length} 个`);
        if (scope.chats.all) {
            const skipped = scope.chats.skip?.length || 0;
            parts.push(skipped ? `聊天记录 全部（排除 ${skipped} 条）` : '聊天记录 全部');
        } else if (scope.chats.selected?.length) {
            parts.push(`聊天记录 ${scope.chats.selected.length} 条`);
        }
        pick('count').textContent = parts.join('，');
    };

    /** 勾角色卡本身。全勾上记 all，这样以后新导入的卡会自动纳入。 */
    const toggleCard = (avatar, checked) => {
        const selection = scope.characters;
        const entries = characterEntries();
        const chosen = new Set(selection.all ? entries.map(item => item.value) : selection.selected);
        if (checked) chosen.add(avatar);
        else chosen.delete(avatar);
        applySelection(selection, entries, chosen);
    };

    // ---- 二级 B：平铺列表（世界书） ----

    const renderEntries = (meta) => {
        const selection = scope[activeKind];
        const entries = meta.entries();
        const word = keyword();
        const visible = word
            ? entries.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(word))
            : entries;

        if (!entries.length) {
            // 人设与 API 配置全靠后端送。后端没送来就直说，别谎报"你没有"
            const stale = (activeKind === 'personas' || activeKind === 'apiProfiles')
                && !synthListsSupplied();
            pick('list').innerHTML = stale
                ? `<div class="stcb-scope-empty is-warn">${escHtml(BACKEND_TOO_OLD)}</div>`
                : `<div class="stcb-scope-empty">${escHtml(meta.empty)}</div>`;
        } else if (!visible.length) {
            pick('list').innerHTML = '<div class="stcb-scope-empty">没有匹配的条目。</div>';
        } else {
            pick('list').innerHTML = visible.map(item => {
                const checked = selection.all || selection.selected.includes(item.value);
                // note 是"这本书没备份到"的警告
                const tag = item.note
                    ? `<small class="stcb-scope-tag${item.warn ? ' is-warn' : ''}">${escHtml(item.note)}</small>`
                    : '';
                return `<label class="stcb-scope-item">`
                    + `<input type="checkbox" value="${escHtml(item.value)}"${checked ? ' checked' : ''}>`
                    + `<span>${escHtml(item.label)}</span>${tag}</label>`;
            }).join('');
        }

        const chosen = selectionCount(selection, entries.length);
        const parts = [];
        if (entries.length) {
            parts.push(`已选 ${chosen} / ${entries.length}`);
            if (keyword()) parts.push(`筛选出 ${visible.length} 条`);
        }
        // 世界书列表里藏掉的那些要交代清楚，否则用户会以为插件漏了书
        if (activeKind === 'worlds') {
            const hidden = embeddedWorldCount();
            if (hidden) parts.push(`另有 ${hidden} 本已内嵌在角色卡里，随角色卡一起备份`);
        }
        pick('count').textContent = parts.join('，');
    };

    /** 勾选状态变了就重算选择集：全勾上记 all，这样以后新导入的条目会自动纳入。 */
    const commitFromCheckboxes = () => {
        const meta = PICKERS[activeKind];
        const selection = scope[activeKind];
        const entries = meta.entries();
        const all = new Set(selection.all ? entries.map(item => item.value) : selection.selected);

        for (const box of pick('list').querySelectorAll('input[type="checkbox"]')) {
            if (box.checked) all.add(box.value);
            else all.delete(box.value);
        }

        applySelection(selection, entries, all);
        renderList();
    };

    // ---- 二级 B：文件夹列表（预设、美化） ----

    const renderFolders = (meta) => {
        const group = meta.group;
        const dirs = getScopeDirs(group);
        const word = keyword();

        if (!dirs.length) {
            pick('list').innerHTML = `<div class="stcb-scope-empty">${escHtml(meta.empty)}</div>`;
            pick('count').textContent = '';
            return;
        }

        let visibleFiles = 0;
        const blocks = [];

        for (const dir of dirs) {
            const selection = dirSelection(scope, group, dir.key);
            const size = `${dir.files} 个${dir.files ? ` · ${prettyBytes(dir.bytes)}` : ''}`;

            // 背景图这类没有明细的：一整行就是个开关
            if (!dir.detail) {
                if (word && !dir.label.toLowerCase().includes(word)) continue;
                const note = dir.excluded ? `酒馆自带的 ${dir.excluded} 张已排除` : '只传你自己上传的图';
                blocks.push(`<div class="stcb-scope-folder is-flat">`
                    + `<label class="stcb-scope-folder-head">`
                    + checkboxHtml(dir, '', selection.all)
                    + `<span>${escHtml(dir.label)} · ${escHtml(size)}</span>`
                    + `<small class="stcb-scope-tag">${escHtml(note)}</small>`
                    + `</label></div>`);
                continue;
            }

            const entries = dir.entries || [];
            const matched = word
                ? entries.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(word))
                : entries;
            // 搜索时一条都没匹配上的目录整个收起来，免得满屏空分组
            if (word && !matched.length) continue;
            visibleFiles += matched.length;

            // 搜索时强制展开，否则搜到了却看不见
            const open = !!word || expanded.has(folderKey(group, dir.key));
            const rows = matched.length
                ? matched.map(item => {
                    const checked = selection.all || selection.selected.includes(item.value);
                    return `<label class="stcb-scope-folder-item">`
                        + checkboxHtml(dir, item.value, checked)
                        + `<span>${escHtml(item.label)}</span>`
                        + `<small>${escHtml(prettyBytes(item.bytes))}</small></label>`;
                }).join('')
                : '<div class="stcb-scope-empty">这个目录还没有文件。</div>';

            const chosen = selection.all ? entries.length : selection.selected.length;
            blocks.push(`<div class="stcb-scope-folder${open ? ' is-open' : ''}" data-dir="${escHtml(dir.key)}">`
                + `<div class="stcb-scope-folder-head" data-act="fold">`
                + checkboxHtml(dir, '', selection.all)
                + `<i class="fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} stcb-scope-folder-caret"></i>`
                + `<span>${escHtml(dir.label)} · ${escHtml(size)}</span>`
                + `<small>已选 ${chosen}</small></div>`
                + (open ? `<div class="stcb-scope-folder-rows">${rows}</div>` : '')
                + `</div>`);
        }

        pick('list').innerHTML = blocks.length
            ? blocks.join('')
            : '<div class="stcb-scope-empty">没有匹配的条目。</div>';

        const { chosen, total } = groupTally(group, scope);
        const parts = [];
        if (total) parts.push(`已选 ${chosen} / ${total}`);
        if (word) parts.push(`筛选出 ${visibleFiles} 个文件`);
        pick('count').textContent = parts.join('，');
    };

    /** file 为空串表示这是目录那一行的整组开关。 */
    const checkboxHtml = (dir, file, checked) => {
        const role = file ? 'file' : 'dir';
        return `<input type="checkbox" data-role="${role}" data-dir="${escHtml(dir.key)}"`
            + ` data-detail="${dir.detail ? 'true' : 'false'}"`
            + ` value="${escHtml(file)}"${checked ? ' checked' : ''}>`;
    };

    /** 整目录开关：勾上就是"这个目录全都要"，以后新存的预设也自动纳入。 */
    const toggleDir = (group, key, checked) => {
        const selection = ensureDirSelection(scope, group, key);
        selection.all = checked;
        selection.selected = [];
    };

    const toggleFile = (group, key, file, checked) => {
        const selection = ensureDirSelection(scope, group, key);
        const entries = getScopeDirs(group).find(dir => dir.key === key)?.entries || [];
        const chosen = new Set(selection.all ? entries.map(item => item.value) : selection.selected);
        if (checked) chosen.add(file);
        else chosen.delete(file);
        applySelection(selection, entries, chosen);
    };

    // ---- 二级：事件 ----

    pick('list').addEventListener('change', event => {
        const box = event.target;
        if (!box.matches('input[type="checkbox"]')) return;
        const meta = PICKERS[activeKind];

        if (meta.view === 'cards') {
            if (box.dataset.role === 'card') toggleCard(box.value, box.checked);
            else toggleChat(box.value, box.checked);
            renderList();
            return;
        }
        if (meta.view === 'dirs') {
            if (box.dataset.role === 'dir') toggleDir(meta.group, box.dataset.dir, box.checked);
            else toggleFile(meta.group, box.dataset.dir, box.value, box.checked);
            renderList();
            return;
        }
        commitFromCheckboxes();
    });

    // details 那套点标题就折叠的默认行为在这里不合用 —— 勾选框就摆在标题上，
    // 点它是"整个目录全要"或"要这张卡"，顺带把文件夹收起来只会让人以为勾错了。折叠自己管。
    pick('list').addEventListener('click', event => {
        if (event.target.matches('input[type="checkbox"]')) return;
        const head = event.target.closest('.stcb-scope-folder-head[data-act="fold"]');
        const meta = PICKERS[activeKind];
        if (!head) return;

        const folder = head.closest('.stcb-scope-folder');
        let key = '';
        if (meta.view === 'cards') {
            key = folderKey('characters', folder.dataset.stem);
        } else if (meta.view === 'dirs') {
            // 搜索时一律展开，这会儿折叠只会让人以为没搜到
            if (keyword()) return;
            key = folderKey(meta.group, folder.dataset.dir);
        } else {
            return;
        }

        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        renderList();
    });

    searchInput.addEventListener('input', renderList);

    view('picker').addEventListener('click', event => {
        const btn = event.target.closest('button[data-act]');
        if (!btn) return;

        switch (btn.dataset.act) {
            case 'back':
                showRoot();
                return;
            case 'all':
                // 搜索状态下只全选筛选结果，符合"先搜再批量勾"的直觉
                setVisible(true);
                return;
            case 'none':
                setVisible(false);
                return;
            case 'current': {
                const avatar = currentAvatar();
                if (!avatar) return;
                scope.characters.all = false;
                scope.characters.selected = [avatar];
                renderList();
                return;
            }
            case 'chats': {
                // 一键把所选角色的聊天全带上 / 全撤下。
                // 已经带上时（哪怕只是零星几条）再点就是清空，符合"这个开关管带不带聊天"的直觉
                const on = !selectionEmpty(scope.chats);
                scope.chats.all = !on;
                scope.chats.selected = [];
                scope.chats.skip = [];
                renderList();
                return;
            }
        }
    });

    const setVisible = (checked) => {
        const meta = PICKERS[activeKind];
        const boxes = [...pick('list').querySelectorAll('input[type="checkbox"]')];

        if (meta.view === 'list') {
            for (const box of boxes) box.checked = checked;
            commitFromCheckboxes();
            return;
        }

        if (meta.view === 'cards') {
            // 只作用于角色卡本身。聊天由「含聊天记录」统一管 ——
            // 大部分卡还没展开，它们的聊天明细压根不在 DOM 里，这里一把梭只会漏掉一半
            for (const box of boxes) {
                if (box.dataset.role === 'card') toggleCard(box.value, checked);
            }
            renderList();
            return;
        }

        const searching = !!keyword();
        for (const box of boxes) {
            if (box.dataset.role === 'dir') {
                // 搜索时有明细的目录交给下面的文件框逐个处理，
                // 整目录一把梭会把没筛出来的文件也勾上
                if (searching && box.dataset.detail === 'true') continue;
                toggleDir(meta.group, box.dataset.dir, checked);
            } else {
                toggleFile(meta.group, box.dataset.dir, box.value, checked);
            }
        }
        renderList();
    };

    showRoot();

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: '确定',
        cancelButton: '取消',
        allowVerticalScrolling: true,
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        Object.assign(scope, original);
        return false;
    }
    return true;
}

/** 勾满了就记 all，这样以后新增的条目会自动纳入；否则老实记下具体选了哪些。 */
function applySelection(selection, entries, chosen) {
    const kept = entries.filter(item => chosen.has(item.value)).map(item => item.value);
    if (entries.length > 0 && kept.length === entries.length) {
        selection.all = true;
        selection.selected = [];
    } else {
        selection.all = false;
        selection.selected = kept;
    }
}

function buttonLabel(kind, scope) {
    switch (kind) {
        case 'characters': {
            const total = characterEntries().length;
            if (!total) return '角色卡（无）';
            const count = scope.characters.all ? total : scope.characters.selected.length;
            // 聊天记录长在这个菜单里，选中态也要在按钮上交代一句
            const chats = selectionEmpty(scope.chats) ? '' : ' + 聊天';
            if (!count) return '角色卡';
            return scope.characters.all
                ? `角色卡（全部 ${total}${chats}）`
                : `角色卡（${count}${chats}）`;
        }
        case 'worlds': {
            const total = worldEntries().length;
            // 全被角色卡内嵌时一本独立的都不剩，这时候说"全部 0"不如直说
            if (!total) return '世界书（无独立世界书）';
            if (scope.worlds.all) return `世界书（全部 ${total}）`;
            const count = scope.worlds.selected.length;
            return count ? `世界书（${count}）` : '世界书';
        }
        case 'presets':
        case 'themes': {
            const label = kind === 'presets' ? '预设' : '美化';
            const { chosen, total } = groupTally(kind, scope);
            if (!total) return `${label}（无）`;
            if (chosen === total) return `${label}（全部 ${total}）`;
            return chosen ? `${label}（${chosen}）` : label;
        }
        case 'personas':
        case 'apiProfiles': {
            const label = kind === 'personas' ? '用户人设' : 'API 配置';
            const total = getSynthList(kind).length;
            if (!total) return `${label}（无）`;
            if (scope[kind]?.all) return `${label}（全部 ${total}）`;
            const count = scope[kind]?.selected?.length || 0;
            return count ? `${label}（${count}）` : label;
        }
        default:
            return kind;
    }
}
