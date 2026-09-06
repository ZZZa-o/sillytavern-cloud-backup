/**
 * 维护后端配置的前端副本。
 * profiles 保存各方案连接信息；备份范围与自动上传设置全局共用。
 * 当前方案投影到顶层字段，通过 setActiveFields 更新。
 * WebDAV 密码仅保留 hasPassword 状态，加密口令由后端回传。
 */
import { api } from './api.js';
import { characterEntries, worldEntries } from './tavern.js';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';
const DEFAULT_PROFILE_NAME = '默认';
export const DEFAULT_INTERVAL_MINUTES = 360;
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export const DEFAULT_CONFIG = {
    profiles: [],
    activeProfileId: '',
    url: '',
    username: '',
    remotePath: DEFAULT_REMOTE_PATH,
    // 初始备份范围为空。
    scope: {
        characters: { all: false, selected: [] },
        chats: { all: false, selected: [], skip: [] },
        personas: { all: false, selected: [] },
        presets: {},
        themes: {},
        worlds: { all: false, selected: [] },
        apiProfiles: { all: false, selected: [] },
    },
    auto: { enabled: false, onChatEvents: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    hasPassword: false,
    encryption: { enabled: false, hasPassphrase: false, passphrase: '' },
    lastBackupAt: '',
};

/**
 * 后端 /status 提供的预设与美化目录清单。
 * 每项：{ key, label, detail, files, bytes, entries?: [{ value, label, bytes }], excluded? }。
 * detail 为真时提供文件明细；excluded 记录被排除的自带背景图数量。
 */
let scopeDirs = { presets: [], themes: [] };

export function setScopeDirs(incoming) {
    scopeDirs = {
        presets: incoming.presets,
        themes: incoming.themes,
    };
}

export function getScopeDirs(group) {
    return scopeDirs[group] || [];
}

/** 后端 /status 提供的聊天数量与大小，键为角色卡文件名去扩展名。 */
let chatCounts = {};

export function setChatCounts(incoming) {
    chatCounts = incoming;
}

export function getChatCount(stem) {
    return chatCounts[stem] || { files: 0, bytes: 0 };
}

/** 后端 /status 提供的人设与 API 配置选项。 */
let synthLists = { personas: [], apiProfiles: [] };

export function setSynthLists(incoming) {
    synthLists = { personas: incoming.personas, apiProfiles: incoming.apiProfiles };
}

export function getSynthList(group) {
    return synthLists[group] || [];
}

/** 某个目录的选择集，配置里还没有这一项时给个空的（不会写回配置）。 */
export function dirSelection(scope, group, key) {
    return scope?.[group]?.[key] || { all: false, selected: [] };
}

/** 确保 scope[group][key] 真实存在，供弹窗直接改写。 */
export function ensureDirSelection(scope, group, key) {
    if (!scope[group] || typeof scope[group] !== 'object') scope[group] = {};
    if (!scope[group][key]) scope[group][key] = { all: false, selected: [] };
    return scope[group][key];
}

let current = structuredClone(DEFAULT_CONFIG);
const initialProfile = emptyProfile();
current.profiles = [initialProfile];
current.activeProfileId = initialProfile.id;
reproject();

export function getConfig() {
    return current;
}

/** 用后端返回的配置覆盖本地副本。 */
export function applyConfig(incoming) {
    current = structuredClone(incoming);
    reproject();
    return current;
}

// 方案

function newProfileId() {
    return `p-${Math.random().toString(16).slice(2, 10)}`;
}

function emptyProfile(name) {
    return {
        id: newProfileId(),
        name: name || DEFAULT_PROFILE_NAME,
        url: '',
        username: '',
        remotePath: DEFAULT_REMOTE_PATH,
        hasPassword: false,
        lastBackupAt: '',
        // 各方案独立保存加密设置。
        encryption: { enabled: false, hasPassphrase: false, passphrase: '' },
    };
}

/** 把当前方案的连接信息投影到顶层，面板与各处读的都是这份。 */
function reproject() {
    const active = activeProfile();
    current.url = active.url;
    current.username = active.username;
    current.remotePath = active.remotePath;
    current.hasPassword = active.hasPassword;
    current.lastBackupAt = active.lastBackupAt;
    current.encryption = active.encryption;
}

export function activeProfile() {
    return current.profiles.find(item => item.id === current.activeProfileId);
}

/** 面板改了连接输入框，写回当前方案（顶层投影跟着更新）。 */
export function setActiveFields(fields) {
    Object.assign(activeProfile(), fields);
    reproject();
}

export function setActiveProfile(id) {
    if (!current.profiles.some(item => item.id === id)) return false;
    current.activeProfileId = id;
    reproject();
    return true;
}

export function addProfile(name) {
    const profile = emptyProfile(name);
    current.profiles.push(profile);
    current.activeProfileId = profile.id;
    reproject();
    return profile;
}

export function renameProfile(id, name) {
    const profile = current.profiles.find(item => item.id === id);
    if (!profile) return false;
    profile.name = String(name || '').trim() || DEFAULT_PROFILE_NAME;
    return true;
}

/** 保留最后一个方案。 */
export function removeProfile(id) {
    if (current.profiles.length <= 1) return false;
    const index = current.profiles.findIndex(item => item.id === id);
    if (index < 0) return false;
    current.profiles.splice(index, 1);
    if (current.activeProfileId === id) current.activeProfileId = current.profiles[0].id;
    reproject();
    return true;
}

export async function loadConfig() {
    const data = await api('config/load');
    return applyConfig(data.config);
}

/**
 * 提交内存配置；password 和 passphrase 写入当前方案。
 * 空值保留已保存凭据。
 */
export async function pushConfig(password = '', { clearPassword = false, passphrase = '', clearPassphrase = false } = {}) {
    const activeId = current.activeProfileId;
    const payload = {
        activeProfileId: activeId,
        scope: current.scope,
        auto: current.auto,
        profiles: current.profiles.map(item => {
            // 提交加密开关与口令，由后端计算 hasPassphrase。
            const { hasPassword, encryption, ...rest } = item;
            const base = { ...rest, encryption: { enabled: !!encryption?.enabled } };
            if (item.id !== activeId) return base;

            if (clearPassphrase) base.encryption.clearPassphrase = true;
            else if (passphrase) base.encryption.passphrase = passphrase;

            if (clearPassword) return { ...base, clearPassword: true };
            return password ? { ...base, password } : base;
        }),
    };
    const data = await api('config/save', { config: payload });
    applyConfig(data.config);
    return data;
}

// 范围：一处判定，面板文案与弹窗按钮的选中态都用它

export function selectionEmpty(selection) {
    return !selection?.all && !(selection?.selected?.length > 0);
}

export function selectionCount(selection, total) {
    if (selection?.all) return total;
    return selection?.selected?.length || 0;
}

/** 判断预设或美化组是否选中了可备份文件。 */
function dirGroupEnabled(scope, group) {
    return getScopeDirs(group).some(dir =>
        dir.files > 0 && !selectionEmpty(dirSelection(scope, group, dir.key)));
}

/** 计算六类范围的选中状态，数量为 0 的类别视为未选。 */
export function scopeEnabled(scope = getConfig().scope) {
    return {
        characters: !selectionEmpty(scope.characters) && characterEntries().length > 0,
        chats: !selectionEmpty(scope.chats),
        personas: !selectionEmpty(scope.personas) && getSynthList('personas').length > 0,
        presets: dirGroupEnabled(scope, 'presets'),
        themes: dirGroupEnabled(scope, 'themes'),
        worlds: !selectionEmpty(scope.worlds) && worldEntries().length > 0,
        apiProfiles: !selectionEmpty(scope.apiProfiles) && getSynthList('apiProfiles').length > 0,
    };
}

/** 预设/美化某一组的文案片段："OpenAI 预设 全部 3 个、UI 主题 5 个"。 */
function describeDirGroup(scope, group) {
    const parts = [];
    for (const dir of getScopeDirs(group)) {
        if (!dir.files) continue;
        const selection = dirSelection(scope, group, dir.key);
        if (selectionEmpty(selection)) continue;
        // 背景图按整类开关显示。
        if (!dir.detail) parts.push(dir.label);
        else if (selection.all) parts.push(`${dir.label} 全部 ${dir.files} 个`);
        else parts.push(`${dir.label} ${selection.selected.length} 个`);
    }
    return parts;
}

/** 生成备份范围摘要。 */
export function describeScope(scope = getConfig().scope) {
    const parts = [];

    const charTotal = characterEntries().length;
    if (scope.characters?.all && charTotal) parts.push(`角色卡 全部 ${charTotal} 张`);
    else if (scope.characters?.selected?.length) parts.push(`角色卡 ${scope.characters.selected.length} 张`);

    // 仅在选中角色卡时显示聊天范围。
    if (!selectionEmpty(scope.characters) && charTotal) {
        if (scope.chats?.all) {
            const skipped = scope.chats.skip?.length || 0;
            parts.push(skipped ? `聊天记录 全部（排除 ${skipped} 条）` : '聊天记录 全部');
        } else if (scope.chats?.selected?.length) {
            parts.push(`聊天记录 ${scope.chats.selected.length} 条`);
        }
    }

    const personaTotal = getSynthList('personas').length;
    if (personaTotal) {
        if (scope.personas?.all) parts.push(`用户人设 全部 ${personaTotal} 个`);
        else if (scope.personas?.selected?.length) parts.push(`用户人设 ${scope.personas.selected.length} 个`);
    }

    parts.push(...describeDirGroup(scope, 'presets'));
    parts.push(...describeDirGroup(scope, 'themes'));

    // 独立世界书数量为 0 时省略该类别。
    const worldTotal = worldEntries().length;
    if (worldTotal) {
        if (scope.worlds?.all) parts.push(`世界书 全部 ${worldTotal} 本`);
        else if (scope.worlds?.selected?.length) parts.push(`世界书 ${scope.worlds.selected.length} 本`);
    }

    if (scope.apiProfiles?.all) parts.push(`API 配置 全部 ${getSynthList('apiProfiles').length} 个`);
    else if (scope.apiProfiles?.selected?.length) parts.push(`API 配置 ${scope.apiProfiles.selected.length} 个`);

    return parts.length ? parts.join('、') : '未选择任何内容';
}
