/**
 * SillyTavern 服务端插件入口。各文件分工：
 *
 *   index.js   路由注册（本文件）
 *   config.js  插件自管配置（含密码）
 *   paths.js   本地路径 ↔ 远端路径映射，以及备份范围判定
 *   backup.js  上传 / 下载 / 预览
 *   cloud.js   云端文件管理：列举、指定下载、指定删除
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

const info = {
    id: 'webdav-chat-backup',
    name: 'WebDAV Chat Backup',
    description: 'Back up SillyTavern characters, chats, worlds, and settings to WebDAV.',
};

async function handle(response, fn) {
    try {
        response.json({ ok: true, ...(await fn()) });
    } catch (error) {
        console.error('[WebDAV Chat Backup]', error);
        response.status(500).json({ ok: false, error: error.message || String(error) });
    }
}

/** 角色名映射；前端没带就退化成用 avatar 文件名当角色名，功能不受影响只是网盘里不好认。 */
function readNames(request) {
    const raw = request.body?.characterNames;
    return paths.buildNameIndex(raw && typeof raw === 'object' ? raw : {});
}

/**
 * 把「已内嵌在角色卡里的世界书」注入范围。
 * 这份名单只有前端算得出来（要读 png 里的 character_book），所以随请求带上，不进配置文件。
 */
function scopeFor(config, request) {
    const raw = request.body?.embeddedWorlds;
    const exclude = Array.isArray(raw) ? raw.map(String) : [];
    return { ...config.scope, worlds: { ...config.scope.worlds, exclude } };
}

/** 连接信息用配置里的，范围用注入过排除名单的。 */
function configFor(request) {
    const config = configStore.resolveConfig(request.user.directories);
    return { ...config, scope: scopeFor(config, request) };
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
        };
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
        const marker = `.webdav-chat-backup-test-${Date.now()}.txt`;
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
        const config = configFor(request);
        return {
            plan: await backup.planOnly(request.user, config, readNames(request)),
            scopeText: paths.describeScope(config.scope),
        };
    }));

    router.post('/backup/upload', (request, response) => handle(response, async () => {
        const result = await backup.runUpload(request.user, configFor(request), readNames(request));
        configStore.touchLastBackup(request.user.directories, result.lastBackupAt);
        return result;
    }));

    router.post('/backup/download', (request, response) => handle(response, async () => {
        const result = await backup.runDownload(request.user, configFor(request), readNames(request));
        configStore.touchLastBackup(request.user.directories, result.lastBackupAt);
        return result;
    }));

    // ---- 云端文件管理 ----

    router.post('/cloud/list', (request, response) => handle(response, async () => {
        const config = configStore.resolveConfig(request.user.directories);
        return { items: await cloud.list(config, readNames(request)) };
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
