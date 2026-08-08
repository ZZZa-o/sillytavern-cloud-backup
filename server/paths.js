const path = require('node:path');

const { sha256, ensureInside } = require('./util.js');

// 远端布局。同步区就摊在 remotePath 下，元数据和 zip 快照各自单独一层，
// 遍历同步区时要跳过这两个目录。
const SYNC_DIR = '.st-sync';
const SNAPSHOT_DIR = 'snapshots';
const INDEX_NAME = 'index.json';
const TOMBSTONE_NAME = 'tombstones.json';
const LOCK_NAME = 'lock.json';
const NON_SYNC_DIRS = [SYNC_DIR, SNAPSHOT_DIR];

/**
 * 同步区的顶层前缀，以及它对应的 SillyTavern 目录键与勾选项。
 *
 * settings.json 刻意不在其中：它含 API 地址等设备相关配置，
 * 跨设备互相覆盖会让另一台直接不可用。它只进 zip 快照。
 */
const SYNC_ROOTS = [
    { prefix: 'chats', dirKey: 'chats', include: 'chats' },
    { prefix: 'group chats', dirKey: 'groupChats', include: 'groupChats' },
    { prefix: 'groups', dirKey: 'groups', include: 'groupChats' },
    { prefix: 'characters', dirKey: 'characters', include: 'characters' },
    { prefix: 'worlds', dirKey: 'worlds', include: 'worlds' },
];

/** 当前勾选下参与同步的本地目录。 */
function syncRoots(directories, include) {
    return SYNC_ROOTS
        .filter(root => include[root.include])
        .map(root => ({ prefix: root.prefix, dir: directories[root.dirKey] }))
        .filter(root => !!root.dir);
}

/** 相对路径是否落在当前勾选的同步范围内。 */
function pathAllowed(relPath, include) {
    const root = SYNC_ROOTS.find(item => relPath.startsWith(`${item.prefix}/`));
    return root ? !!include[root.include] : false;
}

/** 把同步用的相对路径还原成本地绝对路径；越界或不认识的前缀返回 null。 */
function localPathFor(directories, relPath) {
    const root = SYNC_ROOTS.find(item => relPath.startsWith(`${item.prefix}/`));
    if (!root) return null;
    const base = directories[root.dirKey];
    if (!base) return null;
    try {
        const target = path.resolve(base, relPath.slice(root.prefix.length + 1));
        ensureInside(base, target);
        return target;
    } catch {
        return null;
    }
}

// 只处理在 WebDAV / Windows 上真正非法的字符。空格与连字符必须保留，
// 因为 SillyTavern 的聊天文件名形如 "2026-08-01 12h30m.jsonl"。
const ILLEGAL_SEGMENT = /[\\/:*?"<>|]/g;

/** 把单个路径段转成远端可用的名字，改动过就补哈希避免不同角色撞名。 */
function safeSegment(name) {
    const raw = String(name);
    const cleaned = raw.replace(ILLEGAL_SEGMENT, '_').replace(/[.\s]+$/, '');
    if (!cleaned) return `_${sha256(Buffer.from(raw, 'utf8')).slice(0, 8)}`;
    if (cleaned === raw) return cleaned;
    return `${cleaned}~${sha256(Buffer.from(raw, 'utf8')).slice(0, 8)}`;
}

function safeRelPath(relPath) {
    return relPath.split('/').map(safeSegment).join('/');
}

function isChatPath(relPath) {
    return relPath.startsWith('chats/') || relPath.startsWith('group chats/');
}

function conflictPathFor(relPath, device, stamp) {
    const ext = path.posix.extname(relPath);
    const stem = relPath.slice(0, relPath.length - ext.length);
    return `${stem} (冲突 ${device} ${stamp})${ext}`;
}

module.exports = {
    SYNC_DIR,
    SNAPSHOT_DIR,
    INDEX_NAME,
    TOMBSTONE_NAME,
    LOCK_NAME,
    NON_SYNC_DIRS,
    SYNC_ROOTS,
    syncRoots,
    pathAllowed,
    localPathFor,
    safeSegment,
    safeRelPath,
    isChatPath,
    conflictPathFor,
};
