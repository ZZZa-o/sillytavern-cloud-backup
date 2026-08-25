/**
 * 插件自管配置。
 *
 * 配置（含 WebDAV 密码）落在用户数据目录下的 .sillytavern-cloud-backup/config.json，
 * 不再走酒馆的 /api/secrets 接口 —— 少一层跨接口失败点，"保存配置"一个按钮就能存全。
 *
 * 范围模型有六类，与面板上的六个按钮一一对应：
 *   角色卡    按 avatar 文件名选，可全选
 *   聊天记录  按 <角色目录名>/<聊天文件> 逐条选；all 表示「已选角色的全部聊天」。
 *             没有独立的一级按钮 —— 它长在角色卡二级页面里，跟着角色卡走
 *   用户人设  按头像文件名选。人设的名字与描述在 settings.json 里，走合成文件
 *   预设      按目录分别持有一份文件级选择集（OpenAI Settings / QuickReplies）
 *   美化      同上（themes 逐个主题勾；backgrounds 只有整类开关）
 *   世界书    按名字选，可全选
 *   API 配置  按连接配置档的 id 选，同样是合成文件（含明文密钥）
 */
const fs = require('node:fs');
const path = require('node:path');

const paths = require('./paths.js');

const CONFIG_DIR = '.sillytavern-cloud-backup';
const CONFIG_FILE = 'config.json';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';

/** 预设/美化某一组的空选择集：{ openAI_Settings: {all:false,selected:[]}, … }。 */
function emptyDirGroup(group) {
    const out = {};
    for (const root of paths.rootsOfGroup(group)) {
        out[root.dirKey] = { all: false, selected: [] };
    }
    return out;
}

/**
 * 一份全新配置。
 *
 * 六类一律不勾 —— 备份什么由用户自己决定，插件不替他往网盘塞东西。
 * 面板打开后先去「范围」里勾一遍，是使用这个插件的第一步。
 */
function defaultConfig() {
    return {
        url: '',
        username: '',
        password: '',
        remotePath: DEFAULT_REMOTE_PATH,
        scope: {
            characters: { all: false, selected: [] },
            chats: { all: false, selected: [], skip: [] },
            personas: { all: false, selected: [] },
            presets: emptyDirGroup('presets'),
            themes: emptyDirGroup('themes'),
            worlds: { all: false, selected: [] },
            apiProfiles: { all: false, selected: [] },
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

/**
 * 聊天记录比别处多一个 skip：全选态下用户单独取消掉的那几条。
 * 用排除而不是把全集写进 selected —— 明细是展开某张卡时才按需加载的，
 * 前端手上根本没有全集可写。
 */
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
