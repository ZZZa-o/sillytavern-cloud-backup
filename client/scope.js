/**
 * 备份范围弹窗：角色卡、用户人设、预设、美化、世界书和 API 配置。
 * 角色卡展开后按需加载聊天明细；预设与美化按目录选择，背景图使用整类开关。
 */
import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';

import { api } from './api.js';
import { characterEntries, worldEntries, currentAvatar, embeddedWorldNames } from './tavern.js';
import {
    getConfig, scopeEnabled, selectionCount, selectionEmpty,
    getScopeDirs, dirSelection, ensureDirSelection, getChatCount, getSynthList,
} from './settings.js';
import { escHtml, prettyBytes } from './panel.js';

/** 统计已内嵌在角色卡中而隐藏的世界书。 */
function embeddedWorldCount() {
    return embeddedWorldNames().length;
}

/** 角色卡文件名去扩展名 —— 它就是这个角色的聊天目录名。 */
function stemOf(avatar) {
    return String(avatar || '').replace(/\.[^.]+$/, '');
}

/** 通过指针精度识别触屏设备。 */
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
            // 标注 API 配置是否包含密钥明文。
            note: item.hasSecret ? '含密钥明文' : '无密钥',
            warn: item.hasSecret,
        })),
    },
};

// 按「组:标识」保存目录和角色卡的展开状态。
const expanded = new Set();
const folderKey = (group, key) => `${group}:${key}`;

// 按需加载并缓存角色聊天明细。
const chatCache = new Map();
const chatLoading = new Set();
// 按角色目录名记录聊天明细的加载错误。
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
 * 打开范围弹窗；确认后更新内存配置并返回 true，由调用方落盘。
 * 取消时还原本次修改。
 */
export async function openScopePopup() {
    const scope = getConfig().scope;
    const original = JSON.parse(JSON.stringify(scope));
    // 每次打开弹窗时清空聊天明细缓存。
    chatCache.clear();
    chatErrors.clear();

    const root = document.createElement('div');
    root.innerHTML = popupHtml();
    const view = name => root.querySelector(`.stcb-scope-view[data-view="${name}"]`);
    const pick = role => root.querySelector(`[data-role="${role}"]`);

    let activeKind = '';

    // 一级

    const renderRoot = () => {
        const enabled = scopeEnabled(scope);
        for (const btn of root.querySelectorAll('.stcb-scope-btn')) {
            const kind = btn.dataset.kind;
            btn.classList.toggle('is-selected', !!enabled[kind]);
            btn.innerHTML = `<span>${escHtml(buttonLabel(kind, scope))}</span>`;
        }
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

    // 二级：公共外壳

    const searchInput = root.querySelector('.stcb-scope-search');
    const keyword = () => searchInput.value.trim().toLowerCase();
    const act = name => root.querySelector(`[data-act="${name}"]`);

    const openPicker = (kind) => {
        activeKind = kind;
        const meta = PICKERS[kind];
        pick('picker-title').textContent = meta.title;
        // 角色卡视图显示「仅当前角色」和「含聊天记录」。
        act('current').hidden = meta.view !== 'cards';
        act('chats').hidden = meta.view !== 'cards';
        searchInput.value = '';
        // 目录视图默认展开，角色卡视图默认收起。
        if (meta.view === 'dirs') {
            for (const dir of getScopeDirs(meta.group)) {
                if (dir.detail) expanded.add(folderKey(meta.group, dir.key));
            }
        }
        view('root').hidden = true;
        view('picker').hidden = false;
        renderList();
        // 触屏设备跳过搜索框自动聚焦。
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

    // 二级 A：角色卡文件夹（展开是它名下的聊天记录）

    /** 聊天在不在范围内：全选态看 skip，精确态看 selected。 */
    const chatChecked = (value) => {
        const chats = scope.chats;
        if (chats.all) return !(chats.skip || []).includes(value);
        return (chats.selected || []).includes(value);
    };

    const toggleChat = (value, checked) => {
        const chats = scope.chats;
        if (chats.all) {
            // 全选模式通过 skip 保存排除的聊天。
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

    /** 加载角色的聊天明细，失败时在展开区域显示错误。 */
    const loadChats = async (stem) => {
        if (chatCache.has(stem) || chatLoading.has(stem)) return;
        chatLoading.add(stem);
        try {
            const data = await api('chats/list', { stem });
            chatErrors.delete(stem);
            chatCache.set(stem, Array.isArray(data.entries) ? data.entries : []);
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 读取聊天列表失败：', error);
            // 后端缺少 chats/list 接口时显示更新提示。
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
            // 后端未提供聊天统计时显示数据缺失提示。
            const note = count.files
                ? `${count.files} 条聊天 · ${prettyBytes(count.bytes)}`
                : '无聊天记录';

            let rows = '';
            if (open) {
                const chats = chatCache.get(stem);
                if (!chats) {
                    rows = '<div class="stcb-scope-empty">正在读取聊天列表…</div>';
                    loadChats(stem);
                } else if (!chats.length) {
                    const failed = chatErrors.get(stem);
                    rows = failed
                        ? `<div class="stcb-scope-empty is-warn">读取聊天列表失败：${escHtml(failed)}</div>`
                        : '';
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
                + (open && rows ? `<div class="stcb-scope-folder-rows">${rows}</div>` : '')
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

    /** 勾选角色卡；全部选中时保存为 all。 */
    const toggleCard = (avatar, checked) => {
        const selection = scope.characters;
        const entries = characterEntries();
        const chosen = new Set(selection.all ? entries.map(item => item.value) : selection.selected);
        if (checked) chosen.add(avatar);
        else chosen.delete(avatar);
        applySelection(selection, entries, chosen);
    };

    // 二级 B：平铺列表（世界书）

    const renderEntries = (meta) => {
        const selection = scope[activeKind];
        const entries = meta.entries();
        const word = keyword();
        const visible = word
            ? entries.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(word))
            : entries;

        if (!entries.length) {
            pick('list').innerHTML = `<div class="stcb-scope-empty">${escHtml(meta.empty)}</div>`;
        } else if (!visible.length) {
            pick('list').innerHTML = '<div class="stcb-scope-empty">没有匹配的条目。</div>';
        } else {
            pick('list').innerHTML = visible.map(item => {
                const checked = selection.all || selection.selected.includes(item.value);
                // 显示世界书的备份提示。
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
        // 显示已隐藏的内嵌世界书数量。
        if (activeKind === 'worlds') {
            const hidden = embeddedWorldCount();
            if (hidden) parts.push(`已内嵌 ${hidden} 本，随角色卡备份`);
        }
        pick('count').textContent = parts.join('，');
    };

    /** 重新计算选择集，全部选中时保存为 all。 */
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

    // 二级 B：文件夹列表（预设、美化）

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
            // 隐藏无搜索结果的目录。
            if (word && !matched.length) continue;
            visibleFiles += matched.length;

            // 搜索时展开匹配目录。
            const open = !!word || expanded.has(folderKey(group, dir.key));
            const rows = matched.length
                ? matched.map(item => {
                    const checked = selection.all || selection.selected.includes(item.value);
                    return `<label class="stcb-scope-folder-item">`
                        + checkboxHtml(dir, item.value, checked)
                        + `<span>${escHtml(item.label)}</span>`
                        + `<small>${escHtml(prettyBytes(item.bytes))}</small></label>`;
                }).join('')
                : '';

            const chosen = selection.all ? entries.length : selection.selected.length;
            blocks.push(`<div class="stcb-scope-folder${open ? ' is-open' : ''}" data-dir="${escHtml(dir.key)}">`
                + `<div class="stcb-scope-folder-head" data-act="fold">`
                + checkboxHtml(dir, '', selection.all)
                + `<i class="fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'} stcb-scope-folder-caret"></i>`
                + `<span>${escHtml(dir.label)} · ${escHtml(size)}</span>`
                + `<small>已选 ${chosen}</small></div>`
                + (open && rows ? `<div class="stcb-scope-folder-rows">${rows}</div>` : '')
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

    /** 整目录选择保存为 all，包含后续新增文件。 */
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

    // 二级：事件

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

    // 阻止 summary 默认点击行为，分别处理勾选和折叠。
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
            // 搜索期间保持目录展开。
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
                // 搜索时仅选择匹配项。
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
                // 切换所选角色的全部聊天：已有聊天选择时清空，否则全选。
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
            // 全选与取消全选仅作用于角色卡。
            for (const box of boxes) {
                if (box.dataset.role === 'card') toggleCard(box.value, checked);
            }
            renderList();
            return;
        }

        const searching = !!keyword();
        for (const box of boxes) {
            if (box.dataset.role === 'dir') {
                // 搜索时按匹配的文件更新选择集。
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
        // 二级视图确认或取消时返回分类页；返回 false 保持弹窗打开。
        onClosing: () => {
            if (!activeKind) return true;
            showRoot();
            return false;
        },
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        Object.assign(scope, original);
        return false;
    }
    return true;
}

/** 全部选中时保存 all，其余情况保存 selected。 */
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
    // 类别为空时仅显示类别名。
    switch (kind) {
        case 'characters': {
            const total = characterEntries().length;
            if (!total) return '角色卡';
            const count = scope.characters.all ? total : scope.characters.selected.length;
            // 在角色卡按钮上显示聊天选择状态。
            const chats = selectionEmpty(scope.chats) ? '' : ' + 聊天';
            if (!count) return '角色卡';
            // 用数量标注选中项。
            return `角色卡（${count}${chats}）`;
        }
        case 'worlds': {
            const total = worldEntries().length;
            if (!total) return '世界书';
            const count = scope.worlds.all ? total : scope.worlds.selected.length;
            return count ? `世界书（${count}）` : '世界书';
        }
        case 'presets':
        case 'themes': {
            const label = kind === 'presets' ? '预设' : '美化';
            const { chosen, total } = groupTally(kind, scope);
            if (!total) return label;
            return chosen ? `${label}（${chosen}）` : label;
        }
        case 'personas':
        case 'apiProfiles': {
            const label = kind === 'personas' ? '用户人设' : 'API 配置';
            const total = getSynthList(kind).length;
            if (!total) return label;
            const count = scope[kind]?.all ? total : (scope[kind]?.selected?.length || 0);
            return count ? `${label}（${count}）` : label;
        }
        default:
            return kind;
    }
}
