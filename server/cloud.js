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
const synthetic = require('./synthetic.js');

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

/** 云端那份 personas.json 的远端路径。 */
function personaManifestPath() {
    return `${paths.REMOTE_PERSONAS}/${paths.PERSONAS_FILE}`;
}

/**
 * 头像文件名 → 人设名，用于把云端的「1712345678901.png」显示成人看得懂的名字。
 *
 * 先认云端那份 personas.json —— 那才是这些头像的出处；本机的字典只作兜底
 * （云端还没传过 personas.json，但本机恰好有同名头像时还能显示出名字）。
 */
async function personaNames(config, tree, directories) {
    const local = directories ? synthetic.localPersonaNames(directories) : {};
    const remoteRel = personaManifestPath();
    if (!tree[remoteRel]) return local;
    try {
        const buffer = await webdav.getBuffer(config, remoteRel.split('/'));
        return { ...local, ...synthetic.personaNamesFromBuffer(buffer) };
    } catch {
        return local;
    }
}

/**
 * 列出远端所有文件。remote 是网盘上的真实路径，local 是它会被写回的本地相对路径；
 * local 为空表示这个文件对应不到酒馆数据目录（元数据、旧 zip、手动传的杂项）。
 * label 是给人看的名字，目前只有人设头像有 —— 它的文件名是个时间戳，光看认不出是谁。
 */
async function list(config, names, user) {
    await webdav.ensureRoot(config);

    const tree = {};
    await webdav.walk(config, [], '', tree, []);

    const remoteIndex = await backup.readRemoteIndex(config);
    const fromIndex = backup.remoteToLocalMap(remoteIndex, names);
    const personas = await personaNames(config, tree, user?.directories);

    return Object.entries(tree)
        .map(([remoteRel, meta]) => ({
            remote: remoteRel,
            local: fromIndex[remoteRel] || paths.toLocal(remoteRel, names) || '',
            group: classify(remoteRel),
            label: personaLabel(remoteRel, personas),
            size: meta.size,
            modified: meta.modified,
        }))
        .sort((a, b) => a.remote.localeCompare(b.remote, 'zh-Hans-CN'));
}

/** 人设文件的显示名。不是人设文件、或查不到名字时返回空串。 */
function personaLabel(remoteRel, personas) {
    const parts = String(remoteRel).split('/');
    if (parts[0] !== paths.REMOTE_PERSONAS) return '';

    // 新布局：用户人设/<人设名>/persona.json 与同文件夹里的头像图
    if (parts.length === 3) {
        return parts[2] === synthetic.PERSONA_FILE
            ? `${parts[1]} · 名字与描述`
            : `${parts[1]} · 头像`;
    }

    // 旧布局：整份 personas.json 与平铺的头像图，头像文件名是个时间戳，得翻译一下
    if (parts.length !== 2) return '';
    if (parts[1] === paths.PERSONAS_FILE) return '全部人设的名字与描述（旧版布局）';
    return personas[parts[1]] || '';
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
        touched: {
            characters: 0, chats: 0, worlds: 0, personas: 0,
            presets: 0, themes: 0, apiProfiles: 0, other: 0,
        },
        // 人设热加载要用，与 backup.js 的下载结果同义
        personaData: null,
        touchedDirs: [],
    };

    for (const raw of remotePaths) {
        let remoteRel = '';
        try {
            remoteRel = sanitizeRemotePath(raw);
            const buffer = await webdav.getBuffer(config, remoteRel.split('/'));
            const localRel = fromIndex[remoteRel] || paths.toLocal(remoteRel, names);

            if (localRel && paths.localAbsPath(directories, localRel)) {
                await backup.applyDownloaded(directories, localRel, buffer, result);
                result.written.push({ remote: remoteRel, target: localRel });
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
