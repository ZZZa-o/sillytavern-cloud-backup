/**
 * SillyTavern 服务端插件入口。四个文件各管一摊：
 *
 *   index.js     路由注册与请求配置解析（本文件）
 *   webdav.js    WebDAV 通信原语（请求、PROPFIND、目录遍历）
 *   sync.js      多端同步（决策部分为纯函数，单元测试直接引它）
 *   snapshot.js  zip 全量快照与恢复
 */
const fs = require('node:fs');
const path = require('node:path');

const webdav = require('./webdav.js');
const sync = require('./sync.js');
const snapshot = require('./snapshot.js');

const info = {
    id: 'webdav-chat-backup',
    name: 'WebDAV Chat Backup',
    description: 'Sync and back up SillyTavern chats, group chats, characters, and worlds to WebDAV.',
};

const SECRET_KEY = 'webdav_chat_backup_password';
const DIRECTIONS = ['two-way', 'upload-only', 'download-only'];

function readWebDavPassword(directories) {
    const file = path.join(directories.root, 'secrets.json');
    if (!fs.existsSync(file)) return '';
    try {
        const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
        const values = secrets[SECRET_KEY];
        if (!Array.isArray(values) || values.length === 0) return '';
        const active = values.find(item => item && item.active) || values.at(-1);
        return typeof active?.value === 'string' ? active.value : '';
    } catch {
        return '';
    }
}

/** 把请求体里的设置整理成后端各模块统一使用的 config。 */
function resolveConfig(request) {
    const body = request.body?.settings || {};
    const url = String(body.url || '').trim();
    if (!url) {
        throw new Error('请先填写 WebDAV 地址。');
    }
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
        throw new Error('WebDAV 地址格式不正确。');
    }

    const raw = body.include || {};
    const include = {
        chats: raw.chats !== false,
        groupChats: raw.groupChats !== false,
        characters: raw.characters !== false,
        worlds: raw.worlds !== false,
        settings: raw.settings !== false,
    };
    if (!Object.values(include).some(Boolean)) {
        throw new Error('请至少选择一项备份内容。');
    }

    return {
        url,
        username: String(body.username || '').trim(),
        password: readWebDavPassword(request.user.directories),
        remotePath: String(body.remotePath || '').trim(),
        include,
        direction: DIRECTIONS.includes(body.direction) ? body.direction : 'two-way',
        deviceName: String(body.deviceName || '').trim().slice(0, 40),
        retention: Math.max(1, Math.min(200, Number.parseInt(body.retention, 10) || 10)),
    };
}

async function handle(response, fn) {
    try {
        response.json({ ok: true, ...(await fn()) });
    } catch (error) {
        console.error('[WebDAV Chat Backup]', error);
        response.status(500).json({ ok: false, error: error.message || String(error) });
    }
}

function init(router) {
    router.post('/status', (request, response) => {
        const state = sync.readState(request.user.directories);
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
            plan: sync.summarizePlan(sync.buildPlan(context, config.direction)),
            device: context.device,
        };
    }));

    router.post('/sync/apply', (request, response) => handle(response, async () => {
        return await sync.runSync(request.user, resolveConfig(request));
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

module.exports = {
    info,
    init,
};
