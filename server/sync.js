/**
 * 多端同步的完整实现：远端布局、本地扫描、基线、三方比较、.jsonl 快进、执行。
 *
 * 决策部分（buildPlan、analyzeJsonl、safeSegment 等）是纯函数，不碰网络也不碰磁盘，
 * 单元测试直接 require 本文件即可 —— 这里只用 Node 内置模块，fflate 只在 snapshot.js 里。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const webdav = require('./webdav.js');

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function timestampForFile(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 防止 `..` 之类的路径穿出目标目录。 */
function ensureInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`目标路径越界：${child}`);
    }
}

// ---------------------------------------------------------------------------
// 远端布局与路径
// ---------------------------------------------------------------------------

// 同步区就摊在 remotePath 下，元数据和 zip 快照各自单独一层，遍历同步区时跳过。
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

// ---------------------------------------------------------------------------
// 本地扫描
// ---------------------------------------------------------------------------

/**
 * 扫描参与同步的本地目录，产出 { 相对路径: {hash, size, mtime} }。
 * hashCache 一般传上次的基线：大小与 mtime 都没变就复用旧哈希，
 * 避免每次同步都把所有聊天读一遍。
 */
async function scanLocal(directories, include, hashCache = {}) {
    const out = {};
    for (const root of syncRoots(directories, include)) {
        await walkLocal(root.dir, root.prefix, out, hashCache);
    }
    return out;
}

async function walkLocal(dir, prefix, out, hashCache) {
    if (!fs.existsSync(dir)) return;
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const full = path.join(dir, dirent.name);
        const rel = `${prefix}/${dirent.name}`;
        if (dirent.isDirectory()) {
            await walkLocal(full, rel, out, hashCache);
            continue;
        }
        if (!dirent.isFile()) continue;
        const stats = await fs.promises.stat(full);
        const mtime = stats.mtime.toISOString();
        const cached = hashCache[rel];
        const hash = (cached && cached.hash && cached.size === stats.size && cached.mtime === mtime)
            ? cached.hash
            : sha256(await fs.promises.readFile(full));
        out[rel] = { hash, size: stats.size, mtime };
    }
}

function statMtime(absPath) {
    try {
        return fs.statSync(absPath).mtime.toISOString();
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// 本机基线：三方比较的第三方，没有它就无法区分"对方改了"和"我删了"
// ---------------------------------------------------------------------------

const STATE_DIR = '.webdav-chat-backup';
const STATE_FILE = 'sync-base.json';

function stateFilePath(directories) {
    return path.join(directories.root, STATE_DIR, STATE_FILE);
}

function readState(directories) {
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFilePath(directories), 'utf8'));
        return {
            device: typeof parsed.device === 'string' ? parsed.device : '',
            base: parsed.base && typeof parsed.base === 'object' ? parsed.base : {},
            lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : '',
        };
    } catch {
        return { device: '', base: {}, lastSyncAt: '' };
    }
}

function writeState(directories, state) {
    const file = stateFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** 用户填了名字就用用户的，否则沿用已有的，都没有才生成一个。 */
function resolveDevice(directories, preferred) {
    const state = readState(directories);
    if (preferred) {
        if (state.device !== preferred) {
            state.device = preferred;
            writeState(directories, state);
        }
        return preferred;
    }
    if (state.device) return state.device;
    state.device = `device-${crypto.randomBytes(3).toString('hex')}`;
    writeState(directories, state);
    return state.device;
}

// ---------------------------------------------------------------------------
// 三方比较（纯函数）
// ---------------------------------------------------------------------------

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_PREVIEW_LIMIT = 40;
const PLAN_ACTIONS = ['upload', 'download', 'conflict', 'deleteLocal', 'deleteRemote'];

/**
 * 三方比较：本机、远端、上次同步基线。
 * 只有本机和远端都相对基线变化过，才算真冲突；只有一边变就直接同步过去。
 */
function buildPlan(context, direction = 'two-way') {
    const { local, remoteIndex, remotePresent, base, tombstones, include } = context;
    const plan = {
        upload: [],
        download: [],
        conflict: [],
        deleteLocal: [],
        deleteRemote: [],
        unchanged: 0,
        skipped: [],
    };

    const paths = new Set([
        ...Object.keys(local),
        ...Object.keys(remotePresent),
        ...Object.keys(base),
    ]);

    for (const relPath of paths) {
        if (!pathAllowed(relPath, include)) continue;

        const localHash = local[relPath]?.hash || null;
        const present = Object.prototype.hasOwnProperty.call(remotePresent, relPath);
        const indexed = remoteIndex[relPath]?.hash || null;
        const remoteHash = present ? indexed : null;
        const baseHash = base[relPath]?.hash || null;
        const tomb = tombstones[relPath];

        // 远端有文件但索引里没有哈希：手动上传，或索引损坏
        if (present && !indexed) {
            if (localHash) plan.conflict.push({ path: relPath, reason: 'remote-unindexed' });
            else plan.download.push({ path: relPath, reason: 'remote-unindexed' });
            continue;
        }

        if (localHash && remoteHash) {
            if (localHash === remoteHash) {
                plan.unchanged++;
            } else if (baseHash && baseHash === localHash) {
                plan.download.push({ path: relPath, reason: 'remote-changed' });
            } else if (baseHash && baseHash === remoteHash) {
                plan.upload.push({ path: relPath, reason: 'local-changed' });
            } else {
                plan.conflict.push({ path: relPath, reason: 'diverged' });
            }
            continue;
        }

        if (localHash && !remoteHash) {
            if (tomb && tomb.hash === localHash) {
                plan.deleteLocal.push({ path: relPath, reason: 'tombstone' });
            } else if (!tomb && baseHash && baseHash === localHash) {
                plan.deleteLocal.push({ path: relPath, reason: 'remote-deleted' });
            } else {
                // 本地在远端删除之后又改过，视为重新添加
                plan.upload.push({ path: relPath, reason: baseHash ? 'local-readded' : 'local-new' });
            }
            continue;
        }

        if (!localHash && remoteHash) {
            if (baseHash && baseHash === remoteHash) {
                plan.deleteRemote.push({ path: relPath, reason: 'local-deleted' });
            } else {
                plan.download.push({ path: relPath, reason: 'remote-new' });
            }
        }
        // 两边都没有：交给 applyPlan 从基线里清掉
    }

    if (direction === 'upload-only') {
        plan.skipped.push(...plan.download, ...plan.deleteLocal);
        plan.download = [];
        plan.deleteLocal = [];
        plan.conflict = plan.conflict.map(item => ({ ...item, resolution: 'force-upload' }));
    } else if (direction === 'download-only') {
        plan.skipped.push(...plan.upload, ...plan.deleteRemote);
        plan.upload = [];
        plan.deleteRemote = [];
        plan.conflict = plan.conflict.map(item => ({ ...item, resolution: 'force-download' }));
    }

    return plan;
}

/** 压成前端可直接渲染的结构，长列表截断以免响应过大。 */
function summarizePlan(plan) {
    const summary = {
        counts: { unchanged: plan.unchanged, skipped: plan.skipped.length },
        truncated: false,
    };
    for (const action of PLAN_ACTIONS) {
        const items = plan[action];
        summary.counts[action] = items.length;
        summary[action] = items.slice(0, PLAN_PREVIEW_LIMIT)
            .map(item => ({ path: item.path, reason: item.reason }));
        if (items.length > PLAN_PREVIEW_LIMIT) summary.truncated = true;
    }
    return summary;
}

// ---------------------------------------------------------------------------
// .jsonl 快进（纯函数）
// ---------------------------------------------------------------------------

function splitJsonlLines(buffer) {
    return buffer.toString('utf8').split('\n').filter(line => line.trim().length > 0);
}

/**
 * SillyTavern 的聊天是逐行追加的 .jsonl，所以可以像 git 那样判断快进：
 * 若一方是另一方的行前缀，直接取更长的那份，不必当成冲突。
 * 改写已有消息（含 swipes）会让公共前缀提前中断，此时保守地判为分叉 ——
 * 宁可多留一个分支，也不要悄悄丢内容。
 */
function analyzeJsonl(localBuffer, remoteBuffer) {
    const localLines = splitJsonlLines(localBuffer);
    const remoteLines = splitJsonlLines(remoteBuffer);
    let common = 0;
    while (common < localLines.length
        && common < remoteLines.length
        && localLines[common] === remoteLines[common]) {
        common++;
    }
    if (common === localLines.length && common === remoteLines.length) return { type: 'same', common };
    if (common === localLines.length) return { type: 'fast-forward-download', common };
    if (common === remoteLines.length) return { type: 'fast-forward-upload', common };
    return { type: 'diverged', common };
}

function pruneTombstones(tombstones, now = Date.now()) {
    const cutoff = now - TOMBSTONE_TTL_MS;
    for (const [key, value] of Object.entries(tombstones)) {
        const at = new Date(value?.at || 0).getTime();
        if (!Number.isFinite(at) || at < cutoff) delete tombstones[key];
    }
    return tombstones;
}

// ---------------------------------------------------------------------------
// 并发锁
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 5 * 60 * 1000;

/** 用锁文件而不是 WebDAV 的 LOCK 方法：坚果云等服务对 LOCK 支持不完整。 */
async function acquireLock(config, device) {
    const existing = await webdav.readJson(config, [SYNC_DIR, LOCK_NAME], null);
    if (existing?.at && existing.device && existing.device !== device) {
        const age = Date.now() - new Date(existing.at).getTime();
        if (Number.isFinite(age) && age >= 0 && age < LOCK_TTL_MS) {
            const minutes = Math.ceil((LOCK_TTL_MS - age) / 60000);
            throw new Error(`另一台设备（${existing.device}）正在同步，请约 ${minutes} 分钟后重试。`);
        }
    }
    await webdav.writeJson(config, [SYNC_DIR, LOCK_NAME], {
        device,
        at: new Date().toISOString(),
    });
}

async function releaseLock(config, device) {
    try {
        const existing = await webdav.readJson(config, [SYNC_DIR, LOCK_NAME], null);
        if (existing?.device && existing.device !== device) return;
        await webdav.remove(config, [SYNC_DIR, LOCK_NAME]);
    } catch (error) {
        console.warn('[WebDAV Chat Backup] 释放同步锁失败：', error.message);
    }
}

// ---------------------------------------------------------------------------
// 收集两端状态
// ---------------------------------------------------------------------------

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function collectContext(user, config) {
    const directories = user.directories;
    const device = resolveDevice(directories, config.deviceName);
    const state = readState(directories);

    await webdav.ensureRoot(config);

    const local = await scanLocal(directories, config.include, state.base);

    const rawIndex = await webdav.readJson(config, [SYNC_DIR, INDEX_NAME], null);
    const remoteIndex = isPlainObject(rawIndex?.entries) ? rawIndex.entries : {};

    const rawTombstones = await webdav.readJson(config, [SYNC_DIR, TOMBSTONE_NAME], null);
    const tombstones = isPlainObject(rawTombstones?.entries) ? rawTombstones.entries : {};

    // 实际远端文件树，用来发现绕过本插件的手动增删
    const remoteTree = {};
    await webdav.walk(config, [], '', remoteTree, NON_SYNC_DIRS);

    // 索引里记的是远端安全路径，这里翻回本地原始路径
    const remoteToLocal = {};
    for (const [rel, entry] of Object.entries(remoteIndex)) {
        remoteToLocal[entry?.remote || safeRelPath(rel)] = rel;
    }
    const remotePresent = {};
    for (const [remoteRel, meta] of Object.entries(remoteTree)) {
        remotePresent[remoteToLocal[remoteRel] || remoteRel] = meta;
    }

    return {
        directories,
        device,
        base: state.base,
        local,
        remoteIndex,
        remotePresent,
        tombstones,
        include: config.include,
    };
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

async function applyPlan(config, context, plan) {
    const { directories, device } = context;
    const stamp = timestampForFile();
    const createdDirs = new Set();
    const protectionRoot = path.join(directories.backups, `webdav-sync-${stamp}`);

    const base = { ...context.base };
    const remoteIndex = { ...context.remoteIndex };
    const tombstones = pruneTombstones({ ...context.tombstones });

    const result = {
        uploaded: 0,
        downloaded: 0,
        conflicts: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        unchanged: plan.unchanged,
        skipped: plan.skipped.length,
        conflictFiles: [],
        errors: [],
        protectionDir: '',
    };
    let protectedAny = false;

    // 任何覆盖或删除之前，本地原文件先进保护副本目录。
    // 这是整个同步流程的安全网：即便判断错了，内容也还在。
    const protectLocal = async (relPath, absPath) => {
        if (!absPath || !fs.existsSync(absPath)) return;
        const target = path.join(protectionRoot, relPath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(absPath, target);
        protectedAny = true;
    };

    const uploadFile = async (relPath, buffer) => {
        const remoteRel = safeRelPath(relPath);
        const segments = remoteRel.split('/');
        await webdav.ensureDir(config, segments.slice(0, -1), createdDirs);
        await webdav.putBuffer(config, segments, buffer);
        const at = new Date().toISOString();
        const hash = sha256(buffer);
        remoteIndex[relPath] = { hash, size: buffer.length, remote: remoteRel, device, at };
        base[relPath] = {
            hash,
            size: buffer.length,
            mtime: statMtime(localPathFor(directories, relPath)),
            syncedAt: at,
        };
        delete tombstones[relPath];
    };

    const downloadFile = (relPath) => {
        const remoteRel = remoteIndex[relPath]?.remote || safeRelPath(relPath);
        return webdav.getBuffer(config, remoteRel.split('/'));
    };

    const writeLocal = async (relPath, buffer) => {
        const absPath = localPathFor(directories, relPath);
        if (!absPath) throw new Error(`无法解析本地路径：${relPath}`);
        await protectLocal(relPath, absPath);
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await fs.promises.writeFile(absPath, buffer);
        const at = new Date().toISOString();
        const hash = sha256(buffer);
        base[relPath] = { hash, size: buffer.length, mtime: statMtime(absPath), syncedAt: at };
        if (!remoteIndex[relPath]) {
            remoteIndex[relPath] = { hash, size: buffer.length, remote: safeRelPath(relPath), device, at };
        }
    };

    const record = (item, action, error) => {
        result.errors.push({ path: item.path, action, error: error.message });
    };

    for (const item of plan.upload) {
        try {
            const absPath = localPathFor(directories, item.path);
            if (!absPath || !fs.existsSync(absPath)) continue;
            await uploadFile(item.path, await fs.promises.readFile(absPath));
            result.uploaded++;
        } catch (error) {
            record(item, 'upload', error);
        }
    }

    for (const item of plan.download) {
        try {
            await writeLocal(item.path, await downloadFile(item.path));
            result.downloaded++;
        } catch (error) {
            record(item, 'download', error);
        }
    }

    for (const item of plan.conflict) {
        try {
            const absPath = localPathFor(directories, item.path);
            const localBuffer = absPath && fs.existsSync(absPath)
                ? await fs.promises.readFile(absPath)
                : null;

            if (item.resolution === 'force-upload') {
                if (!localBuffer) continue;
                await uploadFile(item.path, localBuffer);
                result.uploaded++;
                continue;
            }

            const remoteBuffer = await downloadFile(item.path);

            if (item.resolution === 'force-download' || !localBuffer) {
                await writeLocal(item.path, remoteBuffer);
                result.downloaded++;
                continue;
            }

            if (isChatPath(item.path) && item.path.endsWith('.jsonl')) {
                const analysis = analyzeJsonl(localBuffer, remoteBuffer);
                if (analysis.type === 'fast-forward-download') {
                    await writeLocal(item.path, remoteBuffer);
                    result.downloaded++;
                    continue;
                }
                if (analysis.type === 'fast-forward-upload' || analysis.type === 'same') {
                    await uploadFile(item.path, localBuffer);
                    result.uploaded++;
                    continue;
                }
                // 真分叉：远端版本占用原名，本机版本另存为一条独立分支。
                // 这样两台设备最终都拥有两个版本，且下次同步不会再生成新的冲突文件。
                const conflictRel = conflictPathFor(item.path, device, stamp);
                await writeLocal(conflictRel, localBuffer);
                await uploadFile(conflictRel, localBuffer);
                await writeLocal(item.path, remoteBuffer);
                result.conflicts++;
                result.conflictFiles.push({
                    path: item.path,
                    kept: conflictRel,
                    commonLines: analysis.common,
                });
                continue;
            }

            // 角色卡与世界书没有行级语义，无法合并：远端优先，本机进保护副本
            await writeLocal(item.path, remoteBuffer);
            result.conflicts++;
            result.conflictFiles.push({
                path: item.path,
                kept: `backups/webdav-sync-${stamp}/${item.path}`,
            });
        } catch (error) {
            record(item, 'conflict', error);
        }
    }

    for (const item of plan.deleteLocal) {
        try {
            const absPath = localPathFor(directories, item.path);
            if (absPath && fs.existsSync(absPath)) {
                await protectLocal(item.path, absPath);
                await fs.promises.unlink(absPath);
                result.deletedLocal++;
            }
            delete base[item.path];
            delete remoteIndex[item.path];
        } catch (error) {
            record(item, 'delete-local', error);
        }
    }

    for (const item of plan.deleteRemote) {
        try {
            const remoteRel = remoteIndex[item.path]?.remote || safeRelPath(item.path);
            await webdav.remove(config, remoteRel.split('/'));
            // 留墓碑，否则其他设备下次同步会把这个文件又推回来
            tombstones[item.path] = {
                hash: remoteIndex[item.path]?.hash || context.base[item.path]?.hash || '',
                at: new Date().toISOString(),
                device,
            };
            delete remoteIndex[item.path];
            delete base[item.path];
            result.deletedRemote++;
        } catch (error) {
            record(item, 'delete-remote', error);
        }
    }

    // 清掉两边都已不存在的基线条目
    for (const relPath of Object.keys(base)) {
        const absPath = localPathFor(directories, relPath);
        if (!remoteIndex[relPath] && (!absPath || !fs.existsSync(absPath))) {
            delete base[relPath];
        }
    }

    await webdav.ensureDir(config, [SYNC_DIR], createdDirs);
    await webdav.writeJson(config, [SYNC_DIR, INDEX_NAME], {
        version: 2,
        updatedAt: new Date().toISOString(),
        updatedBy: device,
        entries: remoteIndex,
    });
    await webdav.writeJson(config, [SYNC_DIR, TOMBSTONE_NAME], {
        version: 2,
        updatedAt: new Date().toISOString(),
        entries: tombstones,
    });

    const state = readState(directories);
    state.device = device;
    state.base = base;
    state.lastSyncAt = new Date().toISOString();
    writeState(directories, state);

    result.protectionDir = protectedAny ? protectionRoot : '';
    result.lastSyncAt = state.lastSyncAt;
    result.device = device;
    return result;
}

/** 端到端跑一次同步：收集、比对、抢锁、执行。 */
async function runSync(user, config) {
    const context = await collectContext(user, config);
    const plan = buildPlan(context, config.direction);
    await acquireLock(config, context.device);
    try {
        return await applyPlan(config, context, plan);
    } finally {
        await releaseLock(config, context.device);
    }
}

module.exports = {
    // 供 snapshot.js 复用
    SNAPSHOT_DIR,
    sha256,
    timestampForFile,
    ensureInside,
    // 供 index.js 使用
    readState,
    collectContext,
    buildPlan,
    summarizePlan,
    runSync,
    // 纯函数，供单元测试
    analyzeJsonl,
    pruneTombstones,
    pathAllowed,
    safeSegment,
    safeRelPath,
    conflictPathFor,
};
