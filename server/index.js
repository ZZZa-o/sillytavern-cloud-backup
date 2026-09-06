/**
 * SillyTavern 服务端入口：注册配置、备份、云端文件及角色卡查询路由。
 * 连接与范围读取自插件配置，角色名映射由前端请求提供。
 */
const configStore = require('./config.js');
const paths = require('./paths.js');
const webdav = require('./webdav.js');
const backup = require('./backup.js');
const cloud = require('./cloud.js');
const cards = require('./cards.js');
const builtin = require('./builtin.js');
const synthetic = require('./synthetic.js');
const activity = require('./activity.js');

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

/** 读取请求中的角色名映射，缺失时使用 avatar 文件名。 */
function readNames(request) {
    const raw = request.body?.characterNames;
    return paths.buildNameIndex(
        raw && typeof raw === 'object' ? raw : {},
        request.user?.directories || null,
    );
}

/**
 * 向范围注入内嵌世界书和自带背景图的排除名单。
 * 排除名单仅作用于 all 模式，显式选中的项目照常处理。
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

/** 读取连接配置并通过 prepareCrypto 验证口令、准备密钥；失败时中止请求。 */
async function connectionFor(request, access) {
    return backup.prepareCrypto(configStore.resolveConfig(request.user.directories), access);
}

/** 连接信息用配置里的，范围用注入过排除名单的。 */
async function configFor(request, access) {
    const directories = request.user.directories;
    const config = await connectionFor(request, access);
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
    // 状态与配置

    router.post('/status', (request, response) => handle(response, async () => {
        const config = configStore.readConfig(request.user.directories);
        return {
            helper: true,
            hasPassword: !!config.password,
            configured: !!config.url,
            // 返回当前方案的加密开关、口令状态与口令文本。
            encryption: {
                enabled: !!config.encryption?.enabled,
                hasPassphrase: !!config.encryption?.passphrase,
                passphrase: String(config.encryption?.passphrase || ''),
            },
            lastBackupAt: config.lastBackupAt,
            // 返回范围弹窗使用的预设与美化目录统计。
            scopeDirs: backup.scopeDirStats(request.user.directories),
            // 返回聊天数量和大小，单条明细通过 chats/list 查询。
            chatCounts: backup.chatCounts(request.user.directories),
            // 返回人设与 API 配置选项，省略密钥文本。
            personas: synthetic.listPersonas(request.user.directories),
            apiProfiles: synthetic.listApiProfiles(request.user.directories),
        };
    }));

    // 按角色查询聊天明细。
    router.post('/chats/list', (request, response) => handle(response, async () => {
        return { entries: backup.chatEntries(request.user.directories, request.body?.stem) };
    }));

    router.post('/config/load', (request, response) => handle(response, async () => {
        const config = configStore.readConfig(request.user.directories);
        return { config: configStore.publicConfig(config) };
    }));

    router.post('/config/save', (request, response) => handle(response, async () => {
        const saved = configStore.writeConfig(request.user.directories, request.body?.config || {});
        backup.invalidateChanges(request.user.directories, saved);
        return { config: configStore.publicConfig(saved), scopeText: paths.describeScope(saved.scope) };
    }));

    /** 测试远端读写；开启加密时同时验证加密与解密往返。 */
    router.post('/test', (request, response) => handle(response, async () => {
        const config = await connectionFor(request, 'write');
        const marker = `.sillytavern-cloud-backup-test-${Date.now()}.txt`;
        const text = `SillyTavern WebDAV test ${new Date().toISOString()}\n`;
        const body = Buffer.from(text, 'utf8');
        await webdav.putBuffer(config, [marker], body, 'text/plain; charset=utf-8');

        let roundTrip = '';
        if (config.cryptoKey) {
            // 逐字节验证回读内容。
            const back = await webdav.getBuffer(config, [marker]);
            if (!back.equals(body)) {
                await webdav.remove(config, [marker]).catch(() => {});
                throw new Error('加密测试失败，请勿使用此方案上传。');
            }
            roundTrip = '，加密往返自检通过';
        }

        try {
            await webdav.remove(config, [marker]);
        } catch (error) {
            return { message: `连接可用，测试文件已上传${roundTrip}；删除测试文件失败：${error.message}` };
        }
        return { message: `连接可用，远端目录可读写${roundTrip}。` };
    }));

    // 备份

    router.post('/backup/plan', (request, response) => handle(response, async () => {
        const config = await configFor(request, 'read');
        return {
            plan: await backup.planOnly(request.user, config, readNames(request)),
            scopeText: paths.describeScope(config.scope),
        };
    }));

    router.post('/backup/changes', (request, response) => handle(response, async () => {
        const directories = request.user.directories;
        const config = configStore.resolveConfig(directories);
        config.scope = await scopeFor(config, directories);
        return {
            plan: await backup.changesOnly(request.user, config, readNames(request)),
            scopeText: paths.describeScope(config.scope),
        };
    }));

    router.post('/backup/activity', (request, response) => handle(response, async () => {
        const directories = request.user.directories;
        return { activity: activity.readAutoUploads(directories, configStore.readConfig(directories)) };
    }));

    router.post('/backup/upload', (request, response) => handle(response, async () => {
        const trigger = request.body.trigger;
        if (trigger !== 'manual' && trigger !== 'auto') throw new Error('上传来源无效。');
        const config = await configFor(request, 'write');
        const result = await backup.runUpload(request.user, config, readNames(request));
        configStore.touchLastBackup(request.user.directories, result.lastBackupAt);
        return {
            ...result,
            activity: trigger === 'auto'
                ? activity.recordAutoUpload(request.user.directories, config, result)
                : activity.readAutoUploads(request.user.directories, config),
        };
    }));

    router.post('/backup/download', (request, response) => handle(response, async () => {
        const result = await backup.runDownload(request.user, await configFor(request, 'read'), readNames(request));
        configStore.touchLastBackup(request.user.directories, result.lastBackupAt);
        return result;
    }));

    // 角色卡

    // 返回范围列表需要隐藏的内嵌世界书名单。
    router.post('/cards/embedded-worlds', (request, response) => handle(response, async () => {
        return { books: [...await cards.embeddedBookNames(request.user.directories)] };
    }));

    // 云端文件管理

    router.post('/cloud/list', (request, response) => handle(response, async () => {
        const config = await connectionFor(request, 'read');
        return { items: await cloud.list(config, readNames(request)) };
    }));

    router.post('/cloud/download', (request, response) => handle(response, async () => {
        const config = await connectionFor(request, 'read');
        return await cloud.download(request.user, config, readNames(request), readPaths(request));
    }));

    router.post('/cloud/delete', (request, response) => handle(response, async () => {
        const config = await connectionFor(request, 'read');
        const result = await cloud.remove(request.user, config, readNames(request), readPaths(request));
        backup.invalidateChanges(request.user.directories, config);
        return result;
    }));
}

module.exports = {
    info,
    init,
};
