/**
 * 合成文件：备份链路里"看起来是一个文件、实际不在磁盘上"的那几样。
 *
 * 用户人设与 API 连接配置都没有自己的文件 —— 它们是 settings.json 里的几个字段
 * （外加 secrets.json 里的密钥）。整份 settings.json 传上网盘再整份盖回来，
 * 会连界面偏好、当前模型这些设备相关的东西一起覆盖，所以这里只抽需要的字段，
 * 拼成一个虚拟文件参与备份，下载时**逐键合并**回去，不动其余部分。
 *
 *   personas/<人设名>.json      power_user 里某一个人设的名字、描述与注入设置
 *                               （头像是真实文件，走普通目录，不在这里）
 *   api-profiles/<配置名>.json  某一个 connectionManager 配置档 + 它引用到的密钥与代理预设
 *
 * 这两类都是**一项一份**：勾一个人设就只拼那一个人设，下载时也只合并那一个，
 * 本机其他人设与配置档一个字都不会被动到。早先的版本各挤在一份
 * personas.json / api-profiles.json 里，那种整份文件现在只读不写（见文件末尾 FILES）。
 *
 * 关于密钥：API 配置文件里带**明文** API key 与代理密码。这是插件使用者
 * 明确要求的 —— 备份目标是自己的私人网盘，换设备时不必重填一遍。
 * 只有被勾中的那几个配置档引用到的密钥会被带上，没引用的一个都不碰。
 */
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE = 'settings.json';
const SECRETS_FILE = 'secrets.json';

const PERSONAS_FILE = 'personas.json';
const API_PROFILES_FILE = 'api-profiles.json';

// 每个人设各是一个合成文件，本地虚拟路径形如 personas/沈知微.json，
// 落到网盘上是 用户人设/沈知微/persona.json。
// 「personas」这一段只是个虚拟前缀，酒馆数据目录下并没有这个文件夹。
const PERSONAS_DIR = 'personas';
const PERSONA_FILE = 'persona.json';

// API 配置同理，一档一份：本地 api-profiles/我的Claude.json → 网盘 API配置/我的Claude.json。
// 它没有附属文件（密钥就写在这份 json 里），所以不像人设那样还要套一层文件夹。
const API_DIR = 'api-profiles';

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

/**
 * 从 power_user.personas 的一个值里取出能显示的人设名。
 * 正常是字符串，但旧版本酒馆与别的插件写过对象形态，硬 String() 会变成
 * "[object Object]" 摆在列表里，所以这里逐个字段试一遍。
 */
function personaNameOf(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
        for (const key of ['name', 'title', 'label']) {
            if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
        }
    }
    return '';
}

/**
 * 列表用的短标签：折掉换行，过长截断。
 * 有人把整段人设描述当名字填进去，原样显示会把一行撑成一屏。
 */
function shortLabel(text, limit = 40) {
    const line = String(text).replace(/\s+/g, ' ').trim();
    return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * 供范围弹窗渲染：一个人设一条。
 *
 * 以磁盘上真实存在的头像文件为准 —— 酒馆的人设面板也是这么列的。
 * settings.json 的 power_user.personas 里会残留头像早被删掉的旧条目，
 * 按那份字典列会多出一堆用户在酒馆里根本看不到的幽灵，看起来就像
 * "同一个人设重复了好几条"。
 *
 * 名字允许重名（一个人可以有多个头像），所以 note 里始终带上头像文件名，
 * 否则两条一模一样的行没法区分该勾哪个。
 */
function listPersonas(directories) {
    const settings = readJson(settingsPath(directories), {});
    const named = settings.power_user?.personas;
    const all = named && typeof named === 'object' ? named : {};
    const files = listAvatarFiles(directories);

    // 头像目录读不到（权限、路径异常）时退回按字典列，宁可多列也别让弹窗空着
    const avatars = files.length ? files : Object.keys(all);

    return avatars
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
    const settings = readJson(settingsPath(directories), {});
    const all = settings.power_user?.personas;
    if (!all || typeof all !== 'object') return {};
    const out = {};
    for (const [avatar, value] of Object.entries(all)) {
        const name = personaNameOf(value);
        if (name) out[avatar] = name;
    }
    return out;
}

/**
 * 一份 personas.json（本地拼的或刚从网盘拉下来的）里的 头像文件名 → 人设名。
 * 云端文件列表要靠它把「1712345678901.png」显示成人看得懂的名字。
 */
function personaNamesFromBuffer(buffer) {
    try {
        const data = parseBuffer(buffer);
        const all = data?.personas;
        if (!all || typeof all !== 'object') return {};
        const out = {};
        for (const [avatar, value] of Object.entries(all)) {
            const name = personaNameOf(value);
            if (name) out[avatar] = name;
        }
        return out;
    } catch {
        return {};
    }
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

/**
 * 一个人设的全部数据：名字、描述与注入设置、以及它是不是默认人设。
 *
 * avatar 写在文件里而不是只靠路径 —— 换台机器时远端文件夹名（人设名）可能
 * 撞车加了后缀，路径不可靠；文件内容里的头像文件名才是这个人设的真身。
 */
function buildPersona(directories, avatar) {
    const settings = readJson(settingsPath(directories), {});
    const power = settings.power_user || {};
    return toBuffer({
        avatar,
        name: personaNameOf(power.personas?.[avatar]),
        description: power.persona_descriptions?.[avatar] ?? null,
        isDefault: power.default_persona === avatar,
    });
}

/** 合并一个人设回本机。只动这一个人设，别人的一个字都不碰。 */
function mergePersona(directories, buffer) {
    const incoming = parseBuffer(buffer);
    const avatar = typeof incoming?.avatar === 'string' ? incoming.avatar.trim() : '';
    // 头像文件名会被拿去当 settings.json 里的键，也会用来找头像图，必须是干净的一段
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

    const name = personaNameOf(incoming.name);
    // 名字为空时不要把本机原有的名字擦成空 —— 宁可保留旧名，也别让它变成 [Unnamed Persona]
    if (name) power.personas[avatar] = name;
    else if (power.personas[avatar] === undefined) power.personas[avatar] = '';

    if (incoming.description && typeof incoming.description === 'object') {
        power.persona_descriptions[avatar] = incoming.description;
    }
    if (incoming.isDefault === true) power.default_persona = avatar;

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

/**
 * 范围内的人设各占一个合成文件。folders 是 avatar → 远端文件夹名
 * （由 paths.buildPersonaIndex 算出，两边必须用同一份，否则上传的路径对不上）。
 */
function listPersonaFiles(directories, selection, folders = {}) {
    return listPersonas(directories)
        .filter(item => selectionHas(selection, item.value))
        .map(item => ({
            localRel: personaLocalPath(folders[item.value] || item.value),
            avatar: item.value,
        }));
}

// ---------------------------------------------------------------------------
// 旧布局：整份 personas.json
//
// 早先的版本把所有人设塞进一个 用户人设/personas.json。现在不再往上传这种文件，
// 但网盘里已经有的那一份还得能读回来 —— 下面两个函数只为兼容旧备份而留。
// 注意它是"一勾就全都来"的语义，这正是拆成一人一份的原因。
// ---------------------------------------------------------------------------

function buildPersonas(directories, selection) {
    const settings = readJson(settingsPath(directories), {});
    const power = settings.power_user || {};
    const all = power.personas && typeof power.personas === 'object' ? power.personas : {};

    const personas = {};
    const descriptions = {};
    // 名字与描述分居两张字典，取并集遍历 —— 只有描述没有名字的人设（酒馆里显示为
    // [Unnamed Persona]）也得把描述带上，否则换台机器又是一份空壳
    const keys = new Set([...Object.keys(all), ...Object.keys(power.persona_descriptions || {})]);
    for (const avatar of [...keys].sort()) {
        if (!selectionHas(selection, avatar)) continue;
        if (all[avatar] !== undefined) personas[avatar] = all[avatar];
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

/**
 * 单个配置档，文件格式与旧的整份 api-profiles.json 完全一致，只是里面只有一档
 * （连同它引用到的密钥与代理预设）。合并因此可以直接复用 mergeApiProfiles。
 */
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

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

// 旧布局：所有人设挤一份、所有 API 配置挤一份。不再产出，只为读回网盘上已有的
const FILES = {
    [PERSONAS_FILE]: { group: 'personas', build: buildPersonas, merge: mergePersonas },
    [API_PROFILES_FILE]: { group: 'apiProfiles', build: buildApiProfiles, merge: mergeApiProfiles },
};

function isSynthetic(localRel) {
    return isPersonaPath(localRel)
        || isApiProfilePath(localRel)
        || Object.prototype.hasOwnProperty.call(FILES, String(localRel));
}

/**
 * 某一类范围对应的旧版单文件名，没有就返回空串。
 * 人设与 API 配置都已拆成一项一份，不再有单一文件名 —— 走 listPersonaFiles /
 * listApiProfileFiles。这个函数只剩兼容用途。
 */
function fileOfGroup(group) {
    if (group === 'personas' || group === 'apiProfiles') return '';
    const found = Object.entries(FILES).find(([, meta]) => meta.group === group);
    return found ? found[0] : '';
}

/** names 用来把远端那个"人看得懂的名字"反查回真身（头像文件名 / 配置档 id）。 */
function build(localRel, directories, scope, names) {
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
    const meta = FILES[localRel];
    if (!meta) throw new Error(`不是合成文件：${localRel}`);
    return meta.build(directories, scope[meta.group]);
}

function merge(localRel, directories, buffer) {
    if (isPersonaPath(localRel)) return mergePersona(directories, buffer);
    // 单档与整份的文件格式一致，合并逻辑照旧
    if (isApiProfilePath(localRel)) return mergeApiProfiles(directories, buffer);
    const meta = FILES[localRel];
    if (!meta) throw new Error(`不是合成文件：${localRel}`);
    return meta.merge(directories, buffer);
}

module.exports = {
    SETTINGS_FILE,
    PERSONAS_FILE,
    PERSONAS_DIR,
    PERSONA_FILE,
    API_PROFILES_FILE,
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
    fileOfGroup,
    build,
    merge,
    listPersonas,
    localPersonaNames,
    personaNamesFromBuffer,
    listApiProfiles,
    // 供单元测试
    stableJson,
    mergeBy,
    normalizeActive,
};
