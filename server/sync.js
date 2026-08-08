/**
 * 同步的执行层：收集两端状态、抢锁、按计划落盘与上传。
 * 决策逻辑在 plan.js，这里只负责 I/O 与副作用。
 */
const fs = require('node:fs');
const path = require('node:path');

const { sha256, timestampForFile } = require('./util.js');
const {
    SYNC_DIR, INDEX_NAME, TOMBSTONE_NAME, LOCK_NAME, NON_SYNC_DIRS,
    localPathFor, safeRelPath, isChatPath, conflictPathFor,
} = require('./paths.js');
const webdav = require('./webdav.js');
const { readState, writeState, resolveDevice } = require('./state.js');
const { scanLocal, statMtime } = require('./scan.js');
const { buildPlan, analyzeJsonl, pruneTombstones } = require('./plan.js');

const LOCK_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 并发锁
// ---------------------------------------------------------------------------

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

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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
    LOCK_TTL_MS,
    collectContext,
    applyPlan,
    runSync,
    acquireLock,
    releaseLock,
};
