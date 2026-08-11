/**
 * 备份范围弹窗。
 *
 *   一级：角色卡 / 聊天记录 / 世界书 / 设置 四个按钮，已选的外边框加粗，下方有备注文字。
 *   二级：角色卡与世界书点进来多选，带搜索、全选、取消全选；角色卡另有"仅当前角色"。
 *         聊天记录与设置没有二级 —— 聊天跟随所选角色卡，设置只有 settings.json 一个文件。
 */
import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';

import { characterEntries, worldEntries, currentAvatar, linkedWorlds } from './tavern.js';
import { getConfig, describeScope, scopeEnabled, selectionCount } from './settings.js';
import { escHtml } from './panel.js';

/** 因为已内嵌在角色卡里而没有列出来的世界书数量。 */
function embeddedWorldCount() {
    const linked = linkedWorlds();
    let count = 0;
    for (const meta of linked.values()) {
        if (meta.embedded) count++;
    }
    return count;
}

const PICKERS = {
    characters: { title: '选择角色卡', empty: '酒馆里还没有角色卡。', entries: characterEntries, withCurrent: true },
    worlds: { title: '选择世界书', empty: '没有需要单独备份的世界书。', entries: worldEntries, withCurrent: false },
};

function popupHtml() {
    return `
        <div class="wdcb-scope-popup">
            <div class="wdcb-scope-view" data-view="root">
                <div class="wdcb-scope-buttons">
                    <button type="button" class="menu_button wdcb-scope-btn" data-kind="characters"></button>
                    <button type="button" class="menu_button wdcb-scope-btn" data-kind="chats"></button>
                    <button type="button" class="menu_button wdcb-scope-btn" data-kind="worlds"></button>
                    <button type="button" class="menu_button wdcb-scope-btn" data-kind="settings"></button>
                </div>
                <div class="wdcb-scope-note">当前已选择同步范围：<b data-role="note"></b></div>
                <div class="wdcb-scope-hint">
                    聊天记录跟随上面所选的角色卡，无需单独选择；群聊与群组会整体带上。<br>
                    世界书只列独立的那些；已内嵌在角色卡里的不会重复出现，跟着角色卡一起备份。<br>
                    设置指 settings.json，从云端下载会覆盖本机 API 配置，按需勾选。
                </div>
            </div>

            <div class="wdcb-scope-view" data-view="picker" hidden>
                <div class="wdcb-scope-head">
                    <button type="button" class="menu_button" data-act="back">
                        <i class="fa-solid fa-chevron-left"></i><span>返回</span>
                    </button>
                    <b data-role="picker-title"></b>
                </div>
                <input type="search" class="text_pole wdcb-scope-search" placeholder="搜索…">
                <div class="wdcb-scope-head">
                    <button type="button" class="menu_button" data-act="all"><span>全选</span></button>
                    <button type="button" class="menu_button" data-act="none"><span>取消全选</span></button>
                    <button type="button" class="menu_button" data-act="current" hidden><span>仅当前角色</span></button>
                </div>
                <div class="wdcb-scope-list" data-role="list"></div>
                <div class="wdcb-scope-count" data-role="count"></div>
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
    const view = name => root.querySelector(`.wdcb-scope-view[data-view="${name}"]`);
    const pick = role => root.querySelector(`[data-role="${role}"]`);

    let activeKind = '';

    // ---- 一级 ----

    const renderRoot = () => {
        const enabled = scopeEnabled(scope);
        for (const btn of root.querySelectorAll('.wdcb-scope-btn')) {
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

    root.querySelector('.wdcb-scope-buttons').addEventListener('click', event => {
        const btn = event.target.closest('.wdcb-scope-btn');
        if (!btn) return;
        const kind = btn.dataset.kind;
        if (kind === 'chats' || kind === 'settings') {
            scope[kind].enabled = !scope[kind].enabled;
            renderRoot();
            return;
        }
        openPicker(kind);
    });

    // ---- 二级 ----

    const searchInput = root.querySelector('.wdcb-scope-search');

    const openPicker = (kind) => {
        activeKind = kind;
        const meta = PICKERS[kind];
        pick('picker-title').textContent = meta.title;
        root.querySelector('[data-act="current"]').hidden = !meta.withCurrent;
        searchInput.value = '';
        view('root').hidden = true;
        view('picker').hidden = false;
        renderList();
        searchInput.focus();
    };

    const renderList = () => {
        const meta = PICKERS[activeKind];
        const selection = scope[activeKind];
        const entries = meta.entries();
        const keyword = searchInput.value.trim().toLowerCase();
        const visible = keyword
            ? entries.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(keyword))
            : entries;
        const current = meta.withCurrent ? currentAvatar() : '';

        if (!entries.length) {
            pick('list').innerHTML = `<div class="wdcb-scope-empty">${escHtml(meta.empty)}</div>`;
        } else if (!visible.length) {
            pick('list').innerHTML = '<div class="wdcb-scope-empty">没有匹配的条目。</div>';
        } else {
            pick('list').innerHTML = visible.map(item => {
                const checked = selection.all || selection.selected.includes(item.value);
                const tag = item.note
                    ? `<small class="wdcb-scope-tag is-warn">${escHtml(item.note)}</small>`
                    : (item.value === current ? '<small class="wdcb-scope-tag">当前</small>' : '');
                return `<label class="wdcb-scope-item">`
                    + `<input type="checkbox" value="${escHtml(item.value)}"${checked ? ' checked' : ''}>`
                    + `<span>${escHtml(item.label)}</span>${tag}</label>`;
            }).join('');
        }

        const chosen = selectionCount(selection, entries.length);
        const parts = [];
        if (entries.length) {
            parts.push(`已选 ${chosen} / ${entries.length}`);
            if (keyword) parts.push(`筛选出 ${visible.length} 条`);
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

        const chosen = entries.filter(item => all.has(item.value)).map(item => item.value);
        if (entries.length > 0 && chosen.length === entries.length) {
            selection.all = true;
            selection.selected = [];
        } else {
            selection.all = false;
            selection.selected = chosen;
        }
        renderList();
    };

    pick('list').addEventListener('change', event => {
        if (event.target.matches('input[type="checkbox"]')) commitFromCheckboxes();
    });

    searchInput.addEventListener('input', renderList);

    view('picker').addEventListener('click', event => {
        const btn = event.target.closest('button[data-act]');
        if (!btn) return;
        const selection = scope[activeKind];

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
                selection.all = false;
                selection.selected = [avatar];
                renderList();
                return;
            }
        }
    });

    const setVisible = (checked) => {
        for (const box of pick('list').querySelectorAll('input[type="checkbox"]')) {
            box.checked = checked;
        }
        commitFromCheckboxes();
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
        case 'settings':
            return '设置';
        default:
            return kind;
    }
}
