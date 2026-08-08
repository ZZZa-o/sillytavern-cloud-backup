/**
 * SillyTavern 服务端插件入口。
 * 只做路由注册和错误包装，具体实现在同目录的各模块里：
 *
 *   config.js    请求设置解析、secrets 读取
 *   webdav.js    WebDAV 通信原语
 *   paths.js     远端布局、路径映射与安全化
 *   scan.js      本地扫描与哈希
 *   plan.js      三方比较与 .jsonl 快进（纯函数，可单独测试）
 *   sync.js      同步执行与并发锁
 *   snapshot.js  zip 全量快照
 */
const { resolveConfig, readWebDavPassword } = require('./config.js');
const { readState } = require('./state.js');
const { buildPlan, summarizePlan } = require('./plan.js');
const webdav = require('./webdav.js');
const sync = require('./sync.js');
const snapshot = require('./snapshot.js');

const info = {
    id: 'webdav-chat-backup',
    name: 'WebDAV Chat Backup',
    description: 'Sync and back up SillyTavern chats, group chats, characters, and worlds to WebDAV.',
};

function init(router) {
    router.post('/status', (request, response) => {
        const state = readState(request.user.directories);
        response.json({
            ok: true,
            helper: true,
            hasPassword: !!readWebDavPassword(request.user.directories),
            device: state.device,
            lastSyncAt: state.lastSyncAt,
            trackedFiles: Object.keys(state.base).length,
        });
    });

    router.post('/test', (request, response) => handle(response, async () => {
        const config = resolveConfig(request);
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

    // ---- 多端增量同步 ----

    router.post('/sync/plan', (request, response) => handle(response, async () => {
        const config = resolveConfig(request);
        const context = await sync.collectContext(request.user, config);
        return {
            plan: summarizePlan(buildPlan(context, config.direction)),
            device: context.device,
        };
    }));

    router.post('/sync/apply', (request, response) => handle(response, async () => {
        const config = resolveConfig(request);
        return await sync.runSync(request.user, config);
    }));

    // ---- zip 全量快照 ----

    router.post('/list', (request, response) => handle(response, async () => {
        return { items: await snapshot.list(resolveConfig(request)) };
    }));

    router.post('/backup', (request, response) => handle(response, async () => {
        const config = resolveConfig(request);
        return await snapshot.upload(config, request.user, config.include, request.body?.reason);
    }));

    router.post('/restore', (request, response) => handle(response, async () => {
        const config = resolveConfig(request);
        const fileName = snapshot.sanitizeFileName(request.body?.fileName);
        const buffer = await snapshot.fetchArchive(config, fileName);
        return await snapshot.restore(request.user.directories, buffer, config.include);
    }));

    router.post('/delete', (request, response) => handle(response, async () => {
        const config = resolveConfig(request);
        const fileName = snapshot.sanitizeFileName(request.body?.fileName);
        await snapshot.remove(config, fileName);
        return { deleted: fileName };
    }));
}

async function handle(response, fn) {
    try {
        response.json({ ok: true, ...(await fn()) });
    } catch (error) {
        console.error('[WebDAV Chat Backup]', error);
        response.status(500).json({ ok: false, error: error.message || String(error) });
    }
}

module.exports = {
    info,
    init,
};
