/**
 * 前端持有的配置副本。真身在后端的 config.json —— 密码只进不出，
 * 这里永远拿不到明文，只知道 hasPassword。
 *
 * 连接信息按「方案」分组（profiles），一套方案就是一个网盘账号；
 * 备份范围与自动上传是全局的，换方案不跟着变。顶层的 url / username /
 * remotePath / hasPassword / lastBackupAt 是当前方案的投影，方便面板直接取，
 * 权威值在 profiles 里 —— 改这几个字段要走 setActiveFields。
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
    // 六类一律不勾：备份什么由用户自己去「范围」里决定
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
    encryption: { enabled: false, hasPassphrase: false },
    lastBackupAt: '',
};

/**
 * 预设与美化两组各有哪些目录，以及目录里的具体文件。
 * 由后端 /status 提供 —— 目录清单是后端 paths.js 定的，前端不再抄一份。
 *
 * 每项形如：
 *   { key, label, detail, files, bytes, entries?: [{ value, label, bytes }], excluded? }
 * detail 为真才有 entries（可展开逐个勾）；背景图 detail 为假，只是个整类开关，
 * excluded 是被排除掉的酒馆自带图张数。
 */
let scopeDirs = { presets: [], themes: [] };

export function setScopeDirs(incoming) {
    scopeDirs = {
        presets: Array.isArray(incoming?.presets) ? incoming.presets : [],
        themes: Array.isArray(incoming?.themes) ? incoming.themes : [],
    };
}

export function getScopeDirs(group) {
    return scopeDirs[group] || [];
}

/**
 * 每个角色目录下有几条聊天、多大。键是角色目录名（角色卡文件名去扩展名）。
 * 由 /status 一并送来，用于角色卡文件夹标题上的「N 条聊天」。
 */
let chatCounts = {};

/**
 * 后端到底有没有把这项数据送来。
 *
 * 「一条都没有」与「后端压根没给」在界面上长得一模一样，但对用户的意义天差地别：
 * 前者不用管，后者是服务端插件还是旧版（或装了新版没重启）。
 * 旧版后端的 /status 里根本没有这几个字段，只能靠"字段在不在"分辨。
 */
const supplied = { chatCounts: false, synth: false };

export function setChatCounts(incoming) {
    supplied.chatCounts = !!incoming && typeof incoming === 'object';
    chatCounts = supplied.chatCounts ? incoming : {};
}

export function getChatCount(stem) {
    return chatCounts[stem] || { files: 0, bytes: 0 };
}

/** 后端有没有提供聊天条数。false 表示后端太旧，不是"真的没有聊天"。 */
export function chatCountsSupplied() {
    return supplied.chatCounts;
}

/**
 * 人设与 API 连接配置的可选项，同样由 /status 送来。
 * 这两样都长在 settings.json 里，前端读不到，只能问后端。
 */
let synthLists = { personas: [], apiProfiles: [] };

export function setSynthLists(incoming = {}) {
    // 两个字段但凡有一个是数组，就说明后端认得这套接口
    supplied.synth = Array.isArray(incoming.personas) || Array.isArray(incoming.apiProfiles);
    synthLists = {
        personas: Array.isArray(incoming.personas) ? incoming.personas : [],
        apiProfiles: Array.isArray(incoming.apiProfiles) ? incoming.apiProfiles : [],
    };
}

export function getSynthList(group) {
    return synthLists[group] || [];
}

/** 后端有没有提供人设与 API 配置。false 表示后端太旧。 */
export function synthListsSupplied() {
    return supplied.synth;
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

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

let current = clone(DEFAULT_CONFIG);
// 先跑一遍补出第一条方案，好让 activeProfile() 在配置加载回来之前也有值可给
applyConfig({});

export function getConfig() {
    return current;
}

/** 用后端返回的配置覆盖本地副本，缺字段的用默认值补齐。 */
export function applyConfig(incoming = {}) {
    const base = clone(DEFAULT_CONFIG);
    const scope = incoming.scope || {};
    const auto = incoming.auto || {};
    const profiles = readProfiles(incoming.profiles);
    const wanted = String(incoming.activeProfileId || '');
    const activeProfileId = profiles.some(item => item.id === wanted) ? wanted : profiles[0].id;
    current = {
        profiles,
        activeProfileId,
        scope: {
            characters: readSelection(scope.characters, base.scope.characters),
            chats: readChats(scope.chats, base.scope.chats),
            personas: readSelection(scope.personas, base.scope.personas),
            presets: readDirGroup(scope.presets),
            themes: readDirGroup(scope.themes),
            worlds: readSelection(scope.worlds, base.scope.worlds),
            apiProfiles: readSelection(scope.apiProfiles, base.scope.apiProfiles),
        },
        auto: {
            enabled: auto.enabled === true,
            onChatEvents: auto.onChatEvents !== false,
            intervalMinutes: readInterval(auto, base.auto.intervalMinutes),
        },
    };
    reproject();
    return current;
}

/**
 * 间隔从小时改成了分钟。后端会做迁移，但配置在后端落盘之前，
 * 前端也可能先拿到一份带 intervalHours 的旧数据 —— 同样按小时折算，
 * 免得那个 6 在界面上显示成 6 分钟。
 */
function readInterval(auto, fallback) {
    const pick = auto?.intervalMinutes !== undefined
        ? Number(auto.intervalMinutes)
        : (auto?.intervalHours !== undefined ? Number(auto.intervalHours) * 60 : NaN);
    if (!Number.isFinite(pick)) return fallback;
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(pick)));
}

// ---------------------------------------------------------------------------
// 方案
// ---------------------------------------------------------------------------

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
        // 加密是方案级的：坚果云那套可以开着，家里 NAS 那套关着
        encryption: { enabled: false, hasPassphrase: false },
    };
}

/** 后端只回「开没开、存没存」，口令明文永远拿不到。 */
function readEncryption(raw) {
    return {
        enabled: raw?.enabled === true,
        hasPassphrase: raw?.hasPassphrase === true,
    };
}

/** 后端保证至少回一条；真拿不到（首次加载失败）就本地先造一条顶着。 */
function readProfiles(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = list
        .filter(item => item && typeof item === 'object' && item.id)
        .map(item => ({
            id: String(item.id),
            name: String(item.name || DEFAULT_PROFILE_NAME),
            url: String(item.url || ''),
            username: String(item.username || ''),
            remotePath: String(item.remotePath || DEFAULT_REMOTE_PATH),
            hasPassword: item.hasPassword === true,
            lastBackupAt: String(item.lastBackupAt || ''),
            encryption: readEncryption(item.encryption),
        }));
    return out.length ? out : [emptyProfile()];
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
    return current.profiles.find(item => item.id === current.activeProfileId) || current.profiles[0];
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

/** 删到一条不剩就没法备份了，最后一条不给删。 */
export function removeProfile(id) {
    if (current.profiles.length <= 1) return false;
    const index = current.profiles.findIndex(item => item.id === id);
    if (index < 0) return false;
    current.profiles.splice(index, 1);
    if (current.activeProfileId === id) current.activeProfileId = current.profiles[0].id;
    reproject();
    return true;
}

function readSelection(raw, fallback) {
    if (!raw || typeof raw !== 'object') return clone(fallback);
    return {
        all: raw.all === true,
        selected: Array.isArray(raw.selected) ? raw.selected.map(String) : [],
    };
}

/**
 * 聊天记录比别处多一个 skip：全选态下用户单独取消掉的那几条。
 * 明细是展开某张卡时才按需加载的，前端手上没有全集可写进 selected，只能记排除。
 */
function readChats(raw, fallback) {
    return {
        ...readSelection(raw, fallback),
        skip: Array.isArray(raw?.skip) ? raw.skip.map(String) : [],
    };
}

/** 预设/美化：目录键 → 文件级选择集。目录清单以后端为准，这里原样收下。 */
function readDirGroup(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, value] of Object.entries(raw)) {
        out[key] = readSelection(value, { all: false, selected: [] });
    }
    return out;
}

export async function loadConfig() {
    const data = await api('config/load');
    return applyConfig(data.config || {});
}

/**
 * 把内存副本提交到后端。password 与 passphrase 都只在用户真的输了新值时才带上，
 * 留空表示"不修改"，后端会保留原值 —— 两个框里的东西都属于当前方案，
 * 所以只往那一条上放。
 */
export async function pushConfig(password = '', { clearPassword = false, passphrase = '', clearPassphrase = false } = {}) {
    const activeId = current.activeProfileId;
    const payload = {
        activeProfileId: activeId,
        scope: current.scope,
        auto: current.auto,
        profiles: current.profiles.map(item => {
            // hasPassphrase 是后端算给前端看的，回传它没有意义
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
 * 预设/美化某一组里，有没有哪个目录被勾了。
 *
 * 目录里一个文件都没有时一律算没勾 —— 与世界书同理，
 * 点亮一个实际上什么都不会传的按钮只会骗人。
 */
function dirGroupEnabled(scope, group) {
    return getScopeDirs(group).some(dir =>
        dir.files > 0 && !selectionEmpty(dirSelection(scope, group, dir.key)));
}

/**
 * 六类各自是否算"已选择"，决定按钮要不要加粗。
 * 数量为 0 时一律算没选 —— 比如世界书全被角色卡内嵌了，独立世界书一本都没有，
 * 这时候还把按钮点亮就是在骗人。
 */
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
        // 背景图没有明细可选，只是个整类开关，说"全部"反而让人以为还有别的粒度
        if (!dir.detail) parts.push(dir.label);
        else if (selection.all) parts.push(`${dir.label} 全部 ${dir.files} 个`);
        else parts.push(`${dir.label} ${selection.selected.length} 个`);
    }
    return parts;
}

/** "当前已选择同步范围：xxx" 里的那段 xxx。 */
export function describeScope(scope = getConfig().scope) {
    const parts = [];

    const charTotal = characterEntries().length;
    if (scope.characters?.all && charTotal) parts.push(`角色卡 全部 ${charTotal} 张`);
    else if (scope.characters?.selected?.length) parts.push(`角色卡 ${scope.characters.selected.length} 张`);

    // 聊天必须跟着角色卡走，一张卡都没勾时说"聊天记录 全部"是在骗人 —— 实际一条都不会传
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

    // 独立世界书为 0 时干脆不提，说"世界书 全部"只会让人以为传了什么
    const worldTotal = worldEntries().length;
    if (worldTotal) {
        if (scope.worlds?.all) parts.push(`世界书 全部 ${worldTotal} 本`);
        else if (scope.worlds?.selected?.length) parts.push(`世界书 ${scope.worlds.selected.length} 本`);
    }

    if (scope.apiProfiles?.all) parts.push(`API 配置 全部 ${getSynthList('apiProfiles').length} 个`);
    else if (scope.apiProfiles?.selected?.length) parts.push(`API 配置 ${scope.apiProfiles.selected.length} 个`);

    return parts.length ? parts.join('、') : '未选择任何内容';
}
