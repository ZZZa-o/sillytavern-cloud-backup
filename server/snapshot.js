/**
 * zip 全量快照。增量同步之外的灾难恢复兜底：
 * 同步逻辑复杂，出问题时需要一个能整体回滚的东西。
 */
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const { timestampForFile, ensureInside } = require('./util.js');
const { SNAPSHOT_DIR } = require('./paths.js');
const webdav = require('./webdav.js');

const MANIFEST_FILE = 'webdav-chat-backup-manifest.json';
const BACKUP_PREFIX = 'st-webdav-backup-';
const ARCHIVE_TYPE = 'sillytavern-webdav-chat-backup';

/** 快照内的目录布局。与同步区一致，恢复时不需要额外映射。 */
function archiveRoots(directories, include) {
    const roots = [];
    if (include.chats) roots.push(['chats', directories.chats]);
    if (include.groupChats) {
        roots.push(['group chats', directories.groupChats]);
        roots.push(['groups', directories.groups]);
    }
    if (include.characters) roots.push(['characters', directories.characters]);
    if (include.worlds) roots.push(['worlds', directories.worlds]);
    return roots;
}

async function createArchive(user, include, reason) {
    const entries = {};
    const manifest = {
        type: ARCHIVE_TYPE,
        version: 1,
        createdAt: new Date().toISOString(),
        reason: reason || 'manual',
        user: user.profile?.handle || 'unknown',
        include,
        files: [],
    };

    const addFile = async (source, relativePath) => {
        const stats = await fs.promises.stat(source);
        if (!stats.isFile()) return;
        const normalized = relativePath.replace(/\\/g, '/');
        entries[normalized] = new Uint8Array(await fs.promises.readFile(source));
        manifest.files.push({ path: normalized, size: stats.size, mtime: stats.mtime.toISOString() });
    };

    const addDirectory = async (sourceDir, targetDir) => {
        if (!sourceDir || !fs.existsSync(sourceDir)) return;
        const dirents = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        for (const dirent of dirents) {
            const source = path.join(sourceDir, dirent.name);
            const target = `${targetDir}/${dirent.name}`;
            if (dirent.isDirectory()) await addDirectory(source, target);
            else if (dirent.isFile()) await addFile(source, target);
        }
    };

    for (const [prefix, dir] of archiveRoots(user.directories, include)) {
        await addDirectory(dir, prefix);
    }

    // settings.json 不参与同步，但进快照，方便整机迁移时手动取用
    if (include.settings) {
        const settingsPath = path.join(user.directories.root, 'settings.json');
        if (fs.existsSync(settingsPath)) await addFile(settingsPath, 'settings.json');
    }

    entries[MANIFEST_FILE] = strToU8(JSON.stringify(manifest, null, 2));
    return { zipBuffer: Buffer.from(zipSync(entries, { level: 6 })), manifest };
}

async function upload(config, user, include, reason) {
    await webdav.ensureRoot(config);
    await webdav.ensureDir(config, [SNAPSHOT_DIR], new Set());
    const { zipBuffer, manifest } = await createArchive(user, include, reason);
    const fileName = `${BACKUP_PREFIX}${timestampForFile()}.zip`;
    await webdav.putBuffer(config, [SNAPSHOT_DIR, fileName], zipBuffer, 'application/zip');
    await prune(config);
    return {
        fileName,
        createdAt: manifest.createdAt,
        files: manifest.files.length,
        size: zipBuffer.length,
    };
}

/** 新快照在 snapshots/ 下，1.0 版本直接放在根目录，两处都要认。 */
async function list(config) {
    await webdav.ensureRoot(config);
    const seen = new Map();
    for (const segments of [[SNAPSHOT_DIR], []]) {
        try {
            const { files } = await webdav.listDir(config, segments);
            for (const file of files) {
                if (!file.name.startsWith(BACKUP_PREFIX) || !file.name.endsWith('.zip')) continue;
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

async function fetchArchive(config, fileName) {
    try {
        return await webdav.getBuffer(config, [SNAPSHOT_DIR, fileName]);
    } catch (error) {
        if (error.status !== 404) throw error;
    }
    return webdav.getBuffer(config, [fileName]);
}

async function remove(config, fileName) {
    await webdav.remove(config, [SNAPSHOT_DIR, fileName]);
    await webdav.remove(config, [fileName]);
}

async function prune(config) {
    const items = await list(config);
    for (const item of items.slice(config.retention)) {
        try {
            await webdav.remove(config, item.legacy ? [item.name] : [SNAPSHOT_DIR, item.name]);
        } catch (error) {
            console.warn('[WebDAV Chat Backup] 清理旧快照失败：', item.name, error.message);
        }
    }
}

function sanitizeFileName(input) {
    const name = path.posix.basename(String(input || '').replace(/\\/g, '/'));
    if (!name || !name.endsWith('.zip') || name.includes('..')) {
        throw new Error('备份文件名不正确。');
    }
    return name;
}

function normalizeZipPath(entryPath) {
    const parts = String(entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) {
        throw new Error(`备份包内路径不安全：${entryPath}`);
    }
    return parts.join('/');
}

function restoreTargetFor(directories, entryPath, include) {
    if (entryPath === 'settings.json') {
        if (!include.settings) return null;
        const target = path.resolve(directories.root, 'settings.json');
        ensureInside(directories.root, target);
        return target;
    }
    const pairs = [
        ['chats/', directories.chats, include.chats],
        ['group chats/', directories.groupChats, include.groupChats],
        ['groups/', directories.groups, include.groupChats],
        ['characters/', directories.characters, include.characters],
        ['worlds/', directories.worlds, include.worlds],
    ];
    for (const [prefix, base, enabled] of pairs) {
        if (!enabled || !base || !entryPath.startsWith(prefix)) continue;
        const target = path.resolve(base, entryPath.slice(prefix.length));
        ensureInside(base, target);
        return target;
    }
    return null;
}

async function restore(directories, buffer, include) {
    const archive = unzipSync(new Uint8Array(buffer));
    const manifestEntry = archive[MANIFEST_FILE];
    if (manifestEntry) {
        try {
            if (JSON.parse(strFromU8(manifestEntry)).type !== ARCHIVE_TYPE) throw new Error();
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
        const target = restoreTargetFor(directories, normalized, include);
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

module.exports = {
    MANIFEST_FILE,
    BACKUP_PREFIX,
    createArchive,
    upload,
    list,
    fetchArchive,
    remove,
    prune,
    restore,
    sanitizeFileName,
};
