/**
 * 从 settings.json 和 secrets.json 提取人设及 API 配置，生成合成文件。
 * personas/<人设名>.json 保存人设名字、描述与注入设置，头像单独备份。
 * api-profiles/<配置名>.json 保存单个配置档及其引用的密钥与代理设置。
 * 下载时按条目合并，保留本机其他配置。
 * API 配置的合成内容包含所引用密钥与代理密码的明文。
 */
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.json';

// 人设虚拟路径 personas/<人设名>.json 对应云端 用户人设/<人设名>/persona.json。
const PERSONAS_DIR = 'personas';
const PERSONA_FILE = 'persona.json';

// 配置虚拟路径 api-profiles/<配置名>.json 对应云端 API配置/<配置名>.json。
const API_DIR = 'api-profiles';

// 读写

function settingsPath(directories) {
    return path.join(directories.root, SETTINGS_FILE);
}

function secretsPath(directories) {
    return path.join(directories.root, SECRETS_FILE);
}

function readJson(file, missingValue) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return missingValue;
        throw error;
    }
}

const sourceCache = new Map();

/** 按文件大小和修改时间缓存用于提取数据的 JSON。 */
function readSource(file) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
        sourceCache.delete(file);
        return {};
    }
    const cached = sourceCache.get(file);
    if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs && cached.ctime === stat.ctimeMs) {
        return cached.data;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    sourceCache.set(file, { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, data });
    return data;
}

/** 通过临时文件和重命名原子写入 JSON。 */
function writeJson(file, data) {
    const tmp = `${file}.stcb-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4), 'utf8');
    fs.renameSync(tmp, file);
}

/** 递归按键排序后序列化 JSON。 */
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

/** 判断名称是否命中选择集。 */
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

// 用户人设

const AVATAR_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;

/** 头像目录里真实存在的头像文件名。读不到目录就返回空数组。 */
function listAvatarFiles(directories) {
    try {
        return fs.readdirSync(directories.avatars, { withFileTypes: true })
            .filter(entry => entry.isFile() && AVATAR_EXT.test(entry.name))
            .map(entry => entry.name);
    } catch {
        return [];
    }
}

/** 某个头像文件在磁盘上是否真的存在。 */
function hasAvatarFile(directories, avatar) {
    try {
        return fs.statSync(path.join(directories.avatars, avatar)).isFile();
    } catch {
        return false;
    }
}

/** 去除人设名两端空白；未命名头像返回空串。 */
function personaNameOf(value) {
    return value === undefined ? '' : value.trim();
}

/** 将标签转换为单行并截断过长内容。 */
function shortLabel(text, limit = 40) {
    const line = String(text).replace(/\s+/g, ' ').trim();
    return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 按磁盘上的头像文件生成人设选项，note 附带头像文件名。 */
function listPersonas(directories) {
    const settings = readSource(settingsPath(directories));
    const named = settings.power_user?.personas;
    const all = named && typeof named === 'object' ? named : {};
    const files = listAvatarFiles(directories);

    return files
        .map((avatar) => {
            const name = personaNameOf(all[avatar]);
            return {
                value: avatar,
                label: name ? shortLabel(name) : '（未命名人设）',
                note: avatar,
                fullName: name,
            };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN')
            || a.value.localeCompare(b.value));
}

/** 本机的 头像文件名 → 人设名。 */
function localPersonaNames(directories) {
    const settings = readSource(settingsPath(directories));
    const all = settings.power_user?.personas;
    if (!all || typeof all !== 'object') return {};
    const out = {};
    for (const [avatar, value] of Object.entries(all)) {
        const name = personaNameOf(value);
        if (name) out[avatar] = name;
    }
    return out;
}

/** 本地虚拟路径：personas/<文件夹名>.json。文件夹名由 paths.buildPersonaIndex 定。 */
function personaLocalPath(folder) {
    return `${PERSONAS_DIR}/${folder}.json`;
}

/** 是不是「某一个人设」的合成文件路径。 */
function isPersonaPath(localRel) {
    const parts = String(localRel || '').split('/');
    return parts.length === 2
        && parts[0] === PERSONAS_DIR
        && parts[1].length > 5
        && parts[1].toLowerCase().endsWith('.json');
}

/** 从 personas/沈知微.json 取出「沈知微」。 */
function personaFolderOf(localRel) {
    if (!isPersonaPath(localRel)) return '';
    return String(localRel).slice(PERSONAS_DIR.length + 1, -'.json'.length);
}

/** 生成单个人设数据，包含头像文件名、名字、描述、注入设置与默认状态。 */
function buildPersona(directories, avatar) {
    const settings = readSource(settingsPath(directories));
    const power = settings.power_user || {};
    return toBuffer({
        avatar,
        name: personaNameOf(power.personas?.[avatar]),
        description: power.persona_descriptions?.[avatar] ?? null,
        isDefault: power.default_persona === avatar,
    });
}

/** 将单个人设合并到本机配置。 */
function mergePersona(directories, buffer) {
    const incoming = parseBuffer(buffer);
    const avatar = typeof incoming?.avatar === 'string' ? incoming.avatar.trim() : '';
    // 校验头像文件名为合法的单个路径段。
    if (!avatar || /[\\/]/.test(avatar) || avatar === '.' || avatar === '..') {
        throw new Error('人设文件里没有有效的头像文件名，无法合并');
    }

    const file = settingsPath(directories);
    const settings = readJson(file, {});
    if (!settings.power_user || typeof settings.power_user !== 'object') settings.power_user = {};
    const power = settings.power_user;
    if (!power.personas || typeof power.personas !== 'object') power.personas = {};
    if (!power.persona_descriptions || typeof power.persona_descriptions !== 'object') {
        power.persona_descriptions = {};
    }

    power.personas[avatar] = incoming.name;
    if (incoming.description === null) delete power.persona_descriptions[avatar];
    else power.persona_descriptions[avatar] = incoming.description;

    // 仅在头像文件已存在时更新默认人设。
    if (incoming.isDefault === true && hasAvatarFile(directories, avatar)) {
        power.default_persona = avatar;
    }

    writeJson(file, settings);

    // 返回合并后的人设字段，供前端刷新。
    return {
        absPath: file,
        data: {
            personas: power.personas,
            persona_descriptions: power.persona_descriptions,
            default_persona: power.default_persona ?? null,
        },
    };
}

/** 按选择集生成人设合成文件；folders 为头像文件名到云端目录名的映射。 */
function listPersonaFiles(directories, selection, folders = {}) {
    return listPersonas(directories)
        .filter(item => selectionHas(selection, item.value))
        .map(item => ({
            localRel: personaLocalPath(folders[item.value] || item.value),
            avatar: item.value,
        }));
}

// API 连接配置

function connectionManager(settings) {
    return settings.extension_settings?.connectionManager || {};
}

/** 供范围弹窗渲染：配置档 id → 它自己起的名字。 */
function listApiProfiles(directories) {
    const settings = readSource(settingsPath(directories));
    const profiles = connectionManager(settings).profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles
        .filter(profile => profile?.id)
        .map(profile => ({
            value: String(profile.id),
            label: String(profile.name || profile.id),
            api: String(profile.api || ''),
            // 标注配置档是否引用密钥。
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
        const stored = readSource(secretsPath(directories));
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
    const settings = readSource(settingsPath(directories));
    const all = connectionManager(settings).profiles;
    const profiles = (Array.isArray(all) ? all : [])
        .filter(profile => profile?.id && selectionHas(selection, String(profile.id)))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return toBuffer({ profiles, ...referencedCredentials(directories, settings, profiles) });
}

/** 每组密钥最多保留一个 active，优先保留本机已激活项。 */
function normalizeActive(list, localActiveId) {
    let kept = false;
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const shouldKeep = localActiveId ? item.id === localActiveId : (!kept && item.active === true);
        item.active = shouldKeep && !kept;
        if (item.active) kept = true;
    }
    // 本机无已激活项时选中第一项。
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
    // 保留本机当前连接的 selectedProfile。
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

/** 本地虚拟路径：api-profiles/<配置名>.json */
function apiLocalPath(folder) {
    return `${API_DIR}/${folder}.json`;
}

/** 是不是「某一个 API 配置档」的合成文件路径。 */
function isApiProfilePath(localRel) {
    const parts = String(localRel || '').split('/');
    return parts.length === 2
        && parts[0] === API_DIR
        && parts[1].length > 5
        && parts[1].toLowerCase().endsWith('.json');
}

/** 从 api-profiles/我的Claude.json 取出「我的Claude」。 */
function apiFolderOf(localRel) {
    if (!isApiProfilePath(localRel)) return '';
    return String(localRel).slice(API_DIR.length + 1, -'.json'.length);
}

/** 生成单档 API 配置及其密钥与代理设置。 */
function buildApiProfile(directories, id) {
    return buildApiProfiles(directories, { all: false, selected: [String(id)] });
}

/** 范围内的配置档各占一个合成文件。folders 是 配置档 id → 远端文件名。 */
function listApiProfileFiles(directories, selection, folders = {}) {
    return listApiProfiles(directories)
        .filter(item => selectionHas(selection, item.value))
        .map(item => ({
            localRel: apiLocalPath(folders[item.value] || item.value),
            id: item.value,
        }));
}

function isSynthetic(localRel) {
    return isPersonaPath(localRel) || isApiProfilePath(localRel);
}

/** 通过 names 将云端名称映射回头像文件名或配置档 id。 */
function build(localRel, directories, names) {
    if (isPersonaPath(localRel)) {
        const folder = personaFolderOf(localRel);
        const avatar = names?.personas?.toAvatar?.[folder];
        if (!avatar) throw new Error(`本机找不到这个人设：${folder}`);
        return buildPersona(directories, avatar);
    }
    if (isApiProfilePath(localRel)) {
        const folder = apiFolderOf(localRel);
        const id = names?.profiles?.toId?.[folder];
        if (!id) throw new Error(`本机找不到这个 API 配置：${folder}`);
        return buildApiProfile(directories, id);
    }
    throw new Error(`不是合成文件：${localRel}`);
}

function merge(localRel, directories, buffer) {
    if (isPersonaPath(localRel)) return mergePersona(directories, buffer);
    // 使用通用配置合并逻辑处理单档文件。
    if (isApiProfilePath(localRel)) return mergeApiProfiles(directories, buffer);
    throw new Error(`不是合成文件：${localRel}`);
}

module.exports = {
    SETTINGS_FILE,
    PERSONAS_DIR,
    PERSONA_FILE,
    API_DIR,
    isSynthetic,
    isPersonaPath,
    personaFolderOf,
    personaLocalPath,
    listPersonaFiles,
    isApiProfilePath,
    apiFolderOf,
    apiLocalPath,
    listApiProfileFiles,
    build,
    merge,
    listPersonas,
    localPersonaNames,
    listApiProfiles,
    // 供单元测试
    stableJson,
    mergeBy,
    normalizeActive,
};
