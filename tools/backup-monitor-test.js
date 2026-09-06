/** 在临时用户目录和本机 WebDAV 夹具中验证检查、上传与记录。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const backup = require('../server/backup.js');
const activity = require('../server/activity.js');
const configStore = require('../server/config.js');
const paths = require('../server/paths.js');
const webdav = require('../server/webdav.js');
const plugin = require('../server/index.js');

async function webdavFixture() {
    const files = new Map();
    const directories = new Set(['/dav']);
    const requests = [];
    const faults = new Map();
    const server = http.createServer(async (request, response) => {
        const name = decodeURIComponent(new URL(request.url, 'http://fixture').pathname).replace(/\/$/, '');
        requests.push({ method: request.method, path: name });
        const fault = faults.get(request.method + ' ' + name);
        if (fault) { response.writeHead(fault); response.end('fixture failure'); return; }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        if (request.method === 'GET') {
            response.writeHead(files.has(name) ? 200 : 404);
            response.end(files.get(name));
        } else if (request.method === 'PUT') {
            files.set(name, Buffer.concat(chunks));
            response.writeHead(201); response.end();
        } else if (request.method === 'MKCOL') {
            response.writeHead(directories.has(name) ? 405 : 201);
            directories.add(name); response.end();
        } else if (request.method === 'DELETE') {
            files.delete(name); response.writeHead(204); response.end();
        } else if (request.method === 'PROPFIND') {
            if (!directories.has(name)) { response.writeHead(404); response.end(); return; }
            const entries = [[name, true]];
            for (const dir of directories) if (path.posix.dirname(dir) === name) entries.push([dir, true]);
            for (const file of files.keys()) if (path.posix.dirname(file) === name) entries.push([file, false]);
            const xml = entries.map(([entry, dir]) => {
                const href = entry.split('/').map(encodeURIComponent).join('/') + (dir ? '/' : '');
                const size = dir ? 0 : files.get(entry).length;
                return '<d:response><d:href>' + href + '</d:href><d:propstat><d:prop>'
                    + '<d:resourcetype>' + (dir ? '<d:collection/>' : '') + '</d:resourcetype>'
                    + '<d:getcontentlength>' + size + '</d:getcontentlength>'
                    + '<d:getlastmodified>Sun, 06 Sep 2026 00:00:00 GMT</d:getlastmodified>'
                    + '</d:prop></d:propstat></d:response>';
            }).join('');
            response.writeHead(207, { 'Content-Type': 'application/xml' });
            response.end('<d:multistatus xmlns:d="DAV:">' + xml + '</d:multistatus>');
        } else {
            response.writeHead(405); response.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        files, directories, requests, faults,
        url: 'http://127.0.0.1:' + server.address().port + '/dav/',
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

test('自动检查与上传记录', async t => {
    const dav = await webdavFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stcb-monitor-'));
    const directories = { root };
    for (const item of paths.ROOTS) {
        directories[item.dirKey] = path.join(root, item.prefix);
        fs.mkdirSync(directories[item.dirKey], { recursive: true });
    }
    const user = { directories };
    const settings = {
        power_user: {
            personas: { 'me.png': '测试人设' },
            persona_descriptions: { 'me.png': { description: '人设内容' } },
            default_persona: 'me.png',
        },
        extension_settings: { connectionManager: {
            profiles: [{ id: 'api1', name: '测试配置', api: 'custom', 'secret-id': 's1', proxy: 'None' }],
        } },
        proxies: [],
    };
    const secrets = { api_key_custom: [{ id: 's1', value: 'TEST-KEY', label: '测试', active: true }] };
    function write(file, text) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, 'utf8');
    }
    write('settings.json', JSON.stringify(settings));
    write('secrets.json', JSON.stringify(secrets));
    for (const file of ['characters/card.png', 'chats/card/main.jsonl', 'worlds/book.json',
        'themes/theme.json', 'User Avatars/me.png', 'OpenAI Settings/default.json']) write(file, 'fixture');

    const config = configStore.defaultConfig();
    Object.assign(config.profiles[0], { url: dav.url, remotePath: 'backup-a', username: '', password: '' });
    for (const category of ['characters', 'chats', 'worlds', 'personas', 'apiProfiles']) config.scope[category].all = true;
    for (const category of ['presets', 'themes']) {
        for (const selection of Object.values(config.scope[category])) selection.all = true;
    }
    let saved = configStore.writeConfig(directories, configStore.toStored(configStore.withActive(config)));
    const names = paths.buildNameIndex({ 'card.png': '测试角色' }, directories);
    const routes = new Map();
    plugin.init({ post: (route, handler) => routes.set(route, handler) });
    async function call(route, body = {}) {
        let status = 200;
        let data;
        const response = { status(code) { status = code; return this; }, json(value) { data = value; } };
        await routes.get(route)({ user, body: { characterNames: { 'card.png': '测试角色' }, ...body } }, response);
        assert.equal(status, 200, JSON.stringify(data));
        return data;
    }
    const remote = file => '/dav/backup-a/' + paths.toRemote(file, names);

    try {
        await t.test('首次自动检查只读云端，列出全部已选文件', async () => {
            const { plan } = await call('/backup/changes');
            assert.equal(plan.counts.upload, 8);
            assert.equal(plan.uploadCategories.personas, 2);
            assert.equal(plan.uploadCategories.themes, 1);
            assert.ok(plan.upload.some(item => item.label === '用户人设/测试人设/persona.json'));
            assert.ok(dav.requests.every(item => ['GET', 'PROPFIND'].includes(item.method)));
            assert.equal(dav.directories.has('/dav/backup-a'), false);
        });

        await t.test('全量上传返回实际文件清单', async () => {
            const result = await call('/backup/upload', { trigger: 'manual' });
            assert.equal(result.uploaded, 8);
            assert.equal(result.uploadedFiles.length, 8);
            assert.deepEqual(result.errors, []);
            assert.equal(result.activity.lastRun, null);
            for (const file of result.uploadedFiles) {
                assert.equal(dav.files.get('/dav/backup-a/' + file.label).length, file.bytes);
            }
        });

        await t.test('未改内容不重复上传，日常检查使用云端缓存', async () => {
            const count = dav.requests.length;
            const { plan } = await call('/backup/changes');
            assert.equal(plan.counts.upload, 0);
            assert.equal(plan.counts.unchanged, 8);
            assert.equal(dav.requests.length, count);
        });

        await t.test('无法导入的云端文件直接报错', async () => {
            const result = await call('/cloud/download', { paths: ['.st-sync/index.json'] });
            assert.equal(result.downloaded, 0);
            assert.equal(result.errors.length, 1);
            assert.match(result.errors[0].error, /无法导入/);
            assert.deepEqual(result.written, []);
            assert.equal(fs.existsSync(path.join(root, 'backups')), false);
        });

        await t.test('识别人设、密钥、主题、聊天和世界书的修改', async () => {
            settings.power_user.persona_descriptions['me.png'].description = '修改后的人设内容';
            secrets.api_key_custom[0].value = 'TEST-ROTATED';
            write('settings.json', JSON.stringify(settings));
            write('secrets.json', JSON.stringify(secrets));
            for (const file of ['themes/theme.json', 'chats/card/main.jsonl', 'worlds/book.json']) write(file, 'changed fixture content');
            write('not-backed-up.txt', 'outside selected roots');
            const { plan } = await call('/backup/changes');
            assert.equal(plan.counts.upload, 5);
            assert.deepEqual(plan.uploadCategories, { chats: 1, worlds: 1, themes: 1, personas: 1, apiProfiles: 1 });
            assert.equal(plan.upload.some(item => item.path === 'not-backed-up.txt'), false);
        });

        await t.test('自动上传只把成功文件记入记录', async () => {
            dav.faults.set('PUT ' + remote('worlds/book.json'), 507);
            const result = await call('/backup/upload', { trigger: 'auto' });
            assert.equal(result.uploaded, 4);
            assert.equal(result.errors.length, 1);
            assert.equal(result.errors[0].path, 'worlds/book.json');
            assert.equal(result.activity.runs[0].files.length, 4);
            assert.equal(result.activity.runs[0].files.some(item => item.path === 'worlds/book.json'), false);
            const { plan } = await call('/backup/changes');
            assert.deepEqual(plan.upload.map(item => item.path), ['worlds/book.json']);
            dav.faults.clear();
        });

        await t.test('补传后清空待上传范围，空检查保留最近文件记录', async () => {
            const uploaded = await call('/backup/upload', { trigger: 'auto' });
            assert.equal(uploaded.uploaded, 1);
            assert.equal(uploaded.activity.runs.length, 2);
            const unchanged = await call('/backup/upload', { trigger: 'auto' });
            assert.equal(unchanged.uploaded, 0);
            assert.equal(unchanged.activity.runs.length, 2);
            assert.equal(unchanged.activity.lastRun.uploaded, 0);
            assert.equal((await call('/backup/changes')).plan.counts.upload, 0);
        });

        await t.test('记录从磁盘重新读取，连接方案互不串用', async () => {
            const first = await call('/backup/activity');
            assert.equal(first.activity.runs.length, 2);
            assert.deepEqual(activity.readAutoUploads(directories, saved), first.activity);
            const other = { ...saved, activeProfileId: 'other', remotePath: 'backup-b' };
            assert.deepEqual(activity.readAutoUploads(directories, other), { lastRun: null, runs: [] });
            assert.equal((await backup.changesOnly(user, other, names)).counts.upload, 8);
        });

        await t.test('手动预览立即刷新云端目录', async () => {
            const file = remote('worlds/book.json');
            const data = dav.files.get(file);
            dav.files.delete(file);
            const { plan } = await call('/backup/plan');
            assert.deepEqual(plan.upload.map(item => item.path), ['worlds/book.json']);
            dav.files.set(file, data);
            await call('/backup/plan');
        });

        await t.test('五分钟后自动刷新云端状态', async () => {
            const file = remote('themes/theme.json');
            const data = dav.files.get(file);
            dav.files.delete(file);
            const realNow = Date.now;
            try {
                Date.now = () => realNow() + 5 * 60 * 1000 + 1000;
                const { plan } = await call('/backup/changes');
                assert.deepEqual(plan.upload.map(item => item.path), ['themes/theme.json']);
            } finally {
                Date.now = realNow;
                dav.files.set(file, data);
            }
            await call('/backup/plan');
        });

        await t.test('云端删除操作使比较缓存失效', async () => {
            await call('/cloud/delete', { paths: [paths.toRemote('themes/theme.json', names)] });
            const count = dav.requests.length;
            const { plan } = await call('/backup/changes');
            assert.ok(dav.requests.length > count);
            assert.deepEqual(plan.upload.map(item => item.path), ['themes/theme.json']);
        });

        await t.test('加密目录首次检查不创建密钥，上传后按明文哈希比较', async () => {
            const profile = { ...saved.profiles[0], id: 'encrypted', remotePath: 'encrypted', encryption: { enabled: true, passphrase: 'TEST-PASSPHRASE' } };
            saved = configStore.writeConfig(directories, { ...configStore.toStored(saved), profiles: [profile], activeProfileId: profile.id });
            const count = dav.requests.length;
            assert.equal((await call('/backup/changes')).plan.counts.upload, 8);
            assert.ok(dav.requests.slice(count).every(item => ['GET', 'PROPFIND'].includes(item.method)));
            const uploaded = await call('/backup/upload', { trigger: 'auto' });
            assert.equal(uploaded.uploaded, 8);
            assert.ok(dav.files.has('/dav/encrypted/.st-sync/keycheck.json'));
            backup.invalidateChanges(directories, saved);
            assert.equal((await call('/backup/changes')).plan.counts.upload, 0);
        });

        await t.test('错误口令和更改后的校验文件会明确报错', async () => {
            const count = dav.requests.length;
            const wrongProfile = { ...saved.profiles[0], encryption: { enabled: true, passphrase: 'WRONG' } };
            await call('/config/save', { config: { ...configStore.toStored(saved), profiles: [wrongProfile] } });
            await assert.rejects(backup.changesOnly(user, configStore.resolveConfig(directories), names), /口令/);
            assert.ok(dav.requests.length > count);
            await call('/config/save', { config: configStore.toStored(saved) });
            assert.equal((await call('/backup/changes')).plan.counts.upload, 0);
            const file = '/dav/encrypted/.st-sync/keycheck.json';
            const original = dav.files.get(file);
            dav.files.set(file, Buffer.from('{}'));
            backup.invalidateChanges(directories, saved);
            await assert.rejects(backup.changesOnly(user, saved, names));
            dav.files.set(file, original);
        });

        await t.test('读取失败和损坏的 JSON 不当作空备份', async () => {
            const plain = { ...saved, cryptoKey: null, remotePath: 'bad-json' };
            dav.files.set('/dav/bad-json/data.json', Buffer.from('{'));
            await assert.rejects(webdav.readJson(plain, ['data.json']), SyntaxError);
            dav.faults.set('GET /dav/bad-json/data.json', 401);
            await assert.rejects(webdav.readJson(plain, ['data.json']), { status: 401 });
            dav.faults.clear();
            assert.equal(await webdav.readJson(plain, ['missing.json']), null);
        });

        await t.test('自动上传记录只保留最近五次有内容的执行', () => {
            const isolated = { ...saved, remotePath: 'history-test' };
            for (let index = 0; index < 7; index++) {
                activity.recordAutoUpload(directories, isolated, {
                    lastBackupAt: new Date(1700000000000 + index * 1000).toISOString(),
                    uploaded: 1, skipped: 0, errors: [],
                    uploadedFiles: [{ path: 'themes/' + index + '.json', label: '美化/themes/' + index + '.json', bytes: 4 }],
                });
            }
            const history = activity.readAutoUploads(directories, isolated);
            assert.equal(history.runs.length, 5);
            assert.equal(history.runs[0].files[0].path, 'themes/6.json');
            assert.equal(history.runs[4].files[0].path, 'themes/2.json');
        });
    } finally {
        await dav.close();
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true });
    }
});
