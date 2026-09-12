/**
 * 云端文件管理：列举、下载和删除指定文件。
 * 列表包含全部远端文件及元数据，独立于备份范围。
 */
const webdav = require('./webdav.js');
const backup = require('./backup.js');
const paths = require('./paths.js');
const synthetic = require('./synthetic.js');
const { createCopyPlan } = require('./download-copies.js');

/** 远端顶层目录 → 前端分组标题。认不出来的归到"其他"。 */
const GROUPS = {
    [paths.REMOTE_CHARACTERS]: '角色卡',
    [paths.REMOTE_CHATS]: '聊天记录',
    [paths.REMOTE_PERSONAS]: '用户人设',
    [paths.REMOTE_PRESETS]: '预设',
    [paths.REMOTE_THEMES]: '美化',
    [paths.REMOTE_WORLDS]: '世界书',
    [paths.REMOTE_API]: 'API 配置',
};

function classify(remoteRel) {
    const top = String(remoteRel).split('/')[0];
    if (GROUPS[top]) return GROUPS[top];
    if (top === backup.META_DIR) return '插件元数据';
    return '其他';
}

/**
 * 列出远端文件：remote 为云端路径，local 为对应的本地相对路径。
 * 无法映射时 local 为空；label 为人设文件的显示名。
 */
async function list(config, names) {
    const tree = {};
    await webdav.walk(config, [], '', tree, []);

    const remoteIndex = await backup.readRemoteIndex(config);
    const fromIndex = backup.remoteToLocalMap(remoteIndex, names);

    return Object.entries(tree)
        .map(([remoteRel, meta]) => ({
            remote: remoteRel,
            local: fromIndex[remoteRel] || paths.toLocal(remoteRel, names) || '',
            group: classify(remoteRel),
            label: personaLabel(remoteRel),
            size: meta.size,
            modified: meta.modified,
        }))
        .sort((a, b) => a.remote.localeCompare(b.remote, 'zh-Hans-CN'));
}

/** 人设文件的显示名。不是人设文件、或查不到名字时返回空串。 */
function personaLabel(remoteRel) {
    const parts = String(remoteRel).split('/');
    if (parts[0] !== paths.REMOTE_PERSONAS) return '';

    // 用户人设/<人设名>/persona.json 与同文件夹里的头像图
    if (parts.length === 3) {
        return parts[2] === synthetic.PERSONA_FILE
            ? `${parts[1]} · 名字与描述`
            : `${parts[1]} · 头像`;
    }

    return '';
}

/** 拒绝 .. 之类会穿出远端根目录的路径。 */
function sanitizeRemotePath(input) {
    const parts = String(input || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
        throw new Error(`云端路径不合法：${input}`);
    }
    return parts.join('/');
}

/** 下载选中文件并写回酒馆对应目录。 */
async function download(user, config, names, remotePaths, { overwrite = true } = {}) {
    const directories = user.directories;
    const remoteIndex = await backup.readRemoteIndex(config);
    const fromIndex = backup.remoteToLocalMap(remoteIndex, names);

    const result = {
        downloaded: 0,
        overwrite,
        errors: [],
        written: [],
        // 记录下载涉及的类别与顶层目录。
        touched: {
            characters: 0, chats: 0, worlds: 0, personas: 0,
            presets: 0, themes: 0, apiProfiles: 0, other: 0,
        },
        // 保存供前端刷新的人设数据。
        personaData: null,
        touchedDirs: [],
    };

    const entries = [];
    const seen = new Set();
    for (const raw of remotePaths) {
        let remoteRel = '';
        try {
            remoteRel = sanitizeRemotePath(raw);
            const localRel = fromIndex[remoteRel] || paths.toLocal(remoteRel, names);
            if (!localRel) throw new Error('该文件无法导入酒馆。');
            if (!seen.has(remoteRel)) entries.push({ remote: remoteRel, local: localRel, target: localRel });
            seen.add(remoteRel);
        } catch (error) {
            result.errors.push({ path: remoteRel || String(raw), action: 'download', error: error.message });
        }
    }

    const copies = overwrite ? null : createCopyPlan(directories, entries);
    for (const entry of copies?.entries || entries) {
        try {
            if (entry.error) throw new Error(entry.error);
            let buffer = await webdav.getBuffer(config, entry.remote.split('/'));
            // 合成条目的查重与同步合并之间不让出执行权，避免并发导入重用名称。
            if (copies) buffer = copies.prepare(entry, buffer);
            await backup.applyDownloaded(directories, entry.target, buffer, result, { overwrite });
            entry.complete = true;
            result.written.push({ remote: entry.remote, target: entry.target });
            result.downloaded++;
        } catch (error) {
            entry.error = error.message;
            result.errors.push({ path: entry.remote, action: 'download', error: error.message });
        }
    }

    return result;
}

/** 删除指定云端文件及对应索引条目。 */
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
