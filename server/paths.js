/**
 * 本地与云端路径映射，以及备份范围判定。
 * 云端目录：
 *   角色卡/<角色名>.png
 *   聊天记录/<角色名>/<聊天文件>.jsonl；_群聊/ 与 _群组/ 存放群聊数据
 *   用户人设/<人设名>/persona.json 及头像
 *   预设/<酒馆目录名>/、美化/<酒馆目录名>/
 *   世界书/<世界书名>.json
 *   API配置/<配置名>.json
 * 角色名映射来自前端，人设名与配置名由 buildNameIndex 从本机读取。
 */
const path = require('node:path');
const crypto = require('node:crypto');

const synthetic = require('./synthetic.js');

// 本地顶层目录到 SillyTavern 目录键的映射。
// group 为范围类别，label 为显示名，detail 控制是否提供文件明细。
const ROOTS = [
    { prefix: 'characters', dirKey: 'characters', group: 'characters' },
    { prefix: 'chats', dirKey: 'chats', group: 'chats' },
    { prefix: 'group chats', dirKey: 'groupChats', group: 'chats' },
    { prefix: 'groups', dirKey: 'groups', group: 'chats' },
    { prefix: 'worlds', dirKey: 'worlds', group: 'worlds' },

    // 用户人设的头像。人设的名字与描述在 settings.json 里，走合成文件
    { prefix: 'User Avatars', dirKey: 'avatars', group: 'personas' },

    // 预设
    { prefix: 'OpenAI Settings', dirKey: 'openAI_Settings', group: 'presets', label: 'OpenAI 预设', detail: true },
    { prefix: 'QuickReplies', dirKey: 'quickreplies', group: 'presets', label: '快速回复', detail: true },

    // 美化
    { prefix: 'themes', dirKey: 'themes', group: 'themes', label: 'UI 主题', detail: true },
    { prefix: 'backgrounds', dirKey: 'backgrounds', group: 'themes', label: '背景图', detail: false },
];

const ROOT_BY_PREFIX = new Map(ROOTS.map(root => [root.prefix, root]));

// 预设与美化：这两组按目录分别持有一份文件级选择集
const DIR_GROUPS = ['presets', 'themes'];

/** 某一类范围下有哪些目录，供前端渲染二级多选列表。 */
function rootsOfGroup(group) {
    return ROOTS.filter(root => root.group === group);
}

/** 预设/美化某个目录的选择集：scope.presets['openAI_Settings'] 这一层。 */
function dirSelection(scope, group, dirKey) {
    return scope?.[group]?.[dirKey];
}

// 云端七个备份目录。
const REMOTE_CHARACTERS = '角色卡';
const REMOTE_CHATS = '聊天记录';
const REMOTE_PERSONAS = '用户人设';
const REMOTE_PRESETS = '预设';
const REMOTE_THEMES = '美化';
const REMOTE_WORLDS = '世界书';
const REMOTE_API = 'API配置';
// 群聊与群组使用聊天记录下的独立目录。
const REMOTE_GROUP_CHATS = '_群聊';
const REMOTE_GROUPS = '_群组';

const REMOTE_TOP = [
    REMOTE_CHARACTERS, REMOTE_CHATS, REMOTE_PERSONAS,
    REMOTE_PRESETS, REMOTE_THEMES, REMOTE_WORLDS, REMOTE_API,
];

// 远端顶层文件夹 → 它下面第二层该出现哪一组目录
const REMOTE_GROUP_TOPS = {
    [REMOTE_PRESETS]: 'presets',
    [REMOTE_THEMES]: 'themes',
};

// 过滤非法路径字符，保留空格与连字符。
const ILLEGAL_SEGMENT = /[\\/:*?"<>|]/g;

function sha8(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/** 规范化路径段；发生替换时追加短哈希。 */
function safeSegment(name) {
    const raw = String(name);
    const cleaned = raw.replace(ILLEGAL_SEGMENT, '_').replace(/[.\s]+$/, '');
    if (!cleaned) return `_${sha8(raw)}`;
    if (cleaned === raw) return cleaned;
    return `${cleaned}~${sha8(raw)}`;
}

/** 去掉扩展名。角色卡文件名去掉扩展名，就是它的聊天目录名与附件目录名。 */
function stemOf(fileName) {
    const name = String(fileName || '');
    const ext = path.posix.extname(name);
    return ext ? name.slice(0, -ext.length) : name;
}

// 角色名索引

/**
 * 构建头像文件名与云端人设目录名的双向索引。
 * 同名人设按头像文件名排序后追加序号。
 */
function buildPersonaIndex(directories) {
    const byAvatar = {};
    const toAvatar = {};
    if (!directories) return { byAvatar, toAvatar };

    const used = new Set();
    const list = synthetic.listPersonas(directories)
        .slice()
        .sort((a, b) => String(a.value).localeCompare(String(b.value)));

    for (const item of list) {
        const raw = String(item.fullName || '').trim() || `未命名人设 ${stemOf(item.value)}`;
        let folder = safeSegment(raw);
        if (used.has(folder)) {
            let n = 2;
            while (used.has(`${folder} (${n})`)) n++;
            folder = `${folder} (${n})`;
        }
        used.add(folder);
        byAvatar[item.value] = folder;
        toAvatar[folder] = item.value;
    }

    return { byAvatar, toAvatar };
}

/** 构建配置档 id 与云端文件名的双向索引；同名配置按 id 排序后追加序号。 */
function buildProfileIndex(directories) {
    const byId = {};
    const toId = {};
    if (!directories) return { byId, toId };

    const used = new Set();
    const list = synthetic.listApiProfiles(directories)
        .slice()
        .sort((a, b) => String(a.value).localeCompare(String(b.value)));

    for (const item of list) {
        const raw = String(item.label || '').trim() || String(item.value);
        let name = safeSegment(raw);
        if (used.has(name)) {
            let n = 2;
            while (used.has(`${name} (${n})`)) n++;
            name = `${name} (${n})`;
        }
        used.add(name);
        byId[item.value] = name;
        toId[name] = item.value;
    }

    return { byId, toId };
}

/**
 * 构建角色名索引，同名角色按 avatar 排序后追加序号。
 * 同时从 directories 读取人设与 API 配置名称。
 */
function buildNameIndex(characterNames = {}, directories = null) {
    const byAvatar = {};
    const byStem = {};
    const toAvatar = {};
    const used = new Set();

    const avatars = Object.keys(characterNames || {}).filter(Boolean).sort();
    for (const avatar of avatars) {
        const raw = String(characterNames[avatar] || '').trim() || stemOf(avatar);
        let name = safeSegment(raw);
        if (used.has(name)) {
            let n = 2;
            while (used.has(`${name} (${n})`)) n++;
            name = `${name} (${n})`;
        }
        used.add(name);
        byAvatar[avatar] = name;
        byStem[stemOf(avatar)] = name;
        toAvatar[name] = avatar;
    }

    return {
        byAvatar,
        byStem,
        toAvatar,
        personas: buildPersonaIndex(directories),
        profiles: buildProfileIndex(directories),
    };
}

// 本地 → 远端

/**
 * 本地相对路径 → 远端相对路径。认不出来的返回 null（调用方会跳过）。
 * names 是 buildNameIndex 的产物；没有对应角色名时退回文件名本身。
 */
function toRemote(localRel, names) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return null;

    const [root, ...rest] = parts;
    if (!rest.length) return null;

    // 一个人设一个文件夹：personas/沈知微.json → 用户人设/沈知微/persona.json
    if (synthetic.isPersonaPath(localRel)) {
        return [REMOTE_PERSONAS, synthetic.personaFolderOf(localRel), synthetic.PERSONA_FILE].join('/');
    }

    // 一个 API 配置一个文件：api-profiles/我的Claude.json → API配置/我的Claude.json
    if (synthetic.isApiProfilePath(localRel)) {
        return [REMOTE_API, `${synthetic.apiFolderOf(localRel)}.json`].join('/');
    }

    switch (root) {
        case 'characters': {
            // 只有一段是角色卡本体（characters/<avatar>），更深的是它的附件目录
            const isCard = rest.length === 1;
            const key = rest[0];
            const display = isCard
                ? (names.byAvatar[key] || safeSegment(stemOf(key)))
                : (names.byStem[key] || safeSegment(key));
            const head = isCard ? `${display}${path.posix.extname(key)}` : display;
            const tail = rest.slice(1).map(safeSegment);
            return [REMOTE_CHARACTERS, head, ...tail].join('/');
        }

        case 'chats': {
            const display = names.byStem[rest[0]] || safeSegment(rest[0]);
            return [REMOTE_CHATS, display, ...rest.slice(1).map(safeSegment)].join('/');
        }

        case 'group chats':
            return [REMOTE_CHATS, REMOTE_GROUP_CHATS, ...rest.map(safeSegment)].join('/');

        case 'groups':
            return [REMOTE_CHATS, REMOTE_GROUPS, ...rest.map(safeSegment)].join('/');

        case 'worlds':
            return [REMOTE_WORLDS, ...rest.map(safeSegment)].join('/');

        case 'User Avatars': {
            // 头像写入所属人设目录；未登记的头像使用文件名作为目录名。
            const folder = names.personas?.byAvatar?.[rest[0]] || safeSegment(stemOf(rest[0]));
            return [REMOTE_PERSONAS, folder, ...rest.map(safeSegment)].join('/');
        }

        default: {
            // 预设与美化的第二层保留酒馆目录名。
            const meta = ROOT_BY_PREFIX.get(root);
            if (meta?.group === 'presets') {
                return [REMOTE_PRESETS, meta.prefix, ...rest.map(safeSegment)].join('/');
            }
            if (meta?.group === 'themes') {
                return [REMOTE_THEMES, meta.prefix, ...rest.map(safeSegment)].join('/');
            }
            return null;
        }
    }
}

// 远端 → 本地

/**
 * 将云端路径映射为本地相对路径。
 * 已知角色名映射到本机 avatar，未知角色名直接作为新文件名。
 */
function toLocal(remoteRel, names) {
    const parts = String(remoteRel || '').split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const [top, ...rest] = parts;

    switch (top) {
        case REMOTE_API: {
            if (rest.length !== 1) return null;
            if (!rest[0].toLowerCase().endsWith('.json')) return null;
            return synthetic.apiLocalPath(rest[0].slice(0, -'.json'.length));
        }

        case REMOTE_PERSONAS: {
            // 用户人设/<人设名>/persona.json + 用户人设/<人设名>/<头像文件>
            if (rest.length !== 2) return null;
            return rest[1] === synthetic.PERSONA_FILE
                ? synthetic.personaLocalPath(rest[0])
                : `User Avatars/${rest[1]}`;
        }

        case REMOTE_CHARACTERS: {
            const isCard = rest.length === 1;
            if (isCard) {
                const avatar = names.toAvatar[stemOf(rest[0])];
                return `characters/${avatar || rest[0]}`;
            }
            const avatar = names.toAvatar[rest[0]];
            const stem = avatar ? stemOf(avatar) : rest[0];
            return ['characters', stem, ...rest.slice(1)].join('/');
        }

        case REMOTE_CHATS: {
            if (rest[0] === REMOTE_GROUP_CHATS) {
                return rest.length > 1 ? ['group chats', ...rest.slice(1)].join('/') : null;
            }
            if (rest[0] === REMOTE_GROUPS) {
                return rest.length > 1 ? ['groups', ...rest.slice(1)].join('/') : null;
            }
            if (rest.length < 2) return null;
            const avatar = names.toAvatar[rest[0]];
            const stem = avatar ? stemOf(avatar) : rest[0];
            return ['chats', stem, ...rest.slice(1)].join('/');
        }

        case REMOTE_WORLDS:
            return ['worlds', ...rest].join('/');

        default: {
            // 将预设与美化的第二层限定为所属组的目录。
            const group = REMOTE_GROUP_TOPS[top];
            if (!group || rest.length < 2) return null;
            const meta = ROOT_BY_PREFIX.get(rest[0]);
            if (!meta || meta.group !== group) return null;
            return [meta.prefix, ...rest.slice(1)].join('/');
        }
    }
}

// 范围

/** 选择集是否命中某个名字。 */
function selectionHas(selection, name) {
    if (!selection) return false;
    if (selection.all) return true;
    return Array.isArray(selection.selected) && selection.selected.includes(name);
}

/** 选择集是否为空（既没全选也没选具体项）。 */
function selectionEmpty(selection) {
    return !selection?.all && !(selection?.selected?.length > 0);
}

/** 角色选择集是否命中某个角色目录名（avatar 去扩展名的那种）。 */
function selectionHasStem(selection, stem) {
    if (!selection) return false;
    if (selection.all) return true;
    return Array.isArray(selection.selected) && selection.selected.some(avatar => stemOf(avatar) === stem);
}

/** 判断本地相对路径是否在范围内；names 提供人设与 API 配置名称映射。 */
function inScope(localRel, scope, names) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return false;

    // 按人设选择集判断；本机未登记的人设使用类别开关。
    if (synthetic.isPersonaPath(localRel)) {
        const avatar = names?.personas?.toAvatar?.[synthetic.personaFolderOf(localRel)];
        return avatar ? selectionHas(scope.personas, avatar) : !selectionEmpty(scope.personas);
    }

    // 按配置档选择集判断；本机未登记的配置档使用类别开关。
    if (synthetic.isApiProfilePath(localRel)) {
        const id = names?.profiles?.toId?.[synthetic.apiFolderOf(localRel)];
        return id ? selectionHas(scope.apiProfiles, id) : !selectionEmpty(scope.apiProfiles);
    }

    const [root, ...rest] = parts;
    if (!rest.length) return false;

    switch (root) {
        case 'characters':
            return selectionHas(scope.characters, rest[0])
                || (rest.length > 1 && selectionHasStem(scope.characters, rest[0]));

        case 'chats': {
            // 聊天记录跟随对应角色卡的选择。
            if (!selectionHasStem(scope.characters, rest[0])) return false;
            const key = rest.join('/');
            // all 包含所选角色的全部聊天，skip 记录逐条排除项。
            if (scope.chats?.all) {
                return !(Array.isArray(scope.chats.skip) && scope.chats.skip.includes(key));
            }
            return selectionHas(scope.chats, key);
        }

        case 'group chats':
        case 'groups':
            // 群聊与群组仅在全部聊天模式下纳入。
            return scope.chats?.all === true;

        case 'worlds': {
            const name = stemOf(rest[0]);
            // 世界书全选时应用排除名单，逐项选择时按 selected 判断。
            if (scope.worlds?.all && Array.isArray(scope.worlds.exclude)
                && scope.worlds.exclude.includes(name)) {
                return false;
            }
            return selectionHas(scope.worlds, name);
        }

        case 'User Avatars':
            // 头像跟随人设选择；本机未登记的头像使用类别开关。
            return selectionHas(scope.personas, rest[0])
                || (!names?.personas?.byAvatar?.[rest[0]] && !selectionEmpty(scope.personas));

        default: {
            // 预设与美化：每个目录各持一份文件级选择集，按目录内相对路径判定
            const meta = ROOT_BY_PREFIX.get(root);
            if (!meta || !DIR_GROUPS.includes(meta.group)) return false;
            const selection = dirSelection(scope, meta.group, meta.dirKey);
            const file = rest.join('/');
            // 整目录全选时应用自带文件排除名单，逐项选择时按 selected 判断。
            if (selection?.all && Array.isArray(selection.exclude) && selection.exclude.includes(file)) {
                return false;
            }
            return selectionHas(selection, file);
        }
    }
}

/** 返回本地文件所属类别，供前端按类别刷新。 */
function categoryOf(localRel) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return 'other';
    if (synthetic.isPersonaPath(localRel)) return 'personas';
    if (synthetic.isApiProfilePath(localRel)) return 'apiProfiles';
    if (parts.length === 1) return 'other';
    switch (parts[0]) {
        case 'characters': return 'characters';
        case 'worlds': return 'worlds';
        case 'chats':
        case 'group chats':
        case 'groups': return 'chats';
        default: return ROOT_BY_PREFIX.get(parts[0])?.group || 'other';
    }
}

/** 当前范围下需要扫描的本地目录。 */
function scanRoots(directories, scope) {
    const roots = [];
    const charactersOn = !selectionEmpty(scope.characters);
    const chatsOn = !selectionEmpty(scope.chats);

    for (const root of ROOTS) {
        const dir = directories[root.dirKey];
        if (!dir) continue;
        if (root.prefix === 'characters' && !charactersOn) continue;
        // 仅在已选择角色卡时扫描单人聊天目录。
        if (root.prefix === 'chats' && !(chatsOn && charactersOn)) continue;
        if ((root.prefix === 'group chats' || root.prefix === 'groups')
            && scope.chats?.all !== true) continue;
        if (root.prefix === 'worlds' && selectionEmpty(scope.worlds)) continue;
        if (root.group === 'personas' && selectionEmpty(scope.personas)) continue;
        if (DIR_GROUPS.includes(root.group)
            && selectionEmpty(dirSelection(scope, root.group, root.dirKey))) continue;
        roots.push({ prefix: root.prefix, dir });
    }
    return roots;
}

/** 本地相对路径 → 绝对路径；越界或不认识的前缀返回 null。 */
function localAbsPath(directories, localRel) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return null;

    // 将合成路径映射到 settings.json。
    if (synthetic.isPersonaPath(localRel) || synthetic.isApiProfilePath(localRel)) {
        return path.join(directories.root, synthetic.SETTINGS_FILE);
    }
    if (parts.length === 1) return null;

    const root = ROOTS.find(item => item.prefix === parts[0]);
    if (!root) return null;
    const base = directories[root.dirKey];
    if (!base || parts.length < 2) return null;

    const target = path.resolve(base, parts.slice(1).join('/'));
    const relative = path.relative(path.resolve(base), target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return target;
}

/** 预设/美化某一组的文案片段："OpenAI 预设 全部、UI 主题 3 个"。 */
function describeDirGroup(scope, group) {
    const parts = [];
    for (const root of rootsOfGroup(group)) {
        const selection = dirSelection(scope, group, root.dirKey);
        if (selectionEmpty(selection)) continue;
        // 背景图按整类开关显示。
        if (!root.detail) parts.push(root.label);
        else if (selection.all) parts.push(`${root.label} 全部`);
        else parts.push(`${root.label} ${selection.selected.length} 个`);
    }
    return parts;
}

/** 生成备份范围摘要。 */
function describeScope(scope) {
    const parts = [];
    if (scope.characters?.all) parts.push('角色卡 全部');
    else if (scope.characters?.selected?.length) parts.push(`角色卡 ${scope.characters.selected.length} 张`);

    // 仅在已选择角色卡时显示聊天范围。
    if (!selectionEmpty(scope.characters)) {
        if (scope.chats?.all) {
            const skipped = Array.isArray(scope.chats.skip) ? scope.chats.skip.length : 0;
            parts.push(skipped ? `聊天记录 全部（排除 ${skipped} 条）` : '聊天记录 全部');
        } else if (scope.chats?.selected?.length) {
            parts.push(`聊天记录 ${scope.chats.selected.length} 条`);
        }
    }

    if (scope.personas?.all) parts.push('用户人设 全部');
    else if (scope.personas?.selected?.length) parts.push(`用户人设 ${scope.personas.selected.length} 个`);

    parts.push(...describeDirGroup(scope, 'presets'));
    parts.push(...describeDirGroup(scope, 'themes'));

    if (scope.worlds?.all) parts.push('世界书 全部');
    else if (scope.worlds?.selected?.length) parts.push(`世界书 ${scope.worlds.selected.length} 本`);

    if (scope.apiProfiles?.all) parts.push('API 配置 全部');
    else if (scope.apiProfiles?.selected?.length) parts.push(`API 配置 ${scope.apiProfiles.selected.length} 个`);

    return parts.length ? parts.join('、') : '未选择任何内容';
}

module.exports = {
    REMOTE_CHARACTERS,
    REMOTE_CHATS,
    REMOTE_PERSONAS,
    REMOTE_PRESETS,
    REMOTE_THEMES,
    REMOTE_WORLDS,
    REMOTE_API,
    REMOTE_GROUP_CHATS,
    REMOTE_GROUPS,
    REMOTE_TOP,
    ROOTS,
    DIR_GROUPS,
    rootsOfGroup,
    dirSelection,
    safeSegment,
    stemOf,
    buildNameIndex,
    buildPersonaIndex,
    buildProfileIndex,
    toRemote,
    toLocal,
    inScope,
    categoryOf,
    scanRoots,
    localAbsPath,
    describeScope,
    selectionEmpty,
};
