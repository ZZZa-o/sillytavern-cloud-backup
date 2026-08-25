/**
 * 合成文件：备份链路里"看起来是一个文件、实际不在磁盘上"的那几样。
 *
 * 用户人设与 API 连接配置都没有自己的文件 —— 它们是 settings.json 里的几个字段
 * （外加 secrets.json 里的密钥）。整份 settings.json 传上网盘再整份盖回来，
 * 会连界面偏好、当前模型这些设备相关的东西一起覆盖，所以这里只抽需要的字段，
 * 拼成一个虚拟文件参与备份，下载时**逐键合并**回去，不动其余部分。
 *
 *   personas.json      power_user 里的人设三件套 + 头像（头像走普通目录，不在这里）
 *   api-profiles.json  connectionManager.profiles + 它们引用到的密钥与代理预设
 *
 * 关于密钥：api-profiles.json 里带**明文** API key 与代理密码。这是插件使用者
 * 明确要求的 —— 备份目标是自己的私人网盘，换设备时不必重填一遍。
 * 只有被勾中的那几个配置档引用到的密钥会被带上，没引用的一个都不碰。
 */
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.json';

const PERSONAS_FILE = 'personas.json';
const API_PROFILES_FILE = 'api-profiles.json';

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

function settingsPath(directories) {
    return path.join(directories.root, SETTINGS_FILE);
}

function secretsPath(directories) {
    return path.join(directories.root, SECRETS_FILE);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

/**
 * 原子写：先落临时文件再改名。
 * settings.json 是酒馆的命脉，中途断电也不能留下半个文件。
 */
function writeJson(file, data) {
    const tmp = `${file}.stcb-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4), 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * 递归按键排序后序列化。
 * JSON.stringify 的键序跟着插入顺序走，同样的数据两次序列化可能不一样，
 * 那样每次备份都会觉得"内容变了"而重传一遍。
 */
function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
        return out;
    }
    return value;
}

function toBuffer(data) {
    return Buffer.from(`${JSON.stringify(stableJson(data), null, 2)}\n`, 'utf8');
}

function parseBuffer(buffer) {
    const data = JSON.parse(buffer.toString('utf8'));
    if (!data || typeof data !== 'object') throw new Error('云端文件内容不是合法的 JSON 对象');
    return data;
}

/** 选择集是否命中。与 paths.js 同义，这里不引它是为了避免两个模块互相 require。 */
function selectionHas(selection, name) {
    if (!selection) return false;
    if (selection.all) return true;
    return Array.isArray(selection.selected) && selection.selected.includes(name);
}

/** 按某个字段合并两个数组：同键的用云端的覆盖，本机独有的保留，云端新增的追加。 */
function mergeBy(field, local, incoming) {
    const out = Array.isArray(local) ? [...local] : [];
    for (const item of Array.isArray(incoming) ? incoming : []) {
        const key = item?.[field];
        if (!key) continue;
        const at = out.findIndex(existing => existing?.[field] === key);
        if (at >= 0) out[at] = { ...out[at], ...item };
        else out.push(item);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 用户人设
// ---------------------------------------------------------------------------

/** 供范围弹窗渲染：头像文件名 → 人设名。 */
function listPersonas(directories) {
    const settings = readJson(settingsPath(directories), {});
    const personas = settings.power_user?.personas;
    if (!personas || typeof personas !== 'object') return [];
    return Object.entries(personas)
        .map(([avatar, name]) => ({ value: avatar, label: String(name || avatar) }))
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

function buildPersonas(directories, selection) {
    const settings = readJson(settingsPath(directories), {});
    const power = settings.power_user || {};
    const all = power.personas && typeof power.personas === 'object' ? power.personas : {};

    const personas = {};
    const descriptions = {};
    for (const avatar of Object.keys(all).sort()) {
        if (!selectionHas(selection, avatar)) continue;
        personas[avatar] = all[avatar];
        const description = power.persona_descriptions?.[avatar];
        if (description) descriptions[avatar] = description;
    }

    return toBuffer({
        personas,
        persona_descriptions: descriptions,
        // 默认人设没被勾中就不必带，换台机器指向一个不存在的人设只会出错
        default_persona: personas[power.default_persona] !== undefined ? power.default_persona : null,
    });
}

function mergePersonas(directories, buffer) {
    const incoming = parseBuffer(buffer);
    const file = settingsPath(directories);
    const settings = readJson(file, {});
    if (!settings.power_user || typeof settings.power_user !== 'object') settings.power_user = {};
    const power = settings.power_user;

    // 逐键合并：本机独有的人设留着，同名的用云端的覆盖
    power.personas = { ...(power.personas || {}), ...(incoming.personas || {}) };
    power.persona_descriptions = {
        ...(power.persona_descriptions || {}),
        ...(incoming.persona_descriptions || {}),
    };
    if (incoming.default_persona) power.default_persona = incoming.default_persona;

    writeJson(file, settings);

    // 回传给前端热加载 —— 直接写进内存的 power_user 就能立刻在人设面板里看到
    return {
        absPath: file,
        data: {
            personas: power.personas,
            persona_descriptions: power.persona_descriptions,
            default_persona: power.default_persona ?? null,
        },
    };
}

// ---------------------------------------------------------------------------
// API 连接配置
// ---------------------------------------------------------------------------

function connectionManager(settings) {
    return settings.extension_settings?.connectionManager || {};
}

/** 供范围弹窗渲染：配置档 id → 它自己起的名字。 */
function listApiProfiles(directories) {
    const settings = readJson(settingsPath(directories), {});
    const profiles = connectionManager(settings).profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles
        .filter(profile => profile?.id)
        .map(profile => ({
            value: String(profile.id),
            label: String(profile.name || profile.id),
            api: String(profile.api || ''),
            // 有没有密钥跟着走，界面上要标一下 —— 这关系到换台机器要不要重填
            hasSecret: !!profile['secret-id'],
        }));
}

/** 这些配置档引用到的密钥（含明文）与代理预设（含明文密码）。 */
function referencedCredentials(directories, settings, profiles) {
    const secretIds = new Set(profiles.map(profile => profile['secret-id']).filter(Boolean));
    const proxyNames = new Set(
        profiles.map(profile => profile.proxy).filter(name => name && name !== 'None'));

    const secrets = [];
    if (secretIds.size) {
        const stored = readJson(secretsPath(directories), {});
        for (const [key, list] of Object.entries(stored)) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                if (!item?.id || !secretIds.has(item.id)) continue;
                secrets.push({
                    key,
                    id: item.id,
                    label: item.label || '',
                    value: item.value ?? '',
                    active: item.active === true,
                });
            }
        }
    }

    const proxies = Array.isArray(settings.proxies)
        ? settings.proxies.filter(proxy => proxy?.name && proxyNames.has(proxy.name))
        : [];

    return {
        secrets: secrets.sort((a, b) => String(a.id).localeCompare(String(b.id))),
        proxies: proxies.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    };
}

function buildApiProfiles(directories, selection) {
    const settings = readJson(settingsPath(directories), {});
    const all = connectionManager(settings).profiles;
    const profiles = (Array.isArray(all) ? all : [])
        .filter(profile => profile?.id && selectionHas(selection, String(profile.id)))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return toBuffer({ profiles, ...referencedCredentials(directories, settings, profiles) });
}

/**
 * 一组密钥里最多只能有一个 active。
 * 合并时本机原本激活的那个优先 —— 从云端拉一份配置不该顺手把当前在用的连接切走。
 */
function normalizeActive(list, localActiveId) {
    let kept = false;
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const shouldKeep = localActiveId ? item.id === localActiveId : (!kept && item.active === true);
        item.active = shouldKeep && !kept;
        if (item.active) kept = true;
    }
    // 本机原本一个都没激活（全新设备），就让第一个顶上，省得用户还要手动点一下
    if (!kept && list.length) list[0].active = true;
}

function mergeApiProfiles(directories, buffer) {
    const incoming = parseBuffer(buffer);

    const file = settingsPath(directories);
    const settings = readJson(file, {});
    if (!settings.extension_settings || typeof settings.extension_settings !== 'object') {
        settings.extension_settings = {};
    }
    const manager = settings.extension_settings.connectionManager
        || (settings.extension_settings.connectionManager = { selectedProfile: null, profiles: [] });

    manager.profiles = mergeBy('id', manager.profiles, incoming.profiles);
    // selectedProfile 是"这台机器现在连着哪个"，属于设备状态，不跟着云端走
    if (Array.isArray(incoming.proxies) && incoming.proxies.length) {
        settings.proxies = mergeBy('name', settings.proxies, incoming.proxies);
    }
    writeJson(file, settings);

    if (Array.isArray(incoming.secrets) && incoming.secrets.length) {
        const secretsFile = secretsPath(directories);
        const stored = readJson(secretsFile, {});
        const touchedKeys = new Set();

        for (const item of incoming.secrets) {
            if (!item?.key || !item.id) continue;
            if (!Array.isArray(stored[item.key])) stored[item.key] = [];
            touchedKeys.add(item.key);
            stored[item.key] = mergeBy('id', stored[item.key], [{
                id: item.id,
                value: item.value ?? '',
                label: item.label || '',
                active: item.active === true,
            }]);
        }

        for (const key of touchedKeys) {
            const localActive = readJson(secretsFile, {})[key];
            const activeId = Array.isArray(localActive)
                ? localActive.find(item => item?.active === true)?.id
                : undefined;
            normalizeActive(stored[key], activeId);
        }

        writeJson(secretsFile, stored);
    }

    return {
        absPath: file,
        data: { profiles: (incoming.profiles || []).length, secrets: (incoming.secrets || []).length },
    };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

const FILES = {
    [PERSONAS_FILE]: { group: 'personas', build: buildPersonas, merge: mergePersonas },
    [API_PROFILES_FILE]: { group: 'apiProfiles', build: buildApiProfiles, merge: mergeApiProfiles },
};

function isSynthetic(localRel) {
    return Object.prototype.hasOwnProperty.call(FILES, String(localRel));
}

/** 某一类范围对应的合成文件名，没有就返回空串。 */
function fileOfGroup(group) {
    const found = Object.entries(FILES).find(([, meta]) => meta.group === group);
    return found ? found[0] : '';
}

function build(localRel, directories, scope) {
    const meta = FILES[localRel];
    if (!meta) throw new Error(`不是合成文件：${localRel}`);
    return meta.build(directories, scope[meta.group]);
}

function merge(localRel, directories, buffer) {
    const meta = FILES[localRel];
    if (!meta) throw new Error(`不是合成文件：${localRel}`);
    return meta.merge(directories, buffer);
}

module.exports = {
    SETTINGS_FILE,
    PERSONAS_FILE,
    API_PROFILES_FILE,
    isSynthetic,
    fileOfGroup,
    build,
    merge,
    listPersonas,
    listApiProfiles,
    // 供单元测试
    stableJson,
    mergeBy,
    normalizeActive,
};
