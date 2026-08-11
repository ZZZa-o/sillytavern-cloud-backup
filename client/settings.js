/**
 * 前端持有的配置副本。真身在后端的 config.json —— 密码只进不出，
 * 这里永远拿不到明文，只知道 hasPassword。
 */
import { api } from './api.js';
import { characterEntries, worldEntries } from './tavern.js';

export const DEFAULT_CONFIG = {
    url: '',
    username: '',
    remotePath: 'SillyTavern-WebDAV-Backup',
    scope: {
        characters: { all: true, selected: [] },
        chats: { enabled: true },
        worlds: { all: true, selected: [] },
        settings: { enabled: false },
    },
    auto: { enabled: false, onChatEvents: true, intervalHours: 6 },
    hasPassword: false,
    lastBackupAt: '',
};

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

let current = clone(DEFAULT_CONFIG);

export function getConfig() {
    return current;
}

/** 用后端返回的配置覆盖本地副本，缺字段的用默认值补齐。 */
export function applyConfig(incoming = {}) {
    const base = clone(DEFAULT_CONFIG);
    const scope = incoming.scope || {};
    const auto = incoming.auto || {};
    current = {
        url: incoming.url ?? base.url,
        username: incoming.username ?? base.username,
        remotePath: incoming.remotePath || base.remotePath,
        scope: {
            characters: readSelection(scope.characters, base.scope.characters),
            chats: { enabled: scope.chats?.enabled !== false },
            worlds: readSelection(scope.worlds, base.scope.worlds),
            settings: { enabled: scope.settings?.enabled === true },
        },
        auto: {
            enabled: auto.enabled === true,
            onChatEvents: auto.onChatEvents !== false,
            intervalHours: Number(auto.intervalHours) > 0 ? Number(auto.intervalHours) : base.auto.intervalHours,
        },
        hasPassword: incoming.hasPassword === true,
        lastBackupAt: incoming.lastBackupAt || '',
    };
    return current;
}

function readSelection(raw, fallback) {
    if (!raw || typeof raw !== 'object') return clone(fallback);
    return {
        all: raw.all === true,
        selected: Array.isArray(raw.selected) ? raw.selected.map(String) : [],
    };
}

export async function loadConfig() {
    const data = await api('config/load');
    return applyConfig(data.config || {});
}

/**
 * 把内存副本提交到后端。password 只在用户真的输了新密码时才带上，
 * 留空表示"不修改"，后端会保留原密码。
 */
export async function pushConfig(password = '') {
    const payload = { ...current };
    delete payload.hasPassword;
    delete payload.lastBackupAt;
    if (password) payload.password = password;
    const data = await api('config/save', { config: payload });
    applyConfig(data.config || {});
    return data;
}

// ---------------------------------------------------------------------------
// 范围：一处判定，面板文案与弹窗按钮的选中态都用它
// ---------------------------------------------------------------------------

export function selectionEmpty(selection) {
    return !selection?.all && !(selection?.selected?.length > 0);
}

export function selectionCount(selection, total) {
    if (selection?.all) return total;
    return selection?.selected?.length || 0;
}

/**
 * 四类各自是否算"已选择"，决定按钮要不要加粗。
 * 数量为 0 时一律算没选 —— 比如世界书全被角色卡内嵌了，独立世界书一本都没有，
 * 这时候还把按钮点亮就是在骗人。
 */
export function scopeEnabled(scope = getConfig().scope) {
    return {
        characters: !selectionEmpty(scope.characters) && characterEntries().length > 0,
        chats: scope.chats?.enabled === true,
        worlds: !selectionEmpty(scope.worlds) && worldEntries().length > 0,
        settings: scope.settings?.enabled === true,
    };
}

/** "当前已选择同步范围：xxx" 里的那段 xxx。 */
export function describeScope(scope = getConfig().scope) {
    const parts = [];

    const charTotal = characterEntries().length;
    if (scope.characters?.all && charTotal) parts.push(`角色卡 全部 ${charTotal} 张`);
    else if (scope.characters?.selected?.length) parts.push(`角色卡 ${scope.characters.selected.length} 张`);

    if (scope.chats?.enabled) parts.push('聊天记录');

    // 独立世界书为 0 时干脆不提，说"世界书 全部"只会让人以为传了什么
    const worldTotal = worldEntries().length;
    if (worldTotal) {
        if (scope.worlds?.all) parts.push(`世界书 全部 ${worldTotal} 本`);
        else if (scope.worlds?.selected?.length) parts.push(`世界书 ${scope.worlds.selected.length} 本`);
    }

    if (scope.settings?.enabled) parts.push('设置');

    return parts.length ? parts.join('、') : '未选择任何内容';
}
