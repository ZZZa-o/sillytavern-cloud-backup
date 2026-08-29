/**
 * SillyTavern 服务端插件入口。各文件分工：
 *
 *   index.js   路由注册（本文件）
 *   config.js  插件自管配置（含密码）
 *   paths.js   本地路径 ↔ 远端路径映射，以及备份范围判定
 *   backup.js  上传 / 下载 / 预览
 *   cloud.js   云端文件管理：列举、指定下载、指定删除
 *   cards.js   解析 png 取出内嵌世界书的名字
 *   builtin.js 认出酒馆自带的内容（背景图），全选时跳过
 *   webdav.js  WebDAV 通信原语
 *
 * 连接信息与范围都从插件自己的 config.json 读，前端不再随请求携带地址与密码；
 * 唯一随请求带上的是「avatar 文件名 → 角色名」映射 —— 只有酒馆前端知道 png 里的角色叫什么。
 */
const configStore = require('./config.js');
const paths = require('./paths.js');
const webdav = require('./webdav.js');
const backup = require('./backup.js');
const cloud = require('./cloud.js');
const cards = require('./cards.js');
const builtin = require('./builtin.js');
const synthetic = require('./synthetic.js');

const info = {
    id: 'sillytavern-cloud-backup',
    name: 'SillyTavern Cloud Backup',
    description: 'Back up SillyTavern characters, chats, worlds, presets, themes, and settings to WebDAV.',
};

async function handle(response, fn) {
    try {
        response.json({ ok: true, ...(await fn()) });
    } catch (error) {
        console.error('[SillyTavern Cloud Backup]', error);
        response.status(500).json({ ok: false, error: error.message || String(error) });
    }
}

/** 角色名映射；前端没带就退化成用 avatar 文件名当角色名，功能不受影响只是网盘里不好认。 */
function readNames(request) {
    const raw = request.body?.characterNames;
    return paths.buildNameIndex(
        raw && typeof raw === 'object' ? raw : {},
        request.user?.directories || null,
    );
}

/**
 * 往范围里注入两份排除名单，「全选」时跳过它们：
 *
 *   世界书  已内嵌在角色卡里的那些 —— 跟着角色卡一起走，再单独传一份是重复。
 *           名单由后端直接解析 png 得出，不走前端：酒馆开了 lazyLoadCharacters 之后
 *           前端根本看不到 data.character_book（详见 cards.js）。
 *   背景图  酒馆自带的那批风景图 —— 装好酒馆本来就有，传上网盘纯属占地方。
 *
 * 两份都只在 all 为真时生效，用户显式勾选的照传（详见 paths.inScope）。
 */
async function scopeFor(config, directories) {
    const exclude = [...await cards.embeddedBookNames(directories)];
    const themes = {
        ...config.scope.themes,
        backgrounds: {
            ...config.scope.themes.backgrounds,
            exclude: [...builtin.builtinBackgrounds()],
        },
    };
    return {
        ...config.scope,
        worlds: { ...config.scope.worlds, exclude },
        themes,
    };
}

/** 连接信息用配置里的，范围用注入过排除名单的。 */
async function configFor(request) {
    const directories = request.user.directories;
    const config = configStore.resolveConfig(directories);
    return { ...config, scope: await scopeFor(config, directories) };
}

/** 云端文件管理的请求体统一是一组远端路径。 */
function readPaths(request) {
    const list = request.body?.paths;
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('请先选择要操作的云端文件。');
    }
    return list;
}

function init(router) {
    // ---- 状态与配置 ----

    router.post('/status', (request, response) => handle(response, async () => {
        const config = configStore.readConfig(request.user.directories);
        const state = backup.readState(request.user.directories);
        return {
            helper: true,
            hasPassword: !!config.password,
            configured: !!config.url,
            lastBackupAt: state.lastBackupAt || config.lastBackupAt || '',
            // 范围弹窗要用：预设与美化各有哪些目录、各有多少文件多大
            scopeDirs: backup.scopeDirStats(request.user.directories),
            // 角色卡文件夹标题上的「N 条聊天」。明细走 chats/list 按需拿
            chatCounts: backup.chatCounts(request.user.directories),
            // 人设与 API 配置的可选项。都是从 settings.json 里读出来的，不含密钥本身
            personas: synthetic.listPersonas(request.user.directories),
            apiProfiles: synthetic.listApiProfiles(request.user.directories),
        };
    }));

    // 展开某张角色卡时才来要它的聊天明细 —— 角色多起来一次性回传能到几百 KB
    router.post('/chats/list', (request, response) => handle(response, async () => {
        return { entries: backup.chatEntries(request.user.directories, request.body?.stem) };
    }));

    router.post('/config/load', (request, response) => handle(response, async () => {
        const config = configStore.readConfig(request.user.directories);
        return { config: configStore.publicConfig(config) };
    }));

    router.post('/config/save', (request, response) => handle(response, async () => {
        const saved = configStore.writeConfig(request.user.directories, request.body?.config || {});
        return { config: configStore.publicConfig(saved), scopeText: paths.describeScope(saved.scope) };
    }));

    router.post('/test', (request, response) => handle(response, async () => {
        const config = configStore.resolveConfig(request.user.directories);
        await webdav.ensureRoot(config);
        const marker = `.sillytavern-cloud-backup-test-${Date.now()}.txt`;
        const body = Buffer.from(`SillyTavern WebDAV test ${new Date().toISOString()}\n`, 'utf8');
        await webdav.putBuffer(config, [marker], body, 'text/plain; charset=utf-8');
        try {
            await webdav.remove(config, [marker]);
        } catch (error) {
            return { message: `连接可用，测试文件已上传；删除测试文件失败：${error.message}` };
        }
        return { message: '连接可用，远端目录可读写。' };
    }));

    // ---- 备份 ----

    router.post('/backup/plan', (request, response) => handle(response, async () => {
        const config = await configFor(request);
        return {
            plan: await backup.planOnly(request.user, config, readNames(request)),
            scopeText: paths.describeScope(config.scope),
        };
    }));

    router.post('/backup/upload', (request, response) => handle(response, async () => {
        const result = await backup.runUpload(request.user, await configFor(request), readNames(request));
        configStore.touchLastBackup(request.user.directories, result.lastBackupAt);
        return result;
    }));

    router.post('/backup/download', (request, response) => handle(response, async () => {
        const result = await backup.runDownload(request.user, await configFor(request), readNames(request));
        configStore.touchLastBackup(request.user.directories, result.lastBackupAt);
        return result;
    }));

    // ---- 角色卡 ----

    // 前端拿这份名单把内嵌的世界书从「选择世界书」列表里隐藏掉
    router.post('/cards/embedded-worlds', (request, response) => handle(response, async () => {
        return { books: [...await cards.embeddedBookNames(request.user.directories)] };
    }));

    // ---- 云端文件管理 ----

    router.post('/cloud/list', (request, response) => handle(response, async () => {
        const config = configStore.resolveConfig(request.user.directories);
        return { items: await cloud.list(config, readNames(request), request.user) };
    }));

    router.post('/cloud/download', (request, response) => handle(response, async () => {
        const config = configStore.resolveConfig(request.user.directories);
        return await cloud.download(request.user, config, readNames(request), readPaths(request));
    }));

    router.post('/cloud/delete', (request, response) => handle(response, async () => {
        const config = configStore.resolveConfig(request.user.directories);
        return await cloud.remove(request.user, config, readNames(request), readPaths(request));
    }));
}

module.exports = {
    info,
    init,
};
