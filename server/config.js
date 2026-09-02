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
const crypto = require('node:crypto');

const paths = require('./paths.js');

const CONFIG_DIR = '.sillytavern-cloud-backup';
const CONFIG_FILE = 'config.json';

const DEFAULT_REMOTE_PATH = 'sillytavern-backup';
const DEFAULT_PROFILE_NAME = '默认';

// 自动上传间隔以分钟计。下限 15 分钟：再密就只是反复扫盘，
// 因为一轮备份本身要遍历全部聊天算哈希
const DEFAULT_INTERVAL_MINUTES = 360;
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

// ---------------------------------------------------------------------------
// 方案：一套连接信息（地址 / 用户名 / 密码 / 远端目录）
//
// 备份范围与自动上传是全局的，不跟着方案走 —— 换网盘换的是"存到哪儿"，
// 不是"备份什么"。
// ---------------------------------------------------------------------------

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
        // 加密是方案级的：坚果云那套开着，家里 NAS 那套可以关着
        encryption: { enabled: false, passphrase: '' },
    };
}

/**
 * 规范化一条方案的加密设置。
 *
 * passphrase 与 password 同一套语义：前端从不回显，留空表示「不修改」。
 * 照收空串就等于每保存一次配置清空一次口令，而用户毫无察觉 —— 直到下次下载时
 * 才发现云端的东西全都解不开了。要清除得显式传 clearPassphrase。
 */
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

/**
 * 一份全新配置。
 *
 * 六类一律不勾 —— 备份什么由用户自己决定，插件不替他往网盘塞东西。
 * 面板打开后先去「范围」里勾一遍，是使用这个插件的第一步。
 */
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

/**
 * 把当前方案的连接信息投影到顶层。
 *
 * 上层（resolveConfig、webdav.js、backup.js）一直是按 config.url 这样直接取值的，
 * 多方案是垫在它们下面的一层，不该逼它们跟着改。权威数据在 profiles 里，
 * 顶层这几个字段是只读投影，落盘前由 toStored 剥掉，免得密码存两份。
 */
function withActive(config) {
    const active = config.profiles.find(item => item.id === config.activeProfileId) || config.profiles[0];
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

/** 落盘只写权威字段。 */
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

function clampMinutes(value, fallback) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return fallback;
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
}

/**
 * 间隔曾经以小时计（默认 6）。字段换成分钟后若照读那个 6，就成了 6 分钟 ——
 * 比用户原本的设定密 60 倍，而他不会察觉。所以只认新字段，缺了才按小时折算。
 */
function readInterval(auto, fallback) {
    if (auto?.intervalMinutes !== undefined) return clampMinutes(auto.intervalMinutes, fallback);
    if (auto?.intervalHours !== undefined) return clampMinutes(Number(auto.intervalHours) * 60, fallback);
    return fallback;
}

/**
 * 规范化方案列表。
 *
 * 密码沿用"留空 = 不修改"：前端从不回显密码，每次保存送上来的都是空串，
 * 照单全收就等于每保存一次清空一次。要清除得显式传 clearPassword。
 * 按 id 去 base 里找旧密码，所以改名、换地址都不会把密码弄丢。
 */
function readProfiles(raw, base) {
    const list = Array.isArray(raw) ? raw : [];
    const previous = new Map((base.profiles || []).map(item => [item.id, item]));
    const seen = new Set();
    const out = [];

    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        // id 冲突时重发一个：手改配置文件粘贴出两条同 id 的话，
        // 后面按 id 找密码、切方案就全乱了
        let id = String(item.id || '').trim() || newProfileId();
        while (seen.has(id)) id = newProfileId();
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

    return out.length ? out : [emptyProfile()];
}

/**
 * 老配置的连接信息摊在顶层，没有 profiles。原样包成一个方案。
 * 迁移只做这一次 —— 包完再存回去就是新格式了。
 */
function migrateLegacy(stored) {
    if (!stored || typeof stored !== 'object') return stored;
    if (Array.isArray(stored.profiles) && stored.profiles.length) return stored;

    const legacy = ['url', 'username', 'password', 'remotePath'];
    if (!legacy.some(key => typeof stored[key] === 'string' && stored[key] !== '')) return stored;

    const profile = emptyProfile();
    profile.url = String(stored.url || '');
    profile.username = String(stored.username || '');
    profile.password = typeof stored.password === 'string' ? stored.password : '';
    profile.remotePath = String(stored.remotePath || '') || DEFAULT_REMOTE_PATH;
    profile.lastBackupAt = String(stored.lastBackupAt || '');
    return { ...stored, profiles: [profile], activeProfileId: profile.id };
}

/** 只认识自己定义的字段，手改出来的杂项一律丢弃。 */
function mergeConfig(base, storedRaw) {
    const stored = migrateLegacy(storedRaw);
    const scope = stored?.scope || {};
    const auto = stored?.auto || {};

    // 没带 profiles 就沿用现有的，别把用户存好的方案冲掉
    const profiles = readProfiles(Array.isArray(stored?.profiles) ? stored.profiles : base.profiles, base);
    const wanted = String(stored?.activeProfileId || '').trim();
    const activeProfileId = profiles.some(item => item.id === wanted) ? wanted : profiles[0].id;

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
    } catch {
        return base;
    }
}

/**
 * 保存配置。密码留空表示"不修改"（见 readProfiles），绝不会因为前端没回显密码
 * 就把它清掉；要清除密码得在那一条方案上显式传 clearPassword。
 */
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

/** 记一笔备份完成时间，不动其他字段。时间记在当前方案上，各方案各算各的。 */
function touchLastBackup(directories, when) {
    const current = readConfig(directories);
    const active = current.profiles.find(item => item.id === current.activeProfileId);
    if (!active) return;
    active.lastBackupAt = when;
    save(directories, withActive(current));
}

/** 给前端看的配置：密码与加密口令永远不回传，只说存没存。 */
function publicConfig(config) {
    const { password, profiles, encryption, ...rest } = config;
    const publicEncryption = enc => ({
        enabled: !!enc?.enabled,
        hasPassphrase: !!enc?.passphrase,
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
    // 开了加密却没口令：这时候上传下去的会是明文，而用户以为加密了。宁可拦住
    if (config.encryption?.enabled && !config.encryption.passphrase) {
        throw new Error('已开启加密，但还没有填写加密口令。请在面板里填好口令再保存配置。');
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
    migrateLegacy,
    withActive,
    toStored,
};
