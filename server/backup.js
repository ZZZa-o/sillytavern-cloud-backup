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
const builtin = require('./builtin.js');
const synthetic = require('./synthetic.js');

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
    // 合成文件每次都从 settings.json / secrets.json 现拼一遍再算哈希：
    // 源数据一改哈希就变，下次备份必然识别为需要更新。
    // 不套 mtime 缓存是因为那样两头都不准 —— 酒馆频繁改写 settings.json，
    // mtime 变了不代表人设变了；反过来也一样。反正只有几 KB，现算最可靠。
    for (const group of ['personas', 'apiProfiles']) {
        const file = synthetic.fileOfGroup(group);
        if (!file || !paths.inScope(file, scope)) continue;
        const buffer = synthetic.build(file, directories, scope);
        out[file] = { hash: sha256(buffer), size: buffer.length, mtime: '' };
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

const STATE_DIR = '.sillytavern-cloud-backup';
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
        console.warn('[SillyTavern Cloud Backup] 释放锁失败：', error.message);
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
        touched: {
            characters: 0, chats: 0, worlds: 0, personas: 0,
            presets: 0, themes: 0, apiProfiles: 0, other: 0,
        },
        // 动过的顶层目录名。热刷新的粒度有时细于类别 ——
        // 比如「美化」里 backgrounds 要单独调一次背景列表接口，QuickReplies 则根本没有热加载入口。
        touchedDirs: [],
        // 人设热加载要用：合并后的 power_user 三件套，前端直接写进内存就能看到
        personaData: null,
    };
}

/** 记一笔某个本地路径被写入了，供前端决定刷哪个列表。 */
function noteTouched(result, localRel) {
    result.touched[paths.categoryOf(localRel)]++;
    const top = String(localRel).split('/')[0];
    if (top && !result.touchedDirs.includes(top)) result.touchedDirs.push(top);
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
                const isSynthetic = synthetic.isSynthetic(item.path);
                const absPath = paths.localAbsPath(directories, item.path);
                if (!absPath || !fs.existsSync(absPath)) continue;
                const remoteRel = paths.toRemote(item.path, names);
                if (!remoteRel) continue;

                // 合成文件现拼出来，磁盘上没有它对应的文件
                const buffer = isSynthetic
                    ? synthetic.build(item.path, directories, config.scope)
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
                };
                // 合成文件没有稳定的 mtime 可比，不进哈希缓存
                if (!isSynthetic) {
                    cache[item.path] = { hash, size: buffer.length, mtime: statMtime(absPath) };
                }
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
            const absPath = await applyDownloaded(directories, item.path, buffer, result);
            // 合成文件没有稳定的 mtime 可比，不进哈希缓存
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
 * 把下载到的一个文件落地，并记一笔它属于哪一类。
 * 合成文件走各自的合并（只改 settings.json 里那几个字段），其余直接写盘。
 * 「从云端下载」与「云端文件 → 下载选中」两条路都走这里，行为必须一致。
 */
async function applyDownloaded(directories, localRel, buffer, result) {
    let absPath;
    if (synthetic.isSynthetic(localRel)) {
        const merged = synthetic.merge(localRel, directories, buffer);
        // 人设能热加载，把合并后的结果带回前端，省得让用户刷新页面
        if (localRel === synthetic.PERSONAS_FILE) result.personaData = merged.data;
        absPath = merged.absPath;
    } else {
        absPath = await writeLocal(directories, localRel, buffer);
    }
    noteTouched(result, localRel);
    return absPath;
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

// ---------------------------------------------------------------------------
// 聊天清单：范围弹窗里每张角色卡是一个文件夹，展开就能勾具体某一条聊天
// ---------------------------------------------------------------------------

/**
 * 每个角色目录下有几条聊天、多大。键是角色目录名（角色卡文件名去扩展名）。
 *
 * 只 readdir 不读文件内容，几百个角色也就是几百次目录读取。
 * 明细不在这里给 —— 角色多起来一次性回传能到几百 KB，改由 chatEntries 按需拿。
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
        if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
        const files = listDirFiles(path.join(base, dirent.name));
        out[dirent.name] = {
            files: files.length,
            bytes: files.reduce((sum, item) => sum + item.bytes, 0),
        };
    }
    return out;
}

/**
 * 某个角色的聊天文件明细。value 是 `<角色目录名>/<聊天文件>`，
 * 与范围里 scope.chats.selected 存的形式一致，前端拿到就能直接比对勾选态。
 */
function chatEntries(directories, stem) {
    const clean = String(stem || '').trim();
    // 目录名来自角色卡文件名，正常不含分隔符；挡一下手工构造的请求
    if (!clean || clean.includes('/') || clean.includes('\\') || clean.includes('..')) return [];

    const dir = path.join(directories.chats || '', clean);
    return listDirFiles(dir)
        .map(item => ({
            value: `${clean}/${item.rel}`,
            label: item.rel.replace(/\.jsonl$/i, ''),
            bytes: item.bytes,
            modified: statMtime(path.join(dir, item.rel)),
        }))
        // 新的排在前面 —— 跨设备接续聊天时找的永远是最近那条
        .sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));
}

// ---------------------------------------------------------------------------
// 目录清单：范围弹窗要按目录列出具体文件，好让用户勾到单个预设、单个主题
// ---------------------------------------------------------------------------

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
            if (dirent.isDirectory()) {
                walk(full, rel);
            } else if (dirent.isFile()) {
                try {
                    out.push({ rel, bytes: fs.statSync(full).size });
                } catch {
                    // 扫描期间文件被删掉了，跳过就好
                }
            }
        }
    };

    walk(dir, '');
    return out;
}

/** 主题与预设都是 json，列表里带着扩展名只是噪音。背景图不出明细，不受影响。 */
function prettyName(rel) {
    return rel.replace(/\.json$/i, '');
}

/**
 * 预设与美化两组各自的目录清单。
 *
 * detail 为真的目录带上 entries（具体文件），弹窗展开就能逐个勾；
 * 背景图只给总数与体积，且**已扣掉酒馆自带的那些** —— excluded 是扣掉的张数，
 * 界面上要交代清楚，否则用户会以为插件把他的图弄丢了。
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
    NON_BACKUP_DIRS,
    sha256,
    timestampForFile,
    newResult,
    noteTouched,
    readState,
    readRemoteIndex,
    writeRemoteIndex,
    remoteToLocalMap,
    resolveDevice,
    collectContext,
    planOnly,
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
};
