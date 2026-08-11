/**
 * 路径与范围：本地相对路径 ↔ 远端相对路径的双向映射，以及"这个文件在不在备份范围内"。
 *
 * 本地一侧沿用 SillyTavern 自己的目录名（characters / chats / worlds …），
 * 远端一侧换成四个中文文件夹，让网盘里一眼能看懂：
 *
 *   角色卡/<角色名>.png                ← 按角色名存，不是本地的 avatar 文件名
 *   聊天记录/<角色名>/<聊天文件>.jsonl   ← 目录名同样换成角色名
 *   聊天记录/_群聊/…  聊天记录/_群组/…
 *   世界书/<世界书名>.json             ← 只有独立世界书；内嵌在 png 里的跟着角色卡走
 *   设置/settings.json
 *
 * 角色名由前端随请求带上（酒馆前端才知道 png 里的角色叫什么），后端只负责去重与转义。
 */
const path = require('node:path');
const crypto = require('node:crypto');

// 本地顶层目录 → SillyTavern 的目录键
const ROOTS = [
    { prefix: 'characters', dirKey: 'characters' },
    { prefix: 'chats', dirKey: 'chats' },
    { prefix: 'group chats', dirKey: 'groupChats' },
    { prefix: 'groups', dirKey: 'groups' },
    { prefix: 'worlds', dirKey: 'worlds' },
];

const SETTINGS_FILE = 'settings.json';

// 远端四个中文文件夹
const REMOTE_CHARACTERS = '角色卡';
const REMOTE_CHATS = '聊天记录';
const REMOTE_WORLDS = '世界书';
const REMOTE_SETTINGS = '设置';
// 群聊不隶属任何角色卡，收在聊天记录下面单开两层，前缀下划线避免与角色名撞车
const REMOTE_GROUP_CHATS = '_群聊';
const REMOTE_GROUPS = '_群组';

const REMOTE_TOP = [REMOTE_CHARACTERS, REMOTE_CHATS, REMOTE_WORLDS, REMOTE_SETTINGS];

// 只处理在 WebDAV / Windows 上真正非法的字符。空格与连字符必须保留，
// 因为 SillyTavern 的聊天文件名形如 "2026-08-01 12h30m.jsonl"。
const ILLEGAL_SEGMENT = /[\\/:*?"<>|]/g;

function sha8(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/** 把单个路径段转成远端可用的名字，改动过就补哈希避免不同名字压成同一个。 */
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

// ---------------------------------------------------------------------------
// 角色名索引
// ---------------------------------------------------------------------------

/**
 * 由前端传来的 { avatar 文件名: 角色名 } 建索引。
 *
 * 同名角色会撞车（两张卡取了同一个名字），按 avatar 排序后给后来者加序号，
 * 保证同一批输入每次算出来的名字都一样，不会这次是原名下次变成带序号的。
 */
function buildNameIndex(characterNames = {}) {
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

    return { byAvatar, byStem, toAvatar };
}

// ---------------------------------------------------------------------------
// 本地 → 远端
// ---------------------------------------------------------------------------

/**
 * 本地相对路径 → 远端相对路径。认不出来的返回 null（调用方会跳过）。
 * names 是 buildNameIndex 的产物；没有对应角色名时退回文件名本身。
 */
function toRemote(localRel, names) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return null;

    if (parts.length === 1 && parts[0] === SETTINGS_FILE) {
        return `${REMOTE_SETTINGS}/${SETTINGS_FILE}`;
    }

    const [root, ...rest] = parts;
    if (!rest.length) return null;

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

        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// 远端 → 本地
// ---------------------------------------------------------------------------

/**
 * 远端相对路径 → 本地相对路径。
 * 角色名能对回本机某张卡就用那张卡的 avatar；对不上（换了台机器）就按角色名新建，
 * 酒馆会把它当作一张名字正确的新卡，不会丢内容。
 */
function toLocal(remoteRel, names) {
    const parts = String(remoteRel || '').split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const [top, ...rest] = parts;

    switch (top) {
        case REMOTE_SETTINGS:
            return rest.length === 1 && rest[0] === SETTINGS_FILE ? SETTINGS_FILE : null;

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

        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// 范围
// ---------------------------------------------------------------------------

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

/** 本地相对路径是否在当前范围内。 */
function inScope(localRel, scope) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return false;

    if (parts.length === 1 && parts[0] === SETTINGS_FILE) {
        return scope.settings?.enabled === true;
    }

    const [root, ...rest] = parts;
    if (!rest.length) return false;

    switch (root) {
        case 'characters':
            return selectionHas(scope.characters, rest[0])
                || (rest.length > 1 && selectionHasStem(scope.characters, rest[0]));

        case 'chats':
            // 聊天记录跟随角色卡的选择：目录名 = 角色卡文件名去扩展名
            return scope.chats?.enabled === true && selectionHasStem(scope.characters, rest[0]);

        case 'group chats':
        case 'groups':
            return scope.chats?.enabled === true;

        case 'worlds': {
            const name = stemOf(rest[0]);
            // 已内嵌在角色卡里的世界书面板上根本没列出来，「全选」时也不该偷偷传一份；
            // 用户显式勾了的（all=false）则尊重用户选择，照传不误。
            if (scope.worlds?.all && Array.isArray(scope.worlds.exclude)
                && scope.worlds.exclude.includes(name)) {
                return false;
            }
            return selectionHas(scope.worlds, name);
        }

        default:
            return false;
    }
}

/**
 * 本地相对路径属于哪一类。前端据此决定下载后要热刷新哪个列表 ——
 * 角色卡刷角色列表、世界书刷世界书列表，都不必整页重载。
 */
function categoryOf(localRel) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return 'other';
    if (parts.length === 1 && parts[0] === SETTINGS_FILE) return 'settings';
    switch (parts[0]) {
        case 'characters': return 'characters';
        case 'worlds': return 'worlds';
        case 'chats':
        case 'group chats':
        case 'groups': return 'chats';
        default: return 'other';
    }
}

/** 当前范围下需要扫描的本地目录。 */
function scanRoots(directories, scope) {
    const roots = [];
    const charactersOn = !selectionEmpty(scope.characters);
    const chatsOn = scope.chats?.enabled === true;

    for (const root of ROOTS) {
        const dir = directories[root.dirKey];
        if (!dir) continue;
        if (root.prefix === 'characters' && !charactersOn) continue;
        if (root.prefix === 'chats' && !(chatsOn && charactersOn)) continue;
        if ((root.prefix === 'group chats' || root.prefix === 'groups') && !chatsOn) continue;
        if (root.prefix === 'worlds' && selectionEmpty(scope.worlds)) continue;
        roots.push({ prefix: root.prefix, dir });
    }
    return roots;
}

/** 本地相对路径 → 绝对路径；越界或不认识的前缀返回 null。 */
function localAbsPath(directories, localRel) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return null;

    if (parts.length === 1 && parts[0] === SETTINGS_FILE) {
        return path.join(directories.root, SETTINGS_FILE);
    }

    const root = ROOTS.find(item => item.prefix === parts[0]);
    if (!root) return null;
    const base = directories[root.dirKey];
    if (!base || parts.length < 2) return null;

    const target = path.resolve(base, parts.slice(1).join('/'));
    const relative = path.relative(path.resolve(base), target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return target;
}

/** "当前已选择同步范围：xxx" 里的那段 xxx。 */
function describeScope(scope) {
    const parts = [];
    if (scope.characters?.all) parts.push('角色卡 全部');
    else if (scope.characters?.selected?.length) parts.push(`角色卡 ${scope.characters.selected.length} 张`);

    if (scope.chats?.enabled) parts.push('聊天记录');

    if (scope.worlds?.all) parts.push('世界书 全部');
    else if (scope.worlds?.selected?.length) parts.push(`世界书 ${scope.worlds.selected.length} 本`);

    if (scope.settings?.enabled) parts.push('设置');

    return parts.length ? parts.join('、') : '未选择任何内容';
}

module.exports = {
    SETTINGS_FILE,
    REMOTE_CHARACTERS,
    REMOTE_CHATS,
    REMOTE_WORLDS,
    REMOTE_SETTINGS,
    REMOTE_GROUP_CHATS,
    REMOTE_GROUPS,
    REMOTE_TOP,
    safeSegment,
    stemOf,
    buildNameIndex,
    toRemote,
    toLocal,
    inScope,
    categoryOf,
    scanRoots,
    localAbsPath,
    describeScope,
    selectionEmpty,
};
