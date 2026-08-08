const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const info = {
    id: 'webdav-chat-backup',
    name: 'WebDAV Chat Backup',
    description: 'Sync and back up SillyTavern chats, group chats, characters, and worlds to WebDAV.',
};

const SECRET_KEY = 'webdav_chat_backup_password';
const MANIFEST_FILE = 'webdav-chat-backup-manifest.json';
const BACKUP_PREFIX = 'st-webdav-backup-';

// 增量同步的远端布局
const SNAPSHOT_DIR = 'snapshots';
const SYNC_DIR = '.st-sync';
const INDEX_NAME = 'index.json';
const TOMBSTONE_NAME = 'tombstones.json';
const LOCK_NAME = 'lock.json';

const LOCK_TTL_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 本地同步基线
const STATE_DIR = '.webdav-chat-backup';
const STATE_FILE = 'sync-base.json';

function init(router) {
    router.post('/status', (request, response) => {
        const state = readState(request.user.directories);
        response.json({
            ok: true,
            helper: true,
            hasPassword: !!readWebDavPassword(request.user.directories),
            device: state.device || '',
            lastSyncAt: state.lastSyncAt || '',
            trackedFiles: Object.keys(state.base || {}).length,
        });
    });

    router.post('/test', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            await ensureRemoteRoot(config);
            const marker = `.webdav-chat-backup-test-${Date.now()}.txt`;
            await webDavRequest(config, [marker], {
                method: 'PUT',
                body: Buffer.from(`SillyTavern WebDAV test ${new Date().toISOString()}\n`, 'utf8'),
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            }, [200, 201, 204]);
            try {
                await webDavRequest(config, [marker], { method: 'DELETE' }, [200, 202, 204, 404]);
            } catch (error) {
                return { message: `连接可用，测试文件已上传；删除测试文件失败：${error.message}` };
            }
            return { message: '连接可用，远端目录可读写。' };
        });
    });

    // ---- 多端增量同步 ----

    router.post('/sync/plan', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const context = await collectSyncContext(request.user, config);
            const plan = buildPlan(context, config.direction);
            return { plan: summarizePlan(plan), device: context.device };
        });
    });

    router.post('/sync/apply', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const context = await collectSyncContext(request.user, config);
            const plan = buildPlan(context, config.direction);
            await acquireLock(config, context.device);
            try {
                return await applyPlan(config, context, plan);
            } finally {
                await releaseLock(config, context.device);
            }
        });
    });

    // ---- zip 全量快照（灾难恢复兜底） ----

    router.post('/list', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            return { items: await listBackups(config) };
        });
    });

    router.post('/backup', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            await ensureRemoteRoot(config);
            await mkcolRelative(config, [SNAPSHOT_DIR], new Set());
            const { zipBuffer, manifest } = await createBackupArchive(request.user, config.include, request.body?.reason);
            const fileName = `${BACKUP_PREFIX}${timestampForFile()}.zip`;
            await webDavRequest(config, [SNAPSHOT_DIR, fileName], {
                method: 'PUT',
                body: zipBuffer,
                headers: { 'Content-Type': 'application/zip' },
            }, [200, 201, 204]);
            await pruneBackups(config);
            return {
                fileName,
                createdAt: manifest.createdAt,
                files: manifest.files.length,
                size: zipBuffer.length,
            };
        });
    });

    router.post('/restore', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const fileName = sanitizeBackupFileName(request.body?.fileName);
            const buffer = await fetchBackupFile(config, fileName);
            return await restoreArchive(request.user.directories, buffer, config.include);
        });
    });

    router.post('/delete', async (request, response) => {
        await handle(response, async () => {
            const config = resolveConfig(request);
            const fileName = sanitizeBackupFileName(request.body?.fileName);
            await deleteBackupFile(config, fileName);
            return { deleted: fileName };
        });
    });
}

async function handle(response, fn) {
    try {
        const result = await fn();
        response.json({ ok: true, ...result });
    } catch (error) {
        console.error('[WebDAV Chat Backup]', error);
        response.status(500).json({ ok: false, error: error.message || String(error) });
    }
}

function resolveConfig(request) {
    const body = request.body?.settings || {};
    const url = String(body.url || '').trim();
    if (!url) {
        throw new Error('请先填写 WebDAV 地址。');
    }
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error();
        }
    } catch {
        throw new Error('WebDAV 地址格式不正确。');
    }

    const password = readWebDavPassword(request.user.directories);
    const include = normalizeInclude(body.include || {});
    if (!Object.values(include).some(Boolean)) {
        throw new Error('请至少选择一项备份内容。');
    }

    const direction = ['two-way', 'upload-only', 'download-only'].includes(body.direction)
        ? body.direction
        : 'two-way';

    return {
        url,
        username: String(body.username || '').trim(),
        password,
        remotePath: String(body.remotePath || '').trim(),
        include,
        direction,
        deviceName: String(body.deviceName || '').trim().slice(0, 40),
        retention: Math.max(1, Math.min(200, Number.parseInt(body.retention, 10) || 10)),
    };
}

function normalizeInclude(include) {
    return {
        chats: include.chats !== false,
        groupChats: include.groupChats !== false,
        characters: include.characters !== false,
        worlds: include.worlds !== false,
        settings: include.settings !== false,
    };
}

function readWebDavPassword(directories) {
    const file = path.join(directories.root, 'secrets.json');
    if (!fs.existsSync(file)) return '';
    try {
        const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
        const values = secrets[SECRET_KEY];
        if (!Array.isArray(values) || values.length === 0) return '';
        const active = values.find(item => item && item.active) || values[values.length - 1];
        return typeof active?.value === 'string' ? active.value : '';
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// WebDAV 基础请求
// ---------------------------------------------------------------------------

function splitRemotePath(remotePath) {
    return String(remotePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => part !== '.' && part !== '..');
}

function splitUrlPath(pathname) {
    return String(pathname || '/')
        .split('/')
        .filter(Boolean)
        .map(segment => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });
}

function buildRemoteUrl(config, extraSegments = [], includeRemotePath = true) {
    const target = new URL(config.url);
    const baseSegments = splitUrlPath(target.pathname);
    const segments = includeRemotePath
        ? [...splitRemotePath(config.remotePath), ...extraSegments]
        : extraSegments;
    target.pathname = `/${[...baseSegments, ...segments].map(segment => encodeURIComponent(segment)).join('/')}`;
    return target.toString();
}

function authHeaders(config) {
    const headers = {};
    if (config.username || config.password) {
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
    }
    return headers;
}

async function webDavRequest(config, extraSegments, options, expectedStatuses) {
    const url = buildRemoteUrl(config, extraSegments, options.includeRemotePath !== false);
    const headers = {
        ...authHeaders(config),
        ...(options.headers || {}),
    };
    const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
    });
    if (!expectedStatuses.includes(response.status)) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            text = '';
        }
        const detail = text ? `：${text.slice(0, 300)}` : '';
        const error = new Error(`WebDAV ${options.method} 失败 (${response.status})${detail}`);
        error.status = response.status;
        throw error;
    }
    return response;
}

async function ensureRemoteRoot(config) {
    const parts = splitRemotePath(config.remotePath);
    for (let index = 1; index <= parts.length; index++) {
        const current = parts.slice(0, index);
        await webDavRequest(config, current, { method: 'MKCOL', includeRemotePath: false }, [200, 201, 204, 405]);
    }
}

/** 在 remotePath 下按需创建多级子目录。created 用于单次同步内去重，避免重复 MKCOL。 */
async function mkcolRelative(config, segments, created) {
    const base = splitRemotePath(config.remotePath);
    for (let index = 1; index <= segments.length; index++) {
        const slice = segments.slice(0, index);
        const key = slice.join('/');
        if (created.has(key)) continue;
        await webDavRequest(config, [...base, ...slice], {
            method: 'MKCOL',
            includeRemotePath: false,
        }, [200, 201, 204, 405, 409]);
        created.add(key);
    }
}

// ---------------------------------------------------------------------------
// PROPFIND
// ---------------------------------------------------------------------------

function parsePropfindEntries(xml) {
    const responses = xml.match(/<[^>]*:?response[\s\S]*?<\/[^>]*:?response>/gi) || [];
    const items = [];
    for (const block of responses) {
        const href = firstXmlValue(block, 'href');
        if (!href) continue;
        const segments = hrefSegments(href);
        if (!segments.length) continue;
        const typeBlock = firstXmlValue(block, 'resourcetype') || '';
        items.push({
            name: segments.at(-1),
            depth: segments.length,
            isDir: /collection/i.test(typeBlock),
            size: Number(firstXmlValue(block, 'getcontentlength') || 0),
            modified: firstXmlValue(block, 'getlastmodified') || '',
        });
    }
    return items;
}

function hrefSegments(href) {
    let pathname = href;
    try {
        pathname = new URL(href, 'http://placeholder.local').pathname;
    } catch {
        pathname = href;
    }
    return String(pathname)
        .split('/')
        .filter(Boolean)
        .map(segment => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });
}

function firstXmlValue(block, tag) {
    const match = block.match(new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, 'i'));
    return match ? decodeXml(match[1].trim()) : '';
}

function decodeXml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * 列出远端一级目录。
 * 坚果云等服务不支持 Depth: infinity，所以只用 Depth: 1 逐层递归。
 */
async function listRemoteDir(config, segments) {
    const body = [
        '<?xml version="1.0" encoding="utf-8" ?>',
        '<d:propfind xmlns:d="DAV:">',
        '<d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop>',
        '</d:propfind>',
    ].join('');

    let response;
    try {
        response = await webDavRequest(config, segments, {
            method: 'PROPFIND',
            headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
            body,
        }, [207, 200]);
    } catch (error) {
        if (error.status === 404) return { files: [], dirs: [] };
        throw error;
    }

    const xml = await response.text();
    const selfDepth = splitUrlPath(new URL(buildRemoteUrl(config, segments)).pathname).length;
    const files = [];
    const dirs = [];
    for (const item of parsePropfindEntries(xml)) {
        // Depth:1 会把被请求的目录自身也返回，按路径深度跳过
        if (item.depth <= selfDepth) continue;
        if (item.isDir) dirs.push(item.name);
        else files.push(item);
    }
    return { files, dirs };
}

/** 递归遍历远端同步区，产出 { 远端相对路径: {size, modified} }。 */
async function walkRemote(config, segments, prefix, out) {
    const { files, dirs } = await listRemoteDir(config, segments);
    for (const file of files) {
        out[`${prefix}${file.name}`] = { size: file.size, modified: file.modified };
    }
    for (const dir of dirs) {
        if (!prefix && (dir === SYNC_DIR || dir === SNAPSHOT_DIR)) continue;
        await walkRemote(config, [...segments, dir], `${prefix}${dir}/`, out);
    }
}

// ---------------------------------------------------------------------------
// 远端 JSON 与并发锁
// ---------------------------------------------------------------------------

async function readRemoteJson(config, segments, fallback) {
    try {
        const response = await webDavRequest(config, segments, { method: 'GET' }, [200]);
        const text = await response.text();
        if (!text.trim()) return fallback;
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

async function writeRemoteJson(config, segments, value) {
    await webDavRequest(config, segments, {
        method: 'PUT',
        body: Buffer.from(JSON.stringify(value, null, 2), 'utf8'),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }, [200, 201, 204]);
}

/**
 * 用锁文件而不是 WebDAV 的 LOCK 方法：坚果云等服务对 LOCK 支持不完整。
 */
async function acquireLock(config, device) {
    const existing = await readRemoteJson(config, [SYNC_DIR, LOCK_NAME], null);
    if (existing && existing.at && existing.device && existing.device !== device) {
        const age = Date.now() - new Date(existing.at).getTime();
        if (Number.isFinite(age) && age >= 0 && age < LOCK_TTL_MS) {
            const minutes = Math.ceil((LOCK_TTL_MS - age) / 60000);
            throw new Error(`另一台设备（${existing.device}）正在同步，请约 ${minutes} 分钟后重试。`);
        }
    }
    await writeRemoteJson(config, [SYNC_DIR, LOCK_NAME], {
        device,
        at: new Date().toISOString(),
    });
}

async function releaseLock(config, device) {
    try {
        const existing = await readRemoteJson(config, [SYNC_DIR, LOCK_NAME], null);
        if (existing && existing.device && existing.device !== device) return;
        await webDavRequest(config, [SYNC_DIR, LOCK_NAME], { method: 'DELETE' }, [200, 202, 204, 404]);
    } catch (error) {
        console.warn('[WebDAV Chat Backup] 释放同步锁失败：', error.message);
    }
}

// ---------------------------------------------------------------------------
// 本地扫描
// ---------------------------------------------------------------------------

/**
 * 参与同步的目录。
 * settings.json 刻意不参与同步：它含 API 地址等设备相关配置，
 * 跨设备互相覆盖会让另一台直接不可用。它只进 zip 快照。
 */
function syncRoots(directories, include) {
    const roots = [];
    if (include.chats) roots.push({ prefix: 'chats', dir: directories.chats });
    if (include.groupChats) {
        roots.push({ prefix: 'group chats', dir: directories.groupChats });
        roots.push({ prefix: 'groups', dir: directories.groups });
    }
    if (include.characters) roots.push({ prefix: 'characters', dir: directories.characters });
    if (include.worlds) roots.push({ prefix: 'worlds', dir: directories.worlds });
    return roots;
}

function localPathFor(directories, relPath) {
    const pairs = [
        ['chats/', directories.chats],
        ['group chats/', directories.groupChats],
        ['groups/', directories.groups],
        ['characters/', directories.characters],
        ['worlds/', directories.worlds],
    ];
    for (const [prefix, base] of pairs) {
        if (!relPath.startsWith(prefix)) continue;
        try {
            const target = path.resolve(base, relPath.slice(prefix.length));
            ensureInside(base, target);
            return target;
        } catch {
            return null;
        }
    }
    return null;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function scanLocal(directories, include, hashCache) {
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
        // 大小与 mtime 都没变就复用上次的哈希，避免每次同步全量读盘
        const hash = (cached && cached.hash && cached.size === stats.size && cached.mtime === mtime)
            ? cached.hash
            : sha256(await fs.promises.readFile(full));
        out[rel] = { hash, size: stats.size, mtime };
    }
}

// ---------------------------------------------------------------------------
// 本地同步基线
// ---------------------------------------------------------------------------

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
    const generated = `device-${crypto.randomBytes(3).toString('hex')}`;
    state.device = generated;
    writeState(directories, state);
    return generated;
}

// ---------------------------------------------------------------------------
// 远端路径安全化
// ---------------------------------------------------------------------------

// 只处理在 WebDAV / Windows 上真正非法的字符，空格与连字符必须保留，
// 因为 SillyTavern 的聊天文件名形如 "2026-08-01 12h30m.jsonl"。
const ILLEGAL_SEGMENT = /[\\/:*?"<>|]/g;

function safeSegment(name) {
    const raw = String(name);
    const cleaned = raw.replace(ILLEGAL_SEGMENT, '_').replace(/[.\s]+$/, '');
    if (!cleaned) return `_${sha256(Buffer.from(raw, 'utf8')).slice(0, 8)}`;
    if (cleaned === raw) return cleaned;
    // 名字被改动过，补一段哈希避免不同角色被压成同一个目录
    return `${cleaned}~${sha256(Buffer.from(raw, 'utf8')).slice(0, 8)}`;
}

function safeRelPath(relPath) {
    return relPath.split('/').map(safeSegment).join('/');
}

// ---------------------------------------------------------------------------
// 同步上下文
// ---------------------------------------------------------------------------

async function collectSyncContext(user, config) {
    const directories = user.directories;
    const device = resolveDevice(directories, config.deviceName);
    const state = readState(directories);

    await ensureRemoteRoot(config);

    const local = await scanLocal(directories, config.include, state.base || {});

    const rawIndex = await readRemoteJson(config, [SYNC_DIR, INDEX_NAME], null);
    const remoteIndex = rawIndex?.entries && typeof rawIndex.entries === 'object' ? rawIndex.entries : {};

    const rawTombstones = await readRemoteJson(config, [SYNC_DIR, TOMBSTONE_NAME], null);
    const tombstones = rawTombstones?.entries && typeof rawTombstones.entries === 'object' ? rawTombstones.entries : {};

    // 实际远端文件树，用来发现手动增删
    const remoteTree = {};
    await walkRemote(config, [], '', remoteTree);

    // 远端安全路径 -> 本地原始路径
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
        base: state.base || {},
        local,
        remoteIndex,
        remotePresent,
        tombstones,
        include: config.include,
    };
}

// ---------------------------------------------------------------------------
// 三方比较
// ---------------------------------------------------------------------------

function pathAllowed(relPath, include) {
    if (relPath.startsWith('chats/')) return !!include.chats;
    if (relPath.startsWith('group chats/') || relPath.startsWith('groups/')) return !!include.groupChats;
    if (relPath.startsWith('characters/')) return !!include.characters;
    if (relPath.startsWith('worlds/')) return !!include.worlds;
    return false;
}

/**
 * 三方比较：本地、远端、上次同步基线。
 * 只有本地和远端都相对基线发生了变化，才算真冲突。
 */
function buildPlan(context, direction) {
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

const PLAN_PREVIEW_LIMIT = 40;

function summarizePlan(plan) {
    const preview = items => items.slice(0, PLAN_PREVIEW_LIMIT).map(item => ({ path: item.path, reason: item.reason }));
    const maxLength = Math.max(
        plan.upload.length,
        plan.download.length,
        plan.conflict.length,
        plan.deleteLocal.length,
        plan.deleteRemote.length,
    );
    return {
        counts: {
            upload: plan.upload.length,
            download: plan.download.length,
            conflict: plan.conflict.length,
            deleteLocal: plan.deleteLocal.length,
            deleteRemote: plan.deleteRemote.length,
            unchanged: plan.unchanged,
            skipped: plan.skipped.length,
        },
        upload: preview(plan.upload),
        download: preview(plan.download),
        conflict: preview(plan.conflict),
        deleteLocal: preview(plan.deleteLocal),
        deleteRemote: preview(plan.deleteRemote),
        truncated: maxLength > PLAN_PREVIEW_LIMIT,
    };
}

// ---------------------------------------------------------------------------
// .jsonl 快进合并
// ---------------------------------------------------------------------------

function splitJsonlLines(buffer) {
    return buffer.toString('utf8').split('\n').filter(line => line.trim().length > 0);
}

/**
 * SillyTavern 的聊天是逐行追加的 .jsonl，所以可以像 git 那样判断快进：
 * 若一方是另一方的行前缀，直接取更长的那份，不必当成冲突。
 * 改写已有消息（含 swipes）会让公共前缀提前中断，此时保守地判为分叉。
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

function isChatPath(relPath) {
    return relPath.startsWith('chats/') || relPath.startsWith('group chats/');
}

function conflictPathFor(relPath, device, stamp) {
    const ext = path.posix.extname(relPath);
    const stem = relPath.slice(0, relPath.length - ext.length);
    return `${stem} (冲突 ${device} ${stamp})${ext}`;
}

// ---------------------------------------------------------------------------
// 执行同步
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

    // 任何覆盖或删除之前，本地原文件先进保护副本目录
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
        await mkcolRelative(config, segments.slice(0, -1), createdDirs);
        await webDavRequest(config, segments, {
            method: 'PUT',
            body: buffer,
            headers: { 'Content-Type': 'application/octet-stream' },
        }, [200, 201, 204]);
        const hash = sha256(buffer);
        const at = new Date().toISOString();
        remoteIndex[relPath] = { hash, size: buffer.length, remote: remoteRel, device, at };
        base[relPath] = { hash, size: buffer.length, mtime: statMtime(localPathFor(directories, relPath)), syncedAt: at };
        delete tombstones[relPath];
    };

    const downloadFile = async (relPath) => {
        const remoteRel = remoteIndex[relPath]?.remote || safeRelPath(relPath);
        const response = await webDavRequest(config, remoteRel.split('/'), { method: 'GET' }, [200]);
        return Buffer.from(await response.arrayBuffer());
    };

    const writeLocal = async (relPath, buffer) => {
        const absPath = localPathFor(directories, relPath);
        if (!absPath) throw new Error(`无法解析本地路径：${relPath}`);
        await protectLocal(relPath, absPath);
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await fs.promises.writeFile(absPath, buffer);
        const hash = sha256(buffer);
        const at = new Date().toISOString();
        base[relPath] = { hash, size: buffer.length, mtime: statMtime(absPath), syncedAt: at };
        if (!remoteIndex[relPath]) {
            remoteIndex[relPath] = { hash, size: buffer.length, remote: safeRelPath(relPath), device, at };
        }
    };

    for (const item of plan.upload) {
        try {
            const absPath = localPathFor(directories, item.path);
            if (!absPath || !fs.existsSync(absPath)) continue;
            await uploadFile(item.path, await fs.promises.readFile(absPath));
            result.uploaded++;
        } catch (error) {
            result.errors.push({ path: item.path, action: 'upload', error: error.message });
        }
    }

    for (const item of plan.download) {
        try {
            await writeLocal(item.path, await downloadFile(item.path));
            result.downloaded++;
        } catch (error) {
            result.errors.push({ path: item.path, action: 'download', error: error.message });
        }
    }

    for (const item of plan.conflict) {
        try {
            const absPath = localPathFor(directories, item.path);
            const localBuffer = absPath && fs.existsSync(absPath) ? await fs.promises.readFile(absPath) : null;

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
                // 真分叉：远端版本占用原名，本地版本另存为一条独立分支。
                // 这样两台设备最终都拥有两个版本，且不会反复再生成新的冲突文件。
                const conflictRel = conflictPathFor(item.path, device, stamp);
                await writeLocal(conflictRel, localBuffer);
                await uploadFile(conflictRel, localBuffer);
                await writeLocal(item.path, remoteBuffer);
                result.conflicts++;
                result.conflictFiles.push({ path: item.path, kept: conflictRel, commonLines: analysis.common });
                continue;
            }

            // 角色卡与世界书没有行级语义，无法合并：远端优先，本地进保护副本
            await writeLocal(item.path, remoteBuffer);
            result.conflicts++;
            result.conflictFiles.push({ path: item.path, kept: `backups/webdav-sync-${stamp}/${item.path}` });
        } catch (error) {
            result.errors.push({ path: item.path, action: 'conflict', error: error.message });
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
            result.errors.push({ path: item.path, action: 'delete-local', error: error.message });
        }
    }

    for (const item of plan.deleteRemote) {
        try {
            const remoteRel = remoteIndex[item.path]?.remote || safeRelPath(item.path);
            await webDavRequest(config, remoteRel.split('/'), { method: 'DELETE' }, [200, 202, 204, 404]);
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
            result.errors.push({ path: item.path, action: 'delete-remote', error: error.message });
        }
    }

    for (const relPath of Object.keys(base)) {
        const absPath = localPathFor(directories, relPath);
        if (!remoteIndex[relPath] && (!absPath || !fs.existsSync(absPath))) {
            delete base[relPath];
        }
    }

    await mkcolRelative(config, [SYNC_DIR], createdDirs);
    await writeRemoteJson(config, [SYNC_DIR, INDEX_NAME], {
        version: 2,
        updatedAt: new Date().toISOString(),
        updatedBy: device,
        entries: remoteIndex,
    });
    await writeRemoteJson(config, [SYNC_DIR, TOMBSTONE_NAME], {
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

function statMtime(absPath) {
    try {
        return fs.statSync(absPath).mtime.toISOString();
    } catch {
        return '';
    }
}

function pruneTombstones(tombstones) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [key, value] of Object.entries(tombstones)) {
        const at = new Date(value?.at || 0).getTime();
        if (!Number.isFinite(at) || at < cutoff) delete tombstones[key];
    }
    return tombstones;
}

// ---------------------------------------------------------------------------
// zip 全量快照
// ---------------------------------------------------------------------------

async function listBackups(config) {
    await ensureRemoteRoot(config);
    const seen = new Map();
    // 新快照在 snapshots/ 下，旧版本直接放在根目录，两处都要列
    for (const segments of [[SNAPSHOT_DIR], []]) {
        try {
            const { files } = await listRemoteDir(config, segments);
            for (const file of files) {
                if (!file.name.endsWith('.zip') || !file.name.startsWith(BACKUP_PREFIX)) continue;
                if (seen.has(file.name)) continue;
                seen.set(file.name, {
                    name: file.name,
                    size: file.size,
                    modified: file.modified,
                    legacy: segments.length === 0,
                });
            }
        } catch (error) {
            console.warn('[WebDAV Chat Backup] 列举快照失败：', error.message);
        }
    }
    return [...seen.values()].sort(
        (a, b) => new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime(),
    );
}

async function fetchBackupFile(config, fileName) {
    try {
        const response = await webDavRequest(config, [SNAPSHOT_DIR, fileName], { method: 'GET' }, [200]);
        return Buffer.from(await response.arrayBuffer());
    } catch (error) {
        if (error.status !== 404) throw error;
    }
    const legacy = await webDavRequest(config, [fileName], { method: 'GET' }, [200]);
    return Buffer.from(await legacy.arrayBuffer());
}

async function deleteBackupFile(config, fileName) {
    await webDavRequest(config, [SNAPSHOT_DIR, fileName], { method: 'DELETE' }, [200, 202, 204, 404]);
    await webDavRequest(config, [fileName], { method: 'DELETE' }, [200, 202, 204, 404]);
}

async function createBackupArchive(user, include, reason) {
    const entries = {};
    const manifest = {
        type: 'sillytavern-webdav-chat-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        reason: reason || 'manual',
        user: user.profile?.handle || 'unknown',
        include,
        files: [],
    };

    async function addFile(source, relativePath) {
        const stats = await fs.promises.stat(source);
        if (!stats.isFile()) return;
        const normalized = relativePath.replace(/\\/g, '/');
        entries[normalized] = new Uint8Array(await fs.promises.readFile(source));
        manifest.files.push({
            path: normalized,
            size: stats.size,
            mtime: stats.mtime.toISOString(),
        });
    }

    async function addDirectory(sourceDir, targetDir) {
        if (!fs.existsSync(sourceDir)) return;
        const dirents = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        for (const dirent of dirents) {
            const source = path.join(sourceDir, dirent.name);
            const target = `${targetDir}/${dirent.name}`;
            if (dirent.isDirectory()) {
                await addDirectory(source, target);
            } else if (dirent.isFile()) {
                await addFile(source, target);
            }
        }
    }

    if (include.chats) {
        await addDirectory(user.directories.chats, 'chats');
    }
    if (include.groupChats) {
        await addDirectory(user.directories.groupChats, 'group chats');
        await addDirectory(user.directories.groups, 'groups');
    }
    if (include.characters) {
        await addDirectory(user.directories.characters, 'characters');
    }
    if (include.worlds) {
        await addDirectory(user.directories.worlds, 'worlds');
    }
    if (include.settings) {
        const settingsPath = path.join(user.directories.root, 'settings.json');
        if (fs.existsSync(settingsPath)) {
            await addFile(settingsPath, 'settings.json');
        }
    }

    entries[MANIFEST_FILE] = strToU8(JSON.stringify(manifest, null, 2));
    const zipBuffer = Buffer.from(zipSync(entries, { level: 6 }));
    return { zipBuffer, manifest };
}

async function pruneBackups(config) {
    const items = await listBackups(config);
    const stale = items.slice(config.retention);
    for (const item of stale) {
        try {
            const segments = item.legacy ? [item.name] : [SNAPSHOT_DIR, item.name];
            await webDavRequest(config, segments, { method: 'DELETE' }, [200, 202, 204, 404]);
        } catch (error) {
            console.warn('[WebDAV Chat Backup] Failed to prune backup:', item.name, error.message);
        }
    }
}

function sanitizeBackupFileName(input) {
    const name = path.posix.basename(String(input || '').replace(/\\/g, '/'));
    if (!name || !name.endsWith('.zip') || name.includes('..')) {
        throw new Error('备份文件名不正确。');
    }
    return name;
}

async function restoreArchive(directories, buffer, include) {
    const archive = unzipSync(new Uint8Array(buffer));
    const manifestEntry = archive[MANIFEST_FILE];
    if (manifestEntry) {
        try {
            const manifest = JSON.parse(strFromU8(manifestEntry));
            if (manifest.type !== 'sillytavern-webdav-chat-backup') {
                throw new Error();
            }
        } catch {
            throw new Error('备份清单无法识别。');
        }
    }

    const protectionRoot = path.join(directories.backups, `webdav-restore-${timestampForFile()}`);
    let restored = 0;
    let protectedCount = 0;

    for (const [entryPath, data] of Object.entries(archive)) {
        const normalized = normalizeZipPath(entryPath);
        if (!normalized || normalized === MANIFEST_FILE || normalized.endsWith('/')) continue;
        const target = resolveRestoreTarget(directories, normalized, include);
        if (!target) continue;
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) {
            const protectPath = path.join(protectionRoot, normalized);
            await fs.promises.mkdir(path.dirname(protectPath), { recursive: true });
            await fs.promises.copyFile(target, protectPath);
            protectedCount++;
        }
        await fs.promises.writeFile(target, Buffer.from(data));
        restored++;
    }

    return {
        restored,
        protected: protectedCount,
        protectionDir: protectedCount > 0 ? protectionRoot : '',
    };
}

function normalizeZipPath(entryPath) {
    const normalized = String(entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) {
        throw new Error(`备份包内路径不安全：${entryPath}`);
    }
    return parts.join('/');
}

function resolveRestoreTarget(directories, entryPath, include) {
    const pairs = [
        ['chats/', directories.chats, include.chats],
        ['group chats/', directories.groupChats, include.groupChats],
        ['groups/', directories.groups, include.groupChats],
        ['characters/', directories.characters, include.characters],
        ['worlds/', directories.worlds, include.worlds],
    ];
    if (entryPath === 'settings.json') {
        if (!include.settings) return null;
        const target = path.resolve(directories.root, 'settings.json');
        ensureInside(directories.root, target);
        return target;
    }
    for (const [prefix, base, enabled] of pairs) {
        if (!enabled || !entryPath.startsWith(prefix)) continue;
        const target = path.resolve(base, entryPath.slice(prefix.length));
        ensureInside(base, target);
        return target;
    }
    return null;
}

function ensureInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`目标路径越界：${child}`);
    }
}

function timestampForFile() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

module.exports = {
    info,
    init,
    // 仅供单元测试使用，运行时不依赖
    __test: {
        analyzeJsonl,
        buildPlan,
        safeSegment,
        safeRelPath,
        pathAllowed,
        conflictPathFor,
        pruneTombstones,
        summarizePlan,
    },
};
