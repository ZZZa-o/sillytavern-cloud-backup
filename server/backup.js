/**
 * 备份执行：扫描本地文件，读取远端索引，生成并执行上传或下载计划。
 * 上传跳过内容相同的文件并保留远端其他文件；下载覆盖本地同名文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const webdav = require('./webdav.js');
const encryption = require('./encryption.js');
const paths = require('./paths.js');
const builtin = require('./builtin.js');
const synthetic = require('./synthetic.js');
const { connectionKey } = require('./activity.js');

// 通用小工具

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 读取目录项类型；Dirent 无法确定类型或遇到符号链接时使用 stat。 */
function entryKind(parent, dirent) {
    if (dirent.isDirectory()) return 'dir';
    if (dirent.isFile()) return 'file';
    try {
        const stats = fs.statSync(path.join(parent, dirent.name));
        if (stats.isDirectory()) return 'dir';
        if (stats.isFile()) return 'file';
    } catch {
        // 跳过已删除的文件或失效的符号链接。
    }
    return 'other';
}

// 备份遍历跳过元数据目录。
const META_DIR = '.st-sync';
const INDEX_NAME = 'index.json';
const LOCK_NAME = 'lock.json';
const KEYCHECK_NAME = 'keycheck.json';
const NON_BACKUP_DIRS = [META_DIR];

// 云端读写前校验口令并准备主密钥，校验失败时中止操作。

// 按口令指纹缓存派生密钥。
const keyCache = new Map();

function cacheKeyFor(config, keycheck) {
    const seed = JSON.stringify([config.url, config.remotePath, config.encryption.passphrase, keycheck]);
    return crypto.createHash('sha256').update(seed).digest('hex');
}

async function readKeycheck(config) {
    return webdav.readRawJson(config, [META_DIR, KEYCHECK_NAME]);
}

/** 准备加密密钥；read 模式只读取云端，write 模式可初始化目录和校验文件。 */
async function prepareCrypto(config, access) {
    const enabled = !!config.encryption?.enabled;
    if (access === 'write') await webdav.ensureRoot(config);
    const existing = await readKeycheck(config);

    if (!enabled) {
        // 远端已加密而当前方案未启用加密时中止操作。
        if (existing) {
            throw new Error(
                '云端目录已加密，请开启「加密上传的文件」并填写原口令。',
            );
        }
        return { ...config, cryptoKey: null };
    }

    if (existing) {
        const cacheId = cacheKeyFor(config, existing);
        const cached = keyCache.get(cacheId);
        if (cached) return { ...config, cryptoKey: cached };

        const verdict = encryption.verifyKeycheck(existing, config.encryption.passphrase);
        if (!verdict.ok) throw new Error(verdict.reason);
        keyCache.set(cacheId, verdict.key);
        return { ...config, cryptoKey: verdict.key };
    }

    if (access === 'read') return { ...config, cryptoKey: null };

    // 首次启用加密时生成 salt，写入 keycheck 成功后返回密钥。
    const created = encryption.createKeycheck(config.encryption.passphrase);
    await webdav.ensureDir(config, [META_DIR], new Set());
    await webdav.writeRawJson(config, [META_DIR, KEYCHECK_NAME], created.keycheck);
    keyCache.set(cacheKeyFor(config, created.keycheck), created.key);
    return { ...config, cryptoKey: created.key };
}

// 本地扫描

/**
 * 扫描范围内文件，返回 { 本地相对路径: { hash, size, mtime } }。
 * 文件大小和 mtime 未变时复用 hashCache 中的哈希。
 */
async function scanLocal(directories, scope, hashCache = {}, names = null) {
    const out = {};
    for (const root of paths.scanRoots(directories, scope)) {
        await walkLocal(root.dir, root.prefix, out, hashCache, scope, names);
    }
    // 按所选人设和 API 配置生成合成文件，每次重新计算内容哈希。
    const synth = [
        ...synthetic.listPersonaFiles(directories, scope.personas, names?.personas?.byAvatar || {}),
        ...synthetic.listApiProfileFiles(directories, scope.apiProfiles, names?.profiles?.byId || {}),
    ];
    for (const item of synth) {
        const buffer = synthetic.build(item.localRel, directories, names);
        out[item.localRel] = { hash: sha256(buffer), size: buffer.length, mtime: '' };
    }
    return out;
}

// 传递 names，用于判断头像是否属于本机已有人设。
async function walkLocal(dir, prefix, out, hashCache, scope, names) {
    if (!fs.existsSync(dir)) return;
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const full = path.join(dir, dirent.name);
        const rel = `${prefix}/${dirent.name}`;
        const kind = entryKind(dir, dirent);
        if (kind === 'dir') {
            await walkLocal(full, rel, out, hashCache, scope, names);
            continue;
        }
        if (kind !== 'file') continue;
        if (!paths.inScope(rel, scope, names)) continue;
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

// 本机扫描缓存与设备标识。

const STATE_DIR = '.sillytavern-cloud-backup';
const STATE_FILE = 'scan-cache.json';

function stateFilePath(directories) {
    return path.join(directories.root, STATE_DIR, STATE_FILE);
}

function readState(directories) {
    try {
        return JSON.parse(fs.readFileSync(stateFilePath(directories), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return { device: '', cache: {}, lastBackupAt: '' };
        throw error;
    }
}

function writeState(directories, state) {
    const file = stateFilePath(directories);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** 生成并发锁提示使用的设备标识。 */
function resolveDevice(directories) {
    const state = readState(directories);
    if (state.device) return state.device;
    state.device = `device-${crypto.randomBytes(3).toString('hex')}`;
    writeState(directories, state);
    return state.device;
}

// 计划（纯函数）

const PLAN_PREVIEW_LIMIT = 40;

/**
 * 比较本地与远端哈希，生成上传和下载清单。
 * 哈希一致时标记 unchanged；远端缺少哈希时列入对应方向的传输清单。
 */
function buildPlan(context) {
    const { local, remoteIndex, remotePresent, scope, names } = context;
    const plan = { upload: [], download: [], unchanged: 0 };

    const all = new Set([...Object.keys(local), ...Object.keys(remotePresent)]);

    for (const relPath of all) {
        if (!paths.inScope(relPath, scope, names)) continue;

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

/** 统计索引中 enc 为假或缺失的云端明文文件。 */
function countPlaintext(remoteIndex, cryptoKey) {
    if (!cryptoKey) return 0;
    return Object.values(remoteIndex).filter(entry => !entry?.enc).length;
}

/** 生成前端报告结构，并截断过长的文件列表。 */
function summarizePlan(plan, names) {
    const summary = { counts: { unchanged: plan.unchanged }, uploadCategories: {}, truncated: false };
    for (const item of plan.upload) {
        const category = paths.categoryOf(item.path);
        summary.uploadCategories[category] = (summary.uploadCategories[category] || 0) + 1;
    }
    for (const action of ['upload', 'download']) {
        const items = plan[action];
        summary.counts[action] = items.length;
        summary[action] = items.slice(0, PLAN_PREVIEW_LIMIT)
            .map(item => ({ path: item.path, label: paths.toRemote(item.path, names), reason: item.reason }));
        if (items.length > PLAN_PREVIEW_LIMIT) summary.truncated = true;
    }
    return summary;
}

// 并发锁

const LOCK_TTL_MS = 5 * 60 * 1000;

/** 创建 .st-sync/ 元数据目录并写入并发锁文件。 */
async function acquireLock(config, device, createdDirs = new Set()) {
    await webdav.ensureDir(config, [META_DIR], createdDirs);
    const existing = await webdav.readJson(config, [META_DIR, LOCK_NAME]);
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
        const existing = await webdav.readJson(config, [META_DIR, LOCK_NAME]);
        if (existing?.device && existing.device !== device) return;
        await webdav.remove(config, [META_DIR, LOCK_NAME]);
    } catch (error) {
        console.warn('[SillyTavern Cloud Backup] 释放锁失败：', error.message);
    }
}

// 远端索引

async function readRemoteIndex(config) {
    const raw = await webdav.readJson(config, [META_DIR, INDEX_NAME]);
    return raw === null ? {} : raw.entries;
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

// 收集两端状态

const REMOTE_CHECK_MS = 5 * 60 * 1000;
const changeStates = new Map();

function changeState(directories, config) {
    const key = `${directories.root}\0${connectionKey(config)}`;
    if (!changeStates.has(key)) {
        changeStates.set(key, { remote: null, cache: readState(directories).cache, revision: 0 });
    }
    return changeStates.get(key);
}

function rememberRemote(state, remote) {
    state.remote = remote;
    state.revision++;
}

function invalidateChanges(directories, config) {
    rememberRemote(changeState(directories, config), null);
}

async function readRemoteSnapshot(config) {
    const remoteIndex = await readRemoteIndex(config);
    const remoteTree = {};
    await webdav.walk(config, [], '', remoteTree, NON_BACKUP_DIRS);
    return { remoteIndex, remoteTree, checkedAt: new Date().toISOString() };
}

function remotePresence(remote, names) {
    const fromIndex = remoteToLocalMap(remote.remoteIndex, names);
    const remotePresent = {};
    for (const [remoteRel, meta] of Object.entries(remote.remoteTree)) {
        const localRel = fromIndex[remoteRel] || paths.toLocal(remoteRel, names);
        if (localRel) remotePresent[localRel] = meta;
    }
    return remotePresent;
}

async function collectContext(user, config, names) {
    const directories = user.directories;
    const device = resolveDevice(directories);
    const state = readState(directories);
    const local = await scanLocal(directories, config.scope, state.cache, names);
    const remote = await readRemoteSnapshot(config);
    const monitor = changeState(directories, config);
    rememberRemote(monitor, remote);
    monitor.cache = local;
    return {
        directories, device, names, local, ...remote,
        remotePresent: remotePresence(remote, names), scope: config.scope, cache: state.cache,
    };
}

/** 扫描本地变更；云端索引和目录树每五分钟刷新。 */
async function changesOnly(user, config, names) {
    const state = changeState(user.directories, config);
    let remote = state.remote;
    if (remote === null || Date.now() - Date.parse(remote.checkedAt) >= REMOTE_CHECK_MS) {
        const revision = state.revision;
        remote = await readRemoteSnapshot(await prepareCrypto(config, 'read'));
        if (revision === state.revision) rememberRemote(state, remote);
    }
    const local = await scanLocal(user.directories, config.scope, state.cache, names);
    state.cache = local;
    const plan = buildPlan({
        local, remoteIndex: remote.remoteIndex, remotePresent: remotePresence(remote, names),
        scope: config.scope, names,
    });
    return {
        ...summarizePlan(plan, names),
        checkedAt: new Date().toISOString(),
        remoteCheckedAt: remote.checkedAt,
        plaintextRemaining: countPlaintext(remote.remoteIndex, config.encryption.enabled),
    };
}

// 执行

function newResult() {
    return {
        uploaded: 0,
        uploadedFiles: [],
        downloaded: 0,
        skipped: 0,
        plaintextRemaining: 0,
        errors: [],
        // 记录下载涉及的类别，供前端刷新列表。
        touched: {
            characters: 0, chats: 0, worlds: 0, personas: 0,
            presets: 0, themes: 0, apiProfiles: 0, other: 0,
        },
        // 记录下载涉及的顶层目录。
        touchedDirs: [],
        // 保存合并后的人设字段，供前端刷新。
        personaData: null,
    };
}

/** 记录已写入文件的类别与顶层目录。 */
function noteTouched(result, localRel) {
    result.touched[paths.categoryOf(localRel)]++;
    const top = String(localRel).split('/')[0];
    if (top && !result.touchedDirs.includes(top)) result.touchedDirs.push(top);
}

/** 上传范围内的本地文件，保留云端其他文件。 */
async function runUpload(user, config, names) {
    const context = await collectContext(user, config, names);
    const { directories, device } = context;
    const createdDirs = new Set();
    const remoteIndex = { ...context.remoteIndex };
    const remoteTree = { ...context.remoteTree };
    const cache = { ...context.cache };
    const plan = buildPlan(context);
    const result = newResult();
    result.skipped = plan.unchanged;

    await acquireLock(config, device, createdDirs);
    try {
        for (const item of plan.upload) {
            try {
                const isSynthetic = synthetic.isSynthetic(item.path);
                const absPath = paths.localAbsPath(directories, item.path);
                if (!absPath || !fs.existsSync(absPath)) continue;
                const remoteRel = paths.toRemote(item.path, names);
                if (!remoteRel) continue;

                // 读取合成文件内容。
                const buffer = isSynthetic
                    ? synthetic.build(item.path, directories, names)
                    : await fs.promises.readFile(absPath);
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
                    // 记录文件加密状态与密钥指纹。
                    enc: !!config.cryptoKey,
                    keyId: config.cryptoKey ? encryption.keyIdOf(config.cryptoKey) : '',
                };
                // 合成文件跳过 mtime 哈希缓存。
                if (!isSynthetic) {
                    cache[item.path] = { hash, size: buffer.length, mtime: statMtime(absPath) };
                }
                result.uploaded++;
                result.uploadedFiles.push({ path: item.path, label: remoteRel, bytes: buffer.length });
                remoteTree[remoteRel] = { size: buffer.length, modified: remoteIndex[item.path].at };
            } catch (error) {
                result.errors.push({ path: item.path, action: 'upload', error: error.message });
            }
        }

        await writeRemoteIndex(config, remoteIndex, device, createdDirs);
        rememberRemote(changeState(directories, config), {
            remoteIndex, remoteTree, checkedAt: new Date().toISOString(),
        });
    } finally {
        await releaseLock(config, device);
    }

    result.plaintextRemaining = countPlaintext(remoteIndex, config.cryptoKey);
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
            const absPath = await applyDownloaded(directories, item.path, buffer, result);
            // 合成文件跳过 mtime 哈希缓存。
            if (!synthetic.isSynthetic(item.path)) {
                cache[item.path] = { hash: sha256(buffer), size: buffer.length, mtime: statMtime(absPath) };
            }
            result.downloaded++;
        } catch (error) {
            result.errors.push({ path: item.path, action: 'download', error: error.message });
        }
    }

    return finish(directories, device, cache, result, 'download');
}

/**
 * 写入下载内容并记录类别。
 * 合成文件按条目合并，普通文件直接写盘；两种下载入口共用此函数。
 */
async function applyDownloaded(directories, localRel, buffer, result) {
    let absPath;
    if (synthetic.isSynthetic(localRel)) {
        const merged = synthetic.merge(localRel, directories, buffer);
        // 保留最后一次合并的完整人设数据，供前端刷新。
        if (paths.categoryOf(localRel) === 'personas') result.personaData = merged.data;
        absPath = merged.absPath;
    } else {
        absPath = await writeLocal(directories, localRel, buffer);
    }
    noteTouched(result, localRel);
    return absPath;
}

/** 写入本地文件，同名直接覆盖。 */
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

/** 生成变更预览和云端明文文件计数。 */
async function planOnly(user, config, names) {
    const context = await collectContext(user, config, names);
    return {
        ...summarizePlan(buildPlan(context), names),
        checkedAt: new Date().toISOString(),
        remoteCheckedAt: context.checkedAt,
        plaintextRemaining: countPlaintext(context.remoteIndex, config.cryptoKey),
    };
}

// 角色聊天清单。

/**
 * 统计各角色的聊天数量与大小，键为角色卡文件名去扩展名。
 * 单条聊天明细由 chatEntries 按需读取。
 */
function chatCounts(directories) {
    const out = {};
    const base = directories.chats;
    if (!base || !fs.existsSync(base)) return out;

    let dirents;
    try {
        dirents = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return out;
    }

    for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        if (entryKind(base, dirent) !== 'dir') continue;
        const files = listDirFiles(path.join(base, dirent.name));
        out[dirent.name] = {
            files: files.length,
            bytes: files.reduce((sum, item) => sum + item.bytes, 0),
        };
    }
    return out;
}

/** 返回角色聊天文件明细；value 为 <角色目录名>/<聊天文件>，对应 scope.chats.selected。 */
function chatEntries(directories, stem) {
    const clean = String(stem || '').trim();
    // 校验角色目录名为单个路径段。
    if (!clean || clean.includes('/') || clean.includes('\\') || clean.includes('..')) return [];

    const dir = path.join(directories.chats || '', clean);
    return listDirFiles(dir)
        .map(item => ({
            value: `${clean}/${item.rel}`,
            label: item.rel.replace(/\.jsonl$/i, ''),
            bytes: item.bytes,
            modified: statMtime(path.join(dir, item.rel)),
        }))
        // 按修改时间倒序排列聊天。
        .sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));
}

// 预设与美化目录清单。

/** 递归列出目录下的文件，返回 { rel, bytes }；rel 是目录内的 POSIX 相对路径。 */
function listDirFiles(dir) {
    const out = [];
    if (!dir || !fs.existsSync(dir)) return out;

    const walk = (current, prefix) => {
        let dirents;
        try {
            dirents = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const dirent of dirents) {
            if (dirent.name.startsWith('.')) continue;
            const full = path.join(current, dirent.name);
            const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
            const kind = entryKind(current, dirent);
            if (kind === 'dir') {
                walk(full, rel);
            } else if (kind === 'file') {
                try {
                    out.push({ rel, bytes: fs.statSync(full).size });
                } catch {
                    // 跳过扫描期间已删除的文件。
                }
            }
        }
    };

    walk(dir, '');
    return out;
}

/** 显示文件名时去掉 .json 扩展名。 */
function prettyName(rel) {
    return rel.replace(/\.json$/i, '');
}

/**
 * 生成预设与美化目录清单。
 * detail 为真时附带 entries；背景图仅统计数量和大小，excluded 记录排除的自带图片数量。
 */
function scopeDirStats(directories) {
    const of = group => paths.rootsOfGroup(group).map(root => {
        const excludeSet = root.dirKey === 'backgrounds' ? builtin.builtinBackgrounds() : null;
        const all = listDirFiles(directories[root.dirKey]);
        const own = excludeSet ? all.filter(item => !excludeSet.has(item.rel)) : all;

        const stats = {
            key: root.dirKey,
            label: root.label,
            detail: root.detail === true,
            files: own.length,
            bytes: own.reduce((sum, item) => sum + item.bytes, 0),
        };
        if (stats.detail) {
            stats.entries = own
                .map(item => ({ value: item.rel, label: prettyName(item.rel), bytes: item.bytes }))
                .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
        } else if (excludeSet) {
            stats.excluded = all.length - own.length;
        }
        return stats;
    });
    return { presets: of('presets'), themes: of('themes') };
}

module.exports = {
    META_DIR,
    INDEX_NAME,
    KEYCHECK_NAME,
    NON_BACKUP_DIRS,
    sha256,
    newResult,
    noteTouched,
    readState,
    readRemoteIndex,
    writeRemoteIndex,
    remoteToLocalMap,
    resolveDevice,
    collectContext,
    prepareCrypto,
    planOnly,
    changesOnly,
    invalidateChanges,
    scopeDirStats,
    chatCounts,
    chatEntries,
    runUpload,
    runDownload,
    applyDownloaded,
    writeLocal,
    // 纯函数，供单元测试
    buildPlan,
    summarizePlan,
    countPlaintext,
};
