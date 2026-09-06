/**
 * 管理用户目录下 .sillytavern-cloud-backup/config.json 中的配置。
 * profiles 保存 WebDAV 连接与加密设置；备份范围和自动上传设置全局共用。
 * 范围包括角色卡、用户人设、预设、美化、世界书和 API 配置。
 * 聊天记录在角色卡范围内按文件选择。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./paths.js');

const CONFIG_DIR = '.sillytavern-cloud-backup';
const CONFIG_FILE = 'config.json';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';
const DEFAULT_PROFILE_NAME = '默认';

// 自动上传间隔以分钟计，最短 15 分钟。
const DEFAULT_INTERVAL_MINUTES = 360;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

// WebDAV 方案：地址、用户名、密码、远端目录及加密设置。

function newProfileId() {
    return `p-${crypto.randomBytes(4).toString('hex')}`;
}

function emptyProfile(id) {
    return {
        id: id || newProfileId(),
        name: DEFAULT_PROFILE_NAME,
        url: '',
        username: '',
        password: '',
        remotePath: DEFAULT_REMOTE_PATH,
        lastBackupAt: '',
        // 各方案独立保存加密设置。
        encryption: { enabled: false, passphrase: '' },
    };
}

/** 规范化方案加密设置；口令留空时保留原值，clearPassphrase 显式清除口令。 */
function readEncryption(raw, old) {
    const previous = old || { enabled: false, passphrase: '' };
    if (!raw || typeof raw !== 'object') return { ...previous };
    const passphrase = raw.clearPassphrase === true
        ? ''
        : (typeof raw.passphrase === 'string' && raw.passphrase !== '' ? raw.passphrase : previous.passphrase);
    return { enabled: raw.enabled === true, passphrase };
}

/** 预设/美化某一组的空选择集：{ openAI_Settings: {all:false,selected:[]}, … }。 */
function emptyDirGroup(group) {
    const out = {};
    for (const root of paths.rootsOfGroup(group)) {
        out[root.dirKey] = { all: false, selected: [] };
    }
    return out;
}

/** 创建默认配置，初始备份范围为空。 */
function defaultConfig() {
    const profile = emptyProfile();
    return withActive({
        profiles: [profile],
        activeProfileId: profile.id,
        scope: {
            characters: { all: false, selected: [] },
            chats: { all: false, selected: [], skip: [] },
            personas: { all: false, selected: [] },
            presets: emptyDirGroup('presets'),
            themes: emptyDirGroup('themes'),
            worlds: { all: false, selected: [] },
            apiProfiles: { all: false, selected: [] },
        },
        auto: { enabled: false, onChatEvents: true, intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    });
}

/** 将当前方案投影到顶层；profiles 保存原始字段，落盘时由 toStored 移除投影。 */
function withActive(config) {
    const active = config.profiles.find(item => item.id === config.activeProfileId);
    if (!active) throw new Error('当前方案不存在。');
    return {
        ...config,
        activeProfileId: active.id,
        url: active.url,
        username: active.username,
        password: active.password,
        remotePath: active.remotePath,
        lastBackupAt: active.lastBackupAt,
        encryption: active.encryption || { enabled: false, passphrase: '' },
    };
}

/** 序列化配置，仅保留持久化字段。 */
function toStored(config) {
    return {
        profiles: config.profiles,
        activeProfileId: config.activeProfileId,
        scope: config.scope,
        auto: config.auto,
    };
}

function configFilePath(directories) {
    return path.join(directories.root, CONFIG_DIR, CONFIG_FILE);
}

function toStringArray(value) {
    return Array.isArray(value)
        ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
        : [];
}

function readSelection(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { all: fallback.all, selected: [...fallback.selected] };
    return { all: raw.all === true, selected: toStringArray(raw.selected) };
}

/** 聊天全选模式通过 skip 保存排除项。 */
function readChats(raw, fallback) {
    return { ...readSelection(raw, fallback), skip: toStringArray(raw?.skip) };
}

/** 预设/美化：只认 ROOTS 里定义的目录键，配置里多出来的一律丢弃。 */
function readDirGroup(raw, fallback, group) {
    const out = {};
    for (const root of paths.rootsOfGroup(group)) {
        out[root.dirKey] = readSelection(raw?.[root.dirKey], fallback[root.dirKey] || { all: false, selected: [] });
    }
    return out;
}

function clampMinutes(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) throw new Error('自动上传间隔必须是数字。');
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
}

/** 读取自动上传的分钟间隔。 */
function readInterval(auto, fallback) {
    if (auto?.intervalMinutes !== undefined) return clampMinutes(auto.intervalMinutes);
    return fallback;
}

/**
 * 规范化方案列表并按 id 继承已存密码。
 * 密码留空时保留原值，clearPassword 显式清除密码。
 */
function readProfiles(raw, base) {
    if (raw.length === 0) throw new Error('至少要保留一个方案。');
    const previous = new Map(base.profiles.map(item => [item.id, item]));
    const seen = new Set();
    const out = [];

    for (const item of raw) {
        const id = item.id.trim();
        if (!id || seen.has(id)) throw new Error('方案 ID 为空或重复。');
        seen.add(id);

        const old = previous.get(id) || emptyProfile(id);
        out.push({
            id,
            name: String(item.name ?? old.name).trim() || DEFAULT_PROFILE_NAME,
            url: String(item.url ?? old.url).trim(),
            username: String(item.username ?? old.username).trim(),
            password: item.clearPassword === true
                ? ''
                : (typeof item.password === 'string' && item.password !== '' ? item.password : old.password),
            remotePath: String(item.remotePath ?? old.remotePath).trim() || DEFAULT_REMOTE_PATH,
            lastBackupAt: String(item.lastBackupAt ?? old.lastBackupAt ?? ''),
            encryption: readEncryption(item.encryption, old.encryption),
        });
    }

    return out;
}

/** 只认识自己定义的字段，手改出来的杂项一律丢弃。 */
function mergeConfig(base, stored) {
    const scope = stored?.scope || {};
    const auto = stored?.auto || {};

    // 未传 profiles 时保留现有方案。
    const profiles = readProfiles(Array.isArray(stored?.profiles) ? stored.profiles : base.profiles, base);
    const activeProfileId = stored.activeProfileId === undefined ? base.activeProfileId : stored.activeProfileId;

    return withActive({
        profiles,
        activeProfileId,
        scope: {
            characters: readSelection(scope.characters, base.scope.characters),
            chats: readChats(scope.chats, base.scope.chats),
            personas: readSelection(scope.personas, base.scope.personas),
            presets: readDirGroup(scope.presets, base.scope.presets, 'presets'),
            themes: readDirGroup(scope.themes, base.scope.themes, 'themes'),
            worlds: readSelection(scope.worlds, base.scope.worlds),
            apiProfiles: readSelection(scope.apiProfiles, base.scope.apiProfiles),
        },
        auto: {
            enabled: auto.enabled === true,
            onChatEvents: auto.onChatEvents !== false,
            intervalMinutes: readInterval(auto, base.auto.intervalMinutes),
        },
    });
}

function readConfig(directories) {
    const base = defaultConfig();
    try {
        return mergeConfig(base, JSON.parse(fs.readFileSync(configFilePath(directories), 'utf8')));
    } catch (error) {
        if (error.code === 'ENOENT') return base;
        throw error;
    }
}

/** 保存配置；密码留空时保留原值，clearPassword 显式清除密码。 */
function writeConfig(directories, incoming) {
    const current = readConfig(directories);
    const merged = mergeConfig(current, incoming);
    save(directories, merged);
    return merged;
}

function save(directories, config) {
    const file = configFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(toStored(config), null, 2), 'utf8');
}

/** 更新当前方案的备份完成时间。 */
function touchLastBackup(directories, when) {
    const current = readConfig(directories);
    const active = current.profiles.find(item => item.id === current.activeProfileId);
    if (!active) return;
    active.lastBackupAt = when;
    save(directories, withActive(current));
}

/** 生成前端配置：WebDAV 密码转换为 hasPassword，加密设置包含口令文本。 */
function publicConfig(config) {
    const { password, profiles, encryption, ...rest } = config;
    const publicEncryption = enc => ({
        enabled: !!enc?.enabled,
        hasPassphrase: !!enc?.passphrase,
        passphrase: String(enc?.passphrase || ''),
    });
    return {
        ...rest,
        hasPassword: !!password,
        encryption: publicEncryption(encryption),
        profiles: profiles.map(({ password: secret, encryption: enc, ...item }) => ({
            ...item,
            hasPassword: !!secret,
            encryption: publicEncryption(enc),
        })),
    };
}

/** 校验连接配置并转换为备份模块使用的结构。 */
function resolveConfig(directories) {
    const config = readConfig(directories);
    if (!config.url) throw new Error('请先填写 WebDAV 地址并保存配置。');
    try {
        const parsed = new URL(config.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
        throw new Error('WebDAV 地址格式不正确。');
    }
    // 开启加密但缺少口令时拒绝操作。
    if (config.encryption?.enabled && !config.encryption.passphrase) {
        throw new Error('请填写加密口令并保存配置。');
    }
    return config;
}

module.exports = {
    CONFIG_DIR,
    DEFAULT_REMOTE_PATH,
    DEFAULT_INTERVAL_MINUTES,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
    defaultConfig,
    readConfig,
    writeConfig,
    touchLastBackup,
    publicConfig,
    resolveConfig,
    // 纯函数，供单元测试
    mergeConfig,
    withActive,
    toStored,
};
