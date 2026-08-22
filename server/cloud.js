/**
 * 云端文件管理：列举远端全部文件、指定下载、指定删除。
 *
 * 与 backup.js 的区别是这里不看备份范围，也不跳过元数据目录 ——
 * 用户要能看到网盘上到底有什么，包括插件自己的元数据和手动传上去的东西。
 */
const fs = require('node:fs');
const path = require('node:path');

const webdav = require('./webdav.js');
const backup = require('./backup.js');
const paths = require('./paths.js');

/** 远端顶层目录 → 前端分组标题。认不出来的归到"其他"。 */
const GROUPS = {
    [paths.REMOTE_CHARACTERS]: '角色卡',
    [paths.REMOTE_CHATS]: '聊天记录',
    [paths.REMOTE_WORLDS]: '世界书',
    [paths.REMOTE_PRESETS]: '预设',
    [paths.REMOTE_THEMES]: '美化',
    [paths.REMOTE_SETTINGS]: '设置',
};

function classify(remoteRel) {
    const top = String(remoteRel).split('/')[0];
    if (GROUPS[top]) return GROUPS[top];
    if (top === backup.META_DIR) return '插件元数据';
    return '其他';
}

/**
 * 列出远端所有文件。remote 是网盘上的真实路径，local 是它会被写回的本地相对路径；
 * local 为空表示这个文件对应不到酒馆数据目录（元数据、旧 zip、手动传的杂项）。
 */
async function list(config, names) {
    await webdav.ensureRoot(config);

    const tree = {};
    await webdav.walk(config, [], '', tree, []);

    const remoteIndex = await backup.readRemoteIndex(config);
    const fromIndex = backup.remoteToLocalMap(remoteIndex, names);

    return Object.entries(tree)
        .map(([remoteRel, meta]) => ({
            remote: remoteRel,
            local: fromIndex[remoteRel] || paths.toLocal(remoteRel, names) || '',
            group: classify(remoteRel),
            size: meta.size,
            modified: meta.modified,
        }))
        .sort((a, b) => a.remote.localeCompare(b.remote, 'zh-Hans-CN'));
}

/** 拒绝 .. 之类会穿出远端根目录的路径。 */
function sanitizeRemotePath(input) {
    const parts = String(input || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
        throw new Error(`云端路径不合法：${input}`);
    }
    return parts.join('/');
}

/**
 * 下载指定的云端文件。
 * 能对应到 SillyTavern 数据目录的直接写回原位（同名覆盖）；
 * 对应不上的（元数据、手动传上去的杂项）落到 backups/ 下，不污染数据目录。
 */
async function download(user, config, names, remotePaths) {
    const directories = user.directories;
    const remoteIndex = await backup.readRemoteIndex(config);
    const fromIndex = backup.remoteToLocalMap(remoteIndex, names);

    const fallbackRoot = path.join(directories.backups, `webdav-cloud-${backup.timestampForFile()}`);

    const result = {
        downloaded: 0,
        errors: [],
        written: [],
        fallbackDir: '',
        // 与 backup.js 同义：下载动了哪几类、动过哪些顶层目录
        touched: { characters: 0, chats: 0, worlds: 0, presets: 0, themes: 0, settings: 0, other: 0 },
        touchedDirs: [],
    };

    for (const raw of remotePaths) {
        let remoteRel = '';
        try {
            remoteRel = sanitizeRemotePath(raw);
            const buffer = await webdav.getBuffer(config, remoteRel.split('/'));
            const localRel = fromIndex[remoteRel] || paths.toLocal(remoteRel, names);

            if (localRel && paths.localAbsPath(directories, localRel)) {
                await backup.writeLocal(directories, localRel, buffer);
                result.written.push({ remote: remoteRel, target: localRel });
                backup.noteTouched(result, localRel);
            } else {
                const target = path.join(fallbackRoot, ...remoteRel.split('/'));
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                await fs.promises.writeFile(target, buffer);
                result.fallbackDir = path.resolve(fallbackRoot);
                result.written.push({ remote: remoteRel, target: path.resolve(target) });
            }
            result.downloaded++;
        } catch (error) {
            result.errors.push({ path: remoteRel || String(raw), action: 'download', error: error.message });
        }
    }

    return result;
}

/** 删除指定的云端文件，并把索引里对应的条目一起清掉，免得下次比对以为它还在。 */
async function remove(user, config, names, remotePaths) {
    const device = backup.resolveDevice(user.directories);
    const remoteIndex = await backup.readRemoteIndex(config);
    const fromIndex = backup.remoteToLocalMap(remoteIndex, names);

    const result = { deleted: 0, errors: [] };
    let indexChanged = false;

    for (const raw of remotePaths) {
        let remoteRel = '';
        try {
            remoteRel = sanitizeRemotePath(raw);
            await webdav.remove(config, remoteRel.split('/'));
            const localRel = fromIndex[remoteRel];
            if (localRel && remoteIndex[localRel]) {
                delete remoteIndex[localRel];
                indexChanged = true;
            }
            result.deleted++;
        } catch (error) {
            result.errors.push({ path: remoteRel || String(raw), action: 'delete', error: error.message });
        }
    }

    if (indexChanged) {
        await backup.writeRemoteIndex(config, remoteIndex, device);
    }
    return result;
}

module.exports = {
    list,
    download,
    remove,
    classify,
    sanitizeRemotePath,
};
