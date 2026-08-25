/**
 * 路径与范围：本地相对路径 ↔ 远端相对路径的双向映射，以及"这个文件在不在备份范围内"。
 *
 * 本地一侧沿用 SillyTavern 自己的目录名（characters / chats / worlds …），
 * 远端一侧换成六个中文文件夹，让网盘里一眼能看懂：
 *
 *   角色卡/<角色名>.png                ← 按角色名存，不是本地的 avatar 文件名
 *   聊天记录/<角色名>/<聊天文件>.jsonl   ← 目录名同样换成角色名
 *   聊天记录/_群聊/…  聊天记录/_群组/…
 *   用户人设/personas.json             ← 合成文件，见 synthetic.js
 *   用户人设/<头像文件名>.png
 *   预设/OpenAI Settings/…             ← 第二层沿用酒馆的原目录名，往返映射无歧义
 *   美化/themes/…
 *   世界书/<世界书名>.json             ← 只有独立世界书；内嵌在 png 里的跟着角色卡走
 *   API配置/api-profiles.json          ← 合成文件，含明文密钥
 *
 * 角色名由前端随请求带上（酒馆前端才知道 png 里的角色叫什么），后端只负责去重与转义。
 */
const path = require('node:path');
const crypto = require('node:crypto');

const synthetic = require('./synthetic.js');

// 本地顶层目录 → SillyTavern 的目录键。
// group 决定这个目录归哪一类范围，label 是范围弹窗上显示的中文名，
// detail 决定弹窗里要不要展开到具体文件 —— 背景图是图片，列明细没有意义，整类开关就够。
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

const PERSONAS_FILE = synthetic.PERSONAS_FILE;
const API_PROFILES_FILE = synthetic.API_PROFILES_FILE;

// 远端六个中文文件夹
const REMOTE_CHARACTERS = '角色卡';
const REMOTE_CHATS = '聊天记录';
const REMOTE_PERSONAS = '用户人设';
const REMOTE_PRESETS = '预设';
const REMOTE_THEMES = '美化';
const REMOTE_WORLDS = '世界书';
const REMOTE_API = 'API配置';
// 群聊不隶属任何角色卡，收在聊天记录下面单开两层，前缀下划线避免与角色名撞车
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

    // 两个合成文件都是顶层单文件，各自落在自己那类的文件夹里
    if (parts.length === 1) {
        if (parts[0] === PERSONAS_FILE) return `${REMOTE_PERSONAS}/${PERSONAS_FILE}`;
        if (parts[0] === API_PROFILES_FILE) return `${REMOTE_API}/${API_PROFILES_FILE}`;
        return null;
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

        case 'User Avatars':
            // 头像和 personas.json 平铺在同一个文件夹里。头像必是图片，
            // 撞不上 personas.json 这个保留名
            return [REMOTE_PERSONAS, ...rest.map(safeSegment)].join('/');

        default: {
            // 预设与美化：第二层原样用酒馆的目录名，反向查表就能还原，不必转义
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
        case REMOTE_API:
            return rest.length === 1 && rest[0] === API_PROFILES_FILE ? API_PROFILES_FILE : null;

        case REMOTE_PERSONAS: {
            if (rest.length !== 1) return null;
            // 这个文件夹里只有两种东西：人设数据本身，和头像图片
            return rest[0] === PERSONAS_FILE ? PERSONAS_FILE : `User Avatars/${rest[0]}`;
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
            // 预设与美化。第二层必须是这一组里认识的目录名 ——
            // 白名单本身就挡住了 ../ 之类想穿出数据目录的路径
            const group = REMOTE_GROUP_TOPS[top];
            if (!group || rest.length < 2) return null;
            const meta = ROOT_BY_PREFIX.get(rest[0]);
            if (!meta || meta.group !== group) return null;
            return [meta.prefix, ...rest.slice(1)].join('/');
        }
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

    // 合成文件：这一类只要选了任何一项，就得把它传上去
    if (parts.length === 1) {
        if (parts[0] === PERSONAS_FILE) return !selectionEmpty(scope.personas);
        if (parts[0] === API_PROFILES_FILE) return !selectionEmpty(scope.apiProfiles);
        return false;
    }

    const [root, ...rest] = parts;
    if (!rest.length) return false;

    switch (root) {
        case 'characters':
            return selectionHas(scope.characters, rest[0])
                || (rest.length > 1 && selectionHasStem(scope.characters, rest[0]));

        case 'chats': {
            // 聊天记录跟随角色卡的选择：目录名 = 角色卡文件名去扩展名。
            // 没勾这张卡，它的聊天一概不传 —— 免得云端出现无主的聊天记录。
            if (!selectionHasStem(scope.characters, rest[0])) return false;
            const key = rest.join('/');
            // all 是范围弹窗上那个「含聊天记录」批量开关：已选角色的聊天全要，
            // 用户在文件夹里单独取消掉的记在 skip 里。
            // 这样取消一条不必先把全部聊天列出来 —— 明细本来就是展开时才按需加载的。
            if (scope.chats?.all) {
                return !(Array.isArray(scope.chats.skip) && scope.chats.skip.includes(key));
            }
            return selectionHas(scope.chats, key);
        }

        case 'group chats':
        case 'groups':
            // 群聊不隶属任何角色卡，逐条勾选时无从跟随，只在「全部聊天」模式下整体带上
            return scope.chats?.all === true;

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

        case 'User Avatars':
            // 头像跟着人设走：勾了哪个人设就传哪个头像
            return selectionHas(scope.personas, rest[0]);

        default: {
            // 预设与美化：每个目录各持一份文件级选择集，按目录内相对路径判定
            const meta = ROOT_BY_PREFIX.get(root);
            if (!meta || !DIR_GROUPS.includes(meta.group)) return false;
            const selection = dirSelection(scope, meta.group, meta.dirKey);
            const file = rest.join('/');
            // 与世界书同理：整目录全选时跳过酒馆自带的那些（目前只有背景图有排除名单），
            // 用户显式勾了的照传。
            if (selection?.all && Array.isArray(selection.exclude) && selection.exclude.includes(file)) {
                return false;
            }
            return selectionHas(selection, file);
        }
    }
}

/**
 * 本地相对路径属于哪一类。前端据此决定下载后要热刷新哪个列表 ——
 * 角色卡刷角色列表、世界书刷世界书列表，都不必整页重载。
 */
function categoryOf(localRel) {
    const parts = String(localRel || '').split('/').filter(Boolean);
    if (!parts.length) return 'other';
    if (parts.length === 1) {
        if (parts[0] === PERSONAS_FILE) return 'personas';
        if (parts[0] === API_PROFILES_FILE) return 'apiProfiles';
        return 'other';
    }
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
        // 单人聊天的目录名就是角色卡文件名，没选角色卡就无从跟随
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

    // 合成文件最终读写的都是 settings.json，指向它即可 ——
    // 上层的"这个路径能不能对应到酒馆目录"判断也就自然成立
    if (parts.length === 1) {
        return synthetic.isSynthetic(parts[0])
            ? path.join(directories.root, synthetic.SETTINGS_FILE)
            : null;
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

/** 预设/美化某一组的文案片段："OpenAI 预设 全部、UI 主题 3 个"。 */
function describeDirGroup(scope, group) {
    const parts = [];
    for (const root of rootsOfGroup(group)) {
        const selection = dirSelection(scope, group, root.dirKey);
        if (selectionEmpty(selection)) continue;
        // 背景图没有明细可选，只是个整类开关，说"全部"反而让人以为还有别的粒度
        if (!root.detail) parts.push(root.label);
        else if (selection.all) parts.push(`${root.label} 全部`);
        else parts.push(`${root.label} ${selection.selected.length} 个`);
    }
    return parts;
}

/** "当前已选择同步范围：xxx" 里的那段 xxx。 */
function describeScope(scope) {
    const parts = [];
    if (scope.characters?.all) parts.push('角色卡 全部');
    else if (scope.characters?.selected?.length) parts.push(`角色卡 ${scope.characters.selected.length} 张`);

    // 聊天必须跟着角色卡走，一张卡都没勾时说"聊天记录 全部"是在骗人 —— 实际一条都不会传
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
    PERSONAS_FILE,
    API_PROFILES_FILE,
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
    toRemote,
    toLocal,
    inScope,
    categoryOf,
    scanRoots,
    localAbsPath,
    describeScope,
    selectionEmpty,
};
