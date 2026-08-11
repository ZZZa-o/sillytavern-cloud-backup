/**
 * 备份执行：本地扫描、远端索引、上传/下载计划与执行。
 *
 * 只有两个方向，没有"双向同步"：
 *   上传  本地 → 远端，内容相同的跳过，远端多余文件保留不动
 *   下载  远端 → 本地，同名直接覆盖
 *
 * 远端目录结构与角色名映射都在 paths.js；本文件只管"传哪些、往哪个方向传"。
 * 决策部分（buildPlan）是纯函数，不碰网络也不碰磁盘，单元测试直接 require 本文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const webdav = require('./webdav.js');
const paths = require('./paths.js');

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

// 元数据单独一层，遍历备份区时跳过
const META_DIR = '.st-sync';
const INDEX_NAME = 'index.json';
const LOCK_NAME = 'lock.json';
const NON_BACKUP_DIRS = [META_DIR];

// ---------------------------------------------------------------------------
// 本地扫描
// ---------------------------------------------------------------------------

/**
 * 扫描范围内的本地文件，产出 { 本地相对路径: {hash, size, mtime} }。
 * hashCache 传上次的扫描结果：大小与 mtime 都没变就复用旧哈希，
 * 避免每次备份都把所有聊天读一遍。
 */
async function scanLocal(directories, scope, hashCache = {}) {
    const out = {};
    for (const root of paths.scanRoots(directories, scope)) {
        await walkLocal(root.dir, root.prefix, out, hashCache, scope);
    }
    if (scope.settings?.enabled) {
        await addLocalFile(path.join(directories.root, paths.SETTINGS_FILE), paths.SETTINGS_FILE, out, hashCache);
    }
    return out;
}

async function walkLocal(dir, prefix, out, hashCache, scope) {
    if (!fs.existsSync(dir)) return;
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const full = path.join(dir, dirent.name);
        const rel = `${prefix}/${dirent.name}`;
        if (dirent.isDirectory()) {
            await walkLocal(full, rel, out, hashCache, scope);
            continue;
        }
        if (!dirent.isFile()) continue;
        if (!paths.inScope(rel, scope)) continue;
        await addLocalFile(full, rel, out, hashCache);
    }
}

async function addLocalFile(absPath, rel, out, hashCache) {
    if (!fs.existsSync(absPath)) return;
    const stats = await fs.promises.stat(absPath);
    if (!stats.isFile()) return;
    const mtime = stats.mtime.toISOString();
    const cached = hashCache[rel];
    const hash = (cached && cached.hash && cached.size === stats.size && cached.mtime === mtime)
        ? cached.hash
        : sha256(await fs.promises.readFile(absPath));
    out[rel] = { hash, size: stats.size, mtime };
}

function statMtime(absPath) {
    try {
        return fs.statSync(absPath).mtime.toISOString();
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// 本机状态：只是哈希缓存 + 设备标识，丢了也不影响正确性
// ---------------------------------------------------------------------------

const STATE_DIR = '.webdav-chat-backup';
const STATE_FILE = 'scan-cache.json';

function stateFilePath(directories) {
    return path.join(directories.root, STATE_DIR, STATE_FILE);
}

function readState(directories) {
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFilePath(directories), 'utf8'));
        return {
            device: typeof parsed.device === 'string' ? parsed.device : '',
            cache: parsed.cache && typeof parsed.cache === 'object' ? parsed.cache : {},
            lastBackupAt: typeof parsed.lastBackupAt === 'string' ? parsed.lastBackupAt : '',
        };
    } catch {
        return { device: '', cache: {}, lastBackupAt: '' };
    }
}

function writeState(directories, state) {
    const file = stateFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** 设备标识只用于并发锁的提示文案，自动生成即可。 */
function resolveDevice(directories) {
    const state = readState(directories);
    if (state.device) return state.device;
    state.device = `device-${crypto.randomBytes(3).toString('hex')}`;
    writeState(directories, state);
    return state.device;
}

// ---------------------------------------------------------------------------
// 计划（纯函数）
// ---------------------------------------------------------------------------

const PLAN_PREVIEW_LIMIT = 40;

/**
 * 比对两端，产出待上传与待下载清单。两边哈希一致就算 unchanged。
 * 远端有文件但索引里没哈希（手动传的，或索引损坏）时无法判断内容，
 * 上传方向按"需要覆盖"处理，下载方向按"需要拉取"处理 —— 两边都不会静默跳过。
 */
function buildPlan(context) {
    const { local, remoteIndex, remotePresent, scope } = context;
    const plan = { upload: [], download: [], unchanged: 0 };

    const all = new Set([...Object.keys(local), ...Object.keys(remotePresent)]);

    for (const relPath of all) {
        if (!paths.inScope(relPath, scope)) continue;

        const localHash = local[relPath]?.hash || null;
        const present = Object.prototype.hasOwnProperty.call(remotePresent, relPath);
        const remoteHash = present ? (remoteIndex[relPath]?.hash || null) : null;

        if (localHash && present) {
            if (remoteHash && localHash === remoteHash) {
                plan.unchanged++;
            } else {
                const reason = remoteHash ? 'differs' : 'remote-unindexed';
                plan.upload.push({ path: relPath, reason });
                plan.download.push({ path: relPath, reason });
            }
            continue;
        }

        if (localHash) {
            plan.upload.push({ path: relPath, reason: 'local-only' });
            continue;
        }

        if (present) {
            plan.download.push({ path: relPath, reason: 'remote-only' });
        }
    }

    return plan;
}

/** 压成前端可直接渲染的结构，长列表截断以免响应过大。 */
function summarizePlan(plan) {
    const summary = { counts: { unchanged: plan.unchanged }, truncated: false };
    for (const action of ['upload', 'download']) {
        const items = plan[action];
        summary.counts[action] = items.length;
        summary[action] = items.slice(0, PLAN_PREVIEW_LIMIT)
            .map(item => ({ path: item.path, reason: item.reason }));
        if (items.length > PLAN_PREVIEW_LIMIT) summary.truncated = true;
    }
    return summary;
}

// ---------------------------------------------------------------------------
// 并发锁
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * 用锁文件而不是 WebDAV 的 LOCK 方法：坚果云等服务对 LOCK 支持不完整。
 * 必须先建出 .st-sync/ —— 首次备份时它还不存在，直接 PUT 锁文件会被服务端以 409 拒绝。
 */
async function acquireLock(config, device, createdDirs = new Set()) {
    await webdav.ensureDir(config, [META_DIR], createdDirs);
    const existing = await webdav.readJson(config, [META_DIR, LOCK_NAME], null);
    if (existing?.at && existing.device && existing.device !== device) {
        const age = Date.now() - new Date(existing.at).getTime();
        if (Number.isFinite(age) && age >= 0 && age < LOCK_TTL_MS) {
            const minutes = Math.ceil((LOCK_TTL_MS - age) / 60000);
            throw new Error(`另一台设备（${existing.device}）正在备份，请约 ${minutes} 分钟后重试。`);
        }
    }
    await webdav.writeJson(config, [META_DIR, LOCK_NAME], { device, at: new Date().toISOString() });
}

async function releaseLock(config, device) {
    try {
        const existing = await webdav.readJson(config, [META_DIR, LOCK_NAME], null);
        if (existing?.device && existing.device !== device) return;
        await webdav.remove(config, [META_DIR, LOCK_NAME]);
    } catch (error) {
        console.warn('[WebDAV Chat Backup] 释放锁失败：', error.message);
    }
}

// ---------------------------------------------------------------------------
// 远端索引
// ---------------------------------------------------------------------------

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readRemoteIndex(config) {
    const raw = await webdav.readJson(config, [META_DIR, INDEX_NAME], null);
    return isPlainObject(raw?.entries) ? raw.entries : {};
}

async function writeRemoteIndex(config, entries, device, createdDirs = new Set()) {
    await webdav.ensureDir(config, [META_DIR], createdDirs);
    await webdav.writeJson(config, [META_DIR, INDEX_NAME], {
        version: 3,
        updatedAt: new Date().toISOString(),
        updatedBy: device,
        entries,
    });
}

/** 远端真实路径 → 本地相对路径。索引里记过的用索引，没记过的按目录约定反推。 */
function remoteToLocalMap(remoteIndex, names) {
    const map = {};
    for (const [localRel, entry] of Object.entries(remoteIndex)) {
        const remote = entry?.remote || paths.toRemote(localRel, names);
        if (remote) map[remote] = localRel;
    }
    return map;
}

// ---------------------------------------------------------------------------
// 收集两端状态
// ---------------------------------------------------------------------------

async function collectContext(user, config, names) {
    const directories = user.directories;
    const device = resolveDevice(directories);
    const state = readState(directories);

    await webdav.ensureRoot(config);

    const local = await scanLocal(directories, config.scope, state.cache);
    const remoteIndex = await readRemoteIndex(config);

    // 实际远端文件树，用来发现绕过本插件的手动增删
    const remoteTree = {};
    await webdav.walk(config, [], '', remoteTree, NON_BACKUP_DIRS);

    const fromIndex = remoteToLocalMap(remoteIndex, names);
    const remotePresent = {};
    for (const [remoteRel, meta] of Object.entries(remoteTree)) {
        const localRel = fromIndex[remoteRel] || paths.toLocal(remoteRel, names);
        if (localRel) remotePresent[localRel] = meta;
    }

    return { directories, device, names, local, remoteIndex, remotePresent, scope: config.scope, cache: state.cache };
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function newResult() {
    return {
        uploaded: 0,
        downloaded: 0,
        skipped: 0,
        errors: [],
        // 下载动了哪几类，前端据此热刷新对应列表，免得让用户整页重载
        touched: { characters: 0, chats: 0, worlds: 0, settings: 0, other: 0 },
    };
}

/** 上传：范围内本地文件推到远端。云端多余的文件一概不动。 */
async function runUpload(user, config, names) {
    const context = await collectContext(user, config, names);
    const { directories, device } = context;
    const createdDirs = new Set();
    const remoteIndex = { ...context.remoteIndex };
    const cache = { ...context.cache };
    const plan = buildPlan(context);
    const result = newResult();
    result.skipped = plan.unchanged;

    await acquireLock(config, device, createdDirs);
    try {
        for (const item of plan.upload) {
            try {
                const absPath = paths.localAbsPath(directories, item.path);
                if (!absPath || !fs.existsSync(absPath)) continue;
                const remoteRel = paths.toRemote(item.path, names);
                if (!remoteRel) continue;

                const buffer = await fs.promises.readFile(absPath);
                const segments = remoteRel.split('/');
                await webdav.ensureDir(config, segments.slice(0, -1), createdDirs);
                await webdav.putBuffer(config, segments, buffer);

                const hash = sha256(buffer);
                remoteIndex[item.path] = {
                    hash,
                    size: buffer.length,
                    remote: remoteRel,
                    device,
                    at: new Date().toISOString(),
                };
                cache[item.path] = { hash, size: buffer.length, mtime: statMtime(absPath) };
                result.uploaded++;
            } catch (error) {
                result.errors.push({ path: item.path, action: 'upload', error: error.message });
            }
        }

        await writeRemoteIndex(config, remoteIndex, device, createdDirs);
    } finally {
        await releaseLock(config, device);
    }

    return finish(directories, device, cache, result, 'upload');
}

/** 下载：远端范围内文件拉到本地，同名直接覆盖。 */
async function runDownload(user, config, names) {
    const context = await collectContext(user, config, names);
    const { directories, device } = context;
    const plan = buildPlan(context);
    const cache = { ...context.cache };
    const result = newResult();
    result.skipped = plan.unchanged;

    for (const item of plan.download) {
        try {
            const remoteRel = context.remoteIndex[item.path]?.remote || paths.toRemote(item.path, names);
            if (!remoteRel) throw new Error('无法定位云端路径');
            const buffer = await webdav.getBuffer(config, remoteRel.split('/'));
            const absPath = await writeLocal(directories, item.path, buffer);
            cache[item.path] = { hash: sha256(buffer), size: buffer.length, mtime: statMtime(absPath) };
            result.downloaded++;
            result.touched[paths.categoryOf(item.path)]++;
        } catch (error) {
            result.errors.push({ path: item.path, action: 'download', error: error.message });
        }
    }

    return finish(directories, device, cache, result, 'download');
}

/** 写本地文件，同名直接覆盖 —— 酒馆本来就允许存在同名角色卡，不需要另存副本。 */
async function writeLocal(directories, localRel, buffer) {
    const absPath = paths.localAbsPath(directories, localRel);
    if (!absPath) throw new Error(`无法解析本地路径：${localRel}`);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, buffer);
    return absPath;
}

function finish(directories, device, cache, result, direction) {
    const state = readState(directories);
    state.device = device;
    state.cache = cache;
    state.lastBackupAt = new Date().toISOString();
    writeState(directories, state);

    result.lastBackupAt = state.lastBackupAt;
    result.direction = direction;
    return result;
}

/** 只比对不执行。 */
async function planOnly(user, config, names) {
    return summarizePlan(buildPlan(await collectContext(user, config, names)));
}

module.exports = {
    META_DIR,
    INDEX_NAME,
    NON_BACKUP_DIRS,
    sha256,
    timestampForFile,
    readState,
    readRemoteIndex,
    writeRemoteIndex,
    remoteToLocalMap,
    resolveDevice,
    collectContext,
    planOnly,
    runUpload,
    runDownload,
    writeLocal,
    // 纯函数，供单元测试
    buildPlan,
    summarizePlan,
};
