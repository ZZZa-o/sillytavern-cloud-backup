/**
 * 备份范围弹窗。
 *
 *   一级：角色卡 / 聊天记录 / 世界书 / 预设 / 美化 / 设置 六个按钮，已选的外边框加粗。
 *   二级：两种形态 ——
 *         角色卡与世界书是平铺多选列表，带搜索、全选、取消全选；角色卡另有"仅当前角色"。
 *         预设与美化是文件夹列表：按目录折叠，展开逐个勾具体的预设与主题；
 *         背景图没有明细（都是图片，列出来没意义），只有一个整类开关。
 *         聊天记录与设置没有二级 —— 聊天跟随所选角色卡，设置只有 settings.json 一个文件。
 */
import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';

import { characterEntries, worldEntries, currentAvatar, embeddedWorldNames } from './tavern.js';
import {
    getConfig, describeScope, scopeEnabled, selectionCount, selectionEmpty,
    getScopeDirs, dirSelection, ensureDirSelection,
} from './settings.js';
import { escHtml, prettyBytes } from './panel.js';

/** 因为已内嵌在角色卡里而没有列出来的世界书数量。 */
function embeddedWorldCount() {
    return embeddedWorldNames().length;
}

// group 存在就走文件夹视图，否则走平铺列表
const PICKERS = {
    characters: { title: '选择角色卡', empty: '酒馆里还没有角色卡。', entries: characterEntries, withCurrent: true },
    worlds: { title: '选择世界书', empty: '没有需要单独备份的世界书。', entries: worldEntries, withCurrent: false },
    presets: { title: '选择预设', empty: '没有可备份的预设。', group: 'presets' },
    themes: { title: '选择美化', empty: '没有可备份的美化文件。', group: 'themes' },
};

// 目录的展开状态。键是 `组:目录键`，弹窗关掉也留着，下次点进来还是老样子
const expanded = new Set();
const folderKey = (group, key) => `${group}:${key}`;

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
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="chats"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="worlds"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="presets"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="themes"></button>
                    <button type="button" class="menu_button stcb-scope-btn" data-kind="settings"></button>
                </div>
                <div class="stcb-scope-note">当前已选择同步范围：<b data-role="note"></b></div>
                <div class="stcb-scope-hint">
                    聊天记录跟随上面所选的角色卡，无需单独选择；群聊与群组会整体带上。<br>
                    世界书只列独立的那些；已内嵌在角色卡里的不会重复出现，跟着角色卡一起备份。<br>
                    预设与美化点进去按目录展开，可以勾到具体某个预设、某个主题。<br>
                    背景图只备份你自己上传的，酒馆自带的那批风景图不会传。<br>
                    设置指 settings.json，从云端下载会覆盖本机 API 配置，按需勾选。
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
        const kind = btn.dataset.kind;
        if (kind === 'chats' || kind === 'settings') {
            scope[kind].enabled = !scope[kind].enabled;
            renderRoot();
            return;
        }
        openPicker(kind);
    });

    // ---- 二级：公共外壳 ----

    const searchInput = root.querySelector('.stcb-scope-search');
    const keyword = () => searchInput.value.trim().toLowerCase();

    const openPicker = (kind) => {
        activeKind = kind;
        const meta = PICKERS[kind];
        pick('picker-title').textContent = meta.title;
        root.querySelector('[data-act="current"]').hidden = !meta.withCurrent;
        searchInput.value = '';
        // 文件夹视图默认全展开：一共就两个目录，先折叠只会多一次点击
        if (meta.group) {
            for (const dir of getScopeDirs(meta.group)) {
                if (dir.detail) expanded.add(folderKey(meta.group, dir.key));
            }
        }
        view('root').hidden = true;
        view('picker').hidden = false;
        renderList();
        searchInput.focus();
    };

    const renderList = () => {
        const meta = PICKERS[activeKind];
        if (meta.group) renderFolders(meta);
        else renderEntries(meta);
    };

    // ---- 二级 A：平铺列表（角色卡、世界书） ----

    const renderEntries = (meta) => {
        const selection = scope[activeKind];
        const entries = meta.entries();
        const word = keyword();
        const visible = word
            ? entries.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(word))
            : entries;
        const current = meta.withCurrent ? currentAvatar() : '';

        if (!entries.length) {
            pick('list').innerHTML = `<div class="stcb-scope-empty">${escHtml(meta.empty)}</div>`;
        } else if (!visible.length) {
            pick('list').innerHTML = '<div class="stcb-scope-empty">没有匹配的条目。</div>';
        } else {
            pick('list').innerHTML = visible.map(item => {
                const checked = selection.all || selection.selected.includes(item.value);
                // 世界书的 note 是"这本书没备份到"的警告，别把"当前角色"标签也标红
                const tag = item.note
                    ? `<small class="stcb-scope-tag${item.warn ? ' is-warn' : ''}">${escHtml(item.note)}</small>`
                    : (item.value === current ? '<small class="stcb-scope-tag">当前</small>' : '');
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
        if (!meta.group) {
            commitFromCheckboxes();
            return;
        }
        if (box.dataset.role === 'dir') toggleDir(meta.group, box.dataset.dir, box.checked);
        else toggleFile(meta.group, box.dataset.dir, box.value, box.checked);
        renderList();
    });

    // details 那套点标题就折叠的默认行为在这里不合用 —— 整组开关就摆在标题上，
    // 点它是"整个目录全要"，顺带把目录收起来只会让人以为勾错了。折叠自己管。
    pick('list').addEventListener('click', event => {
        if (event.target.matches('input[type="checkbox"]')) return;
        const head = event.target.closest('.stcb-scope-folder-head[data-act="fold"]');
        const meta = PICKERS[activeKind];
        if (!head || !meta?.group) return;
        // 搜索时一律展开，这会儿折叠只会让人以为没搜到
        if (keyword()) return;
        const key = folderKey(meta.group, head.closest('.stcb-scope-folder').dataset.dir);
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
                const selection = scope[activeKind];
                selection.all = false;
                selection.selected = [avatar];
                renderList();
                return;
            }
        }
    });

    const setVisible = (checked) => {
        const meta = PICKERS[activeKind];
        const boxes = [...pick('list').querySelectorAll('input[type="checkbox"]')];

        if (!meta.group) {
            for (const box of boxes) box.checked = checked;
            commitFromCheckboxes();
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
            if (scope.characters.all) return `角色卡（全部 ${total}）`;
            const count = scope.characters.selected.length;
            return count ? `角色卡（${count}）` : '角色卡';
        }
        case 'worlds': {
            const total = worldEntries().length;
            // 全被角色卡内嵌时一本独立的都不剩，这时候说"全部 0"不如直说
            if (!total) return '世界书（无独立世界书）';
            if (scope.worlds.all) return `世界书（全部 ${total}）`;
            const count = scope.worlds.selected.length;
            return count ? `世界书（${count}）` : '世界书';
        }
        case 'chats':
            return '聊天记录';
        case 'presets':
        case 'themes': {
            const label = kind === 'presets' ? '预设' : '美化';
            const { chosen, total } = groupTally(kind, scope);
            if (!total) return `${label}（无）`;
            if (chosen === total) return `${label}（全部 ${total}）`;
            return chosen ? `${label}（${chosen}）` : label;
        }
        case 'settings':
            return '设置';
        default:
            return kind;
    }
}
