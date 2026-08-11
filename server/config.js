/**
 * 插件自管配置。
 *
 * 配置（含 WebDAV 密码）落在用户数据目录下的 .webdav-chat-backup/config.json，
 * 不再走酒馆的 /api/secrets 接口 —— 少一层跨接口失败点，"保存配置"一个按钮就能存全。
 *
 * 范围模型只有四类，与面板上的四个按钮一一对应：
 *   角色卡    按 avatar 文件名选，可全选
 *   聊天记录  开关，范围跟随角色卡的选择（不单独选）
 *   世界书    按名字选，可全选
 *   设置      开关，只有 settings.json 一个文件
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_DIR = '.webdav-chat-backup';
const CONFIG_FILE = 'config.json';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';

/** 一份全新配置：默认全选角色卡与世界书，设置默认不备份（含 API 地址，跨设备互相覆盖会出事）。 */
function defaultConfig() {
    return {
        url: '',
        username: '',
        password: '',
        remotePath: DEFAULT_REMOTE_PATH,
        scope: {
            characters: { all: true, selected: [] },
            chats: { enabled: true },
            worlds: { all: true, selected: [] },
            settings: { enabled: false },
        },
        auto: { enabled: false, onChatEvents: true, intervalHours: 6 },
        lastBackupAt: '',
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

function clampHours(value, fallback) {
    const hours = Number(value);
    if (!Number.isFinite(hours)) return fallback;
    return Math.min(168, Math.max(0.25, hours));
}

/** 只认识自己定义的字段，手改出来的杂项一律丢弃。 */
function mergeConfig(base, stored) {
    const scope = stored?.scope || {};
    const auto = stored?.auto || {};
    return {
        url: String(stored?.url ?? base.url).trim(),
        username: String(stored?.username ?? base.username).trim(),
        password: typeof stored?.password === 'string' ? stored.password : base.password,
        remotePath: String(stored?.remotePath ?? base.remotePath).trim() || DEFAULT_REMOTE_PATH,
        scope: {
            characters: readSelection(scope.characters, base.scope.characters),
            chats: { enabled: scope.chats?.enabled !== false },
            worlds: readSelection(scope.worlds, base.scope.worlds),
            settings: { enabled: scope.settings?.enabled === true },
        },
        auto: {
            enabled: auto.enabled === true,
            onChatEvents: auto.onChatEvents !== false,
            intervalHours: clampHours(auto.intervalHours, base.auto.intervalHours),
        },
        lastBackupAt: String(stored?.lastBackupAt ?? base.lastBackupAt ?? ''),
    };
}

function readConfig(directories) {
    const base = defaultConfig();
    try {
        return mergeConfig(base, JSON.parse(fs.readFileSync(configFilePath(directories), 'utf8')));
    } catch {
        return base;
    }
}

/**
 * 保存配置。密码留空表示"不修改"，绝不会因为前端没回显密码就把它清掉；
 * 要清除密码得显式传 clearPassword。
 */
function writeConfig(directories, incoming) {
    const current = readConfig(directories);
    const merged = mergeConfig(current, {
        ...incoming,
        password: incoming?.clearPassword === true
            ? ''
            : (typeof incoming?.password === 'string' && incoming.password !== '' ? incoming.password : current.password),
    });

    const file = configFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

/** 记一笔备份完成时间，不动其他字段。 */
function touchLastBackup(directories, when) {
    const current = readConfig(directories);
    current.lastBackupAt = when;
    const file = configFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
}

/** 给前端看的配置：密码永远不回传，只说存没存。 */
function publicConfig(config) {
    const { password, ...rest } = config;
    return { ...rest, hasPassword: !!password };
}

/** 上层各模块统一使用的形状。校验放在这里，路由只管调。 */
function resolveConfig(directories) {
    const config = readConfig(directories);
    if (!config.url) throw new Error('请先填写 WebDAV 地址并保存配置。');
    try {
        const parsed = new URL(config.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
        throw new Error('WebDAV 地址格式不正确。');
    }
    return config;
}

module.exports = {
    CONFIG_DIR,
    DEFAULT_REMOTE_PATH,
    defaultConfig,
    readConfig,
    writeConfig,
    touchLastBackup,
    publicConfig,
    resolveConfig,
};
