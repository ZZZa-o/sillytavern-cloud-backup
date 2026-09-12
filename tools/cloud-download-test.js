/** 在独立临时用户目录验证真实下载落盘与引用关系，不连接真实网盘。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cloud = require('../server/cloud.js');
const backup = require('../server/backup.js');
const webdav = require('../server/webdav.js');
const paths = require('../server/paths.js');

const bytes = value => Buffer.isBuffer(value) ? value
    : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

function harness(t, { remote = {}, index = {}, settings = {}, secrets = {}, names = {} } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stcb-download-'));
    const directories = { root };
    for (const { prefix, dirKey } of paths.ROOTS) {
        directories[dirKey] = path.join(root, prefix);
        fs.mkdirSync(directories[dirKey], { recursive: true });
    }
    t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('stcb-download-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    function write(local, content) {
        const file = path.join(root, local);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes(content));
    }
    write('settings.json', settings);
    write('secrets.json', secrets);
    t.mock.method(backup, 'readRemoteIndex', async () => index);
    t.mock.method(webdav, 'getBuffer', async (_config, segments) => {
        const file = segments.join('/');
        let content = remote[file];
        if (typeof content === 'function') content = await content();
        if (content instanceof Error) throw content;
        if (content === undefined) throw new Error('Fixture file missing: ' + file);
        return bytes(content);
    });
    return {
        root, directories, write, remote,
        read: local => fs.readFileSync(path.join(root, local), 'utf8'),
        json: local => JSON.parse(fs.readFileSync(path.join(root, local), 'utf8')),
        exists: local => fs.existsSync(path.join(root, local)),
        run: (options, selected = Object.keys(remote)) => cloud.download(
            { directories }, {}, paths.buildNameIndex(names, directories), selected, options,
        ),
    };
}

test('默认下载与显式开启覆盖均替换对应文件', async t => {
    const h = harness(t, { remote: { '世界书/设定.json': { entries: { new: true } } } });
    for (const options of [undefined, { overwrite: true }]) {
        h.write('worlds/设定.json', { entries: { old: true } });
        const result = await h.run(options);
        assert.equal(result.overwrite, true);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(h.json('worlds/设定.json'), { entries: { new: true } });
        assert.equal(h.exists('worlds/设定（1）.json'), false);
    }
});

test('世界书保留原件并跳过已有序号，扩展名与内部名字同步', async t => {
    const h = harness(t, { remote: { '世界书/设定.json': { name: '设定', entries: { text: '新内容' } } } });
    h.write('worlds/设定.json', '原件');
    h.write('worlds/设定（1）.json', '已有副本');
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.equal(h.read('worlds/设定.json'), '原件');
    assert.equal(h.read('worlds/设定（1）.json'), '已有副本');
    assert.deepEqual(h.json('worlds/设定（2）.json'), { name: '设定（2）', entries: { text: '新内容' } });
    assert.equal(result.written[0].target, 'worlds/设定（2）.json');
});

test('主题、快速回复、预设和背景各自保留副本，名字供酒馆正确读取', async t => {
    const h = harness(t, { remote: {
        '美化/themes/深色.json': { name: '深色', custom_css: 'body { color: red; }' },
        '预设/QuickReplies/指令.json': { name: '指令', qrList: [{ id: 1, message: '测试' }] },
        '预设/OpenAI Settings/日常.json': { temperature: 0.7, prompts: [{ name: '不要改的提示词' }] },
        '美化/backgrounds/书房.jpg': Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]),
    } });
    for (const file of ['themes/深色.json', 'QuickReplies/指令.json', 'OpenAI Settings/日常.json', 'backgrounds/书房.jpg']) {
        h.write(file, '原件');
    }
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.equal(result.downloaded, 4);
    assert.equal(h.json('themes/深色（1）.json').name, '深色（1）');
    assert.deepEqual(h.json('QuickReplies/指令（1）.json'), { name: '指令（1）', qrList: [{ id: 1, message: '测试' }] });
    assert.deepEqual(h.json('OpenAI Settings/日常（1）.json'), h.remote['预设/OpenAI Settings/日常.json']);
    assert.deepEqual(fs.readFileSync(path.join(h.root, 'backgrounds/书房（1）.jpg')), h.remote['美化/backgrounds/书房.jpg']);
    for (const file of ['themes/深色.json', 'QuickReplies/指令.json', 'OpenAI Settings/日常.json', 'backgrounds/书房.jpg']) {
        assert.equal(h.read(file), '原件');
    }
});

test('没有冲突时使用原文件名，重复请求路径只下载一次', async t => {
    const h = harness(t, { remote: { '世界书/新书.json': { entries: {} } } });
    const result = await h.run({ overwrite: false }, ['世界书/新书.json', '世界书/新书.json']);
    assert.deepEqual(result.errors, []);
    assert.equal(result.downloaded, 1);
    assert.equal(result.written[0].target, 'worlds/新书.json');
});

test('乱序选择的聊天和附件跟随角色副本，角色卡内容及显示名不改', async t => {
    const card = bytes({ name: '阿岚', data: { name: '阿岚', description: '云端角色设定' } });
    const h = harness(t, {
        names: { 'k7.png': '阿岚' },
        index: { 'characters/k7.png': { remote: '角色卡/阿岚.png' } },
        remote: {
            '聊天记录/阿岚/早晨.jsonl': '云端聊天\n',
            '角色卡/阿岚/微笑.png': '云端表情',
            '角色卡/阿岚.png': card,
        },
    });
    h.write('characters/k7.png', '旧角色卡');
    h.write('chats/k7/早晨.jsonl', '旧聊天');
    h.write('characters/k7/微笑.png', '旧表情');
    for (let n = 1; n <= 2; n++) {
        const result = await h.run({ overwrite: false });
        assert.deepEqual(result.errors, []);
        assert.deepEqual(fs.readFileSync(path.join(h.root, `characters/k7（${n}）.png`)), card);
        assert.equal(h.read(`chats/k7（${n}）/早晨.jsonl`), '云端聊天\n');
        assert.equal(h.read(`characters/k7（${n}）/微笑.png`), '云端表情');
    }
    assert.equal(h.read('characters/k7.png'), '旧角色卡');
    assert.equal(h.read('chats/k7/早晨.jsonl'), '旧聊天');
    assert.equal(h.read('characters/k7/微笑.png'), '旧表情');
});

test('同名角色已有不同内部文件名时直接共存', async t => {
    const h = harness(t, {
        names: { 'local.png': '阿岚' },
        index: { 'characters/remote.png': { remote: '角色卡/阿岚.png' } },
        remote: { '角色卡/阿岚.png': { name: '阿岚' } },
    });
    h.write('characters/local.png', { name: '阿岚', description: '本地' });
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.equal(result.written[0].target, 'characters/remote.png');
    assert.equal(h.json('characters/local.png').name, h.json('characters/remote.png').name);
});

test('角色卡不存在但旧聊天目录仍在时也分配独立目录', async t => {
    const h = harness(t, { remote: { '角色卡/阿岚.png': '云端卡', '聊天记录/阿岚/早晨.jsonl': '新聊天' } });
    h.write('chats/阿岚/早晨.jsonl', '旧聊天');
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.equal(h.read('chats/阿岚/早晨.jsonl'), '旧聊天');
    assert.equal(h.read('chats/阿岚（1）/早晨.jsonl'), '新聊天');
});

test('单独下载重名聊天仅增加聊天文件副本', async t => {
    const h = harness(t, { remote: { '聊天记录/阿岚/早晨.jsonl': '新聊天' } });
    h.write('chats/阿岚/早晨.jsonl', '旧聊天');
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.equal(h.read('chats/阿岚/早晨（1）.jsonl'), '新聊天');
    assert.equal(h.read('chats/阿岚/早晨.jsonl'), '旧聊天');
});

const persona = description => ({ avatar: 'avatar.png', name: '旅人', description: { description, depth: 2 }, isDefault: true });
const personaSettings = {
    power_user: {
        personas: { 'avatar.png': '旅人' },
        persona_descriptions: { 'avatar.png': { description: '本地描述', depth: 4 } },
        default_persona: 'avatar.png',
    },
    untouched: '保留其他设置',
};

test('同名人设重复下载使用新头像标识，保留描述、注入设置和本机默认人设', async t => {
    const h = harness(t, { settings: personaSettings, remote: {
        '用户人设/旅人/persona.json': persona('云端描述'),
        '用户人设/旅人/avatar.png': '云端头像',
    } });
    h.write('User Avatars/avatar.png', '本地头像');
    for (let n = 1; n <= 2; n++) {
        const result = await h.run({ overwrite: false });
        assert.deepEqual(result.errors, []);
        const power = h.json('settings.json').power_user;
        assert.equal(power.personas[`avatar（${n}）.png`], '旅人');
        assert.deepEqual(power.persona_descriptions[`avatar（${n}）.png`], persona('云端描述').description);
        assert.deepEqual(power.persona_descriptions['avatar.png'], personaSettings.power_user.persona_descriptions['avatar.png']);
        assert.equal(power.default_persona, 'avatar.png');
        assert.deepEqual(result.personaData.personas, power.personas);
    }
    assert.equal(h.read('User Avatars/avatar.png'), '本地头像');
    assert.equal(h.json('settings.json').untouched, '保留其他设置');
});

test('不同人设文件夹中的同名头像分别绑定正确描述', async t => {
    const h = harness(t, { remote: {
        '用户人设/旅人/persona.json': persona('第一个描述'),
        '用户人设/旅人 (2)/persona.json': persona('第二个描述'),
        '用户人设/旅人 (2)/avatar.png': '第二张头像',
        '用户人设/旅人/avatar.png': '第一张头像',
    } });
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    const power = h.json('settings.json').power_user;
    for (const [avatar, description] of Object.entries(power.persona_descriptions)) {
        assert.equal(power.personas[avatar], '旅人');
        assert.equal(h.read(`User Avatars/${avatar}`), description.description === '第一个描述' ? '第一张头像' : '第二张头像');
    }
    assert.equal(Object.keys(power.personas).length, 2);
});

test('即使本机头像丢失，也不能覆盖仍保存在设置里的人设', async t => {
    const h = harness(t, { settings: personaSettings, remote: {
        '用户人设/旅人/persona.json': persona('云端描述'), '用户人设/旅人/avatar.png': '云端头像',
    } });
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.equal(h.json('settings.json').power_user.persona_descriptions['avatar.png'].description, '本地描述');
    assert.equal(h.read('User Avatars/avatar（1）.png'), '云端头像');
});

test('缺少选中的云端头像时明确失败，不借用本机头像写入新描述', async t => {
    const h = harness(t, { settings: personaSettings, remote: { '用户人设/旅人/persona.json': persona('云端描述') } });
    const missing = await h.run({ overwrite: false });
    assert.equal(missing.downloaded, 0);
    assert.match(missing.errors[0].error, /缺少人设头像/);
    h.write('User Avatars/avatar.png', '本地头像');
    const result = await h.run({ overwrite: false });
    assert.equal(result.downloaded, 0);
    assert.match(result.errors[0].error, /缺少人设头像/);
    assert.equal(h.exists('User Avatars/avatar（1）.png'), false);
    assert.equal(h.json('settings.json').power_user.persona_descriptions['avatar.png'].description, '本地描述');
});

test('头像或角色卡下载失败时，关联描述和聊天不会写入旧资源', async t => {
    const h = harness(t, { settings: personaSettings, remote: {
        '用户人设/旅人/persona.json': persona('云端描述'),
        '用户人设/旅人/avatar.png': new Error('头像下载失败'),
        '聊天记录/阿岚/早晨.jsonl': '新聊天',
        '角色卡/阿岚.png': new Error('角色下载失败'),
    } });
    h.write('User Avatars/avatar.png', '本地头像');
    h.write('characters/阿岚.png', '本地角色');
    h.write('chats/阿岚/早晨.jsonl', '旧聊天');
    const result = await h.run({ overwrite: false });
    assert.equal(result.downloaded, 0);
    assert.equal(result.errors.length, 4);
    assert.deepEqual(h.json('settings.json'), personaSettings);
    assert.equal(h.read('chats/阿岚/早晨.jsonl'), '旧聊天');
    assert.equal(h.exists('chats/阿岚（1）/早晨.jsonl'), false);
});

test('API 配置副本使用独立名称与标识，密钥和代理引用正确且旧配置完整保留', async t => {
    const profile = { id: 'p1', name: '连接', api: 'custom', 'secret-id': 's1', proxy: '代理' };
    const localSecret = { id: 's1', value: 'LOCAL-FIXTURE-KEY', label: '密钥', active: true };
    const localProxy = { name: '代理', url: 'https://local.example', password: 'LOCAL-FIXTURE-PASSWORD' };
    const incoming = {
        profiles: [profile],
        secrets: [{ key: 'api_key_custom', id: 's1', value: 'CLOUD-FIXTURE-KEY', label: '密钥', active: true }],
        proxies: [{ name: '代理', url: 'https://cloud.example', password: 'CLOUD-FIXTURE-PASSWORD' }],
    };
    const h = harness(t, {
        settings: { extension_settings: { connectionManager: { selectedProfile: 'p1', profiles: [profile] } }, proxies: [localProxy] },
        secrets: { api_key_custom: [localSecret] },
        remote: { 'API配置/连接.json': incoming, 'API配置/连接 (2).json': incoming },
    });
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    const settings = h.json('settings.json');
    const manager = settings.extension_settings.connectionManager;
    assert.equal(manager.selectedProfile, 'p1');
    assert.deepEqual(manager.profiles[0], profile);
    assert.deepEqual(manager.profiles.map(item => item.name), ['连接', '连接（1）', '连接（2）']);
    assert.equal(new Set(manager.profiles.map(item => item.id)).size, 3);
    const imported = manager.profiles[1];
    assert.notEqual(imported['secret-id'], 's1');
    assert.equal(imported['secret-id'], manager.profiles[2]['secret-id']);
    assert.equal(imported.proxy, '代理（1）');
    assert.equal(imported.proxy, manager.profiles[2].proxy);
    assert.deepEqual(settings.proxies[0], localProxy);
    assert.equal(settings.proxies.length, 2);
    const secrets = h.json('secrets.json').api_key_custom;
    assert.deepEqual(secrets[0], localSecret);
    assert.equal(secrets.length, 2);
    assert.equal(secrets[1].id, imported['secret-id']);
    assert.equal(secrets[1].value, 'CLOUD-FIXTURE-KEY');
    assert.equal(secrets[1].active, false);
});

test('群组和群聊副本更新内部标识及已选角色引用', async t => {
    const h = harness(t, { remote: {
        '聊天记录/_群组/100.json': {
            id: '100', name: '同名小队', members: ['阿岚.png'], disabled_members: ['阿岚.png'],
            chats: ['200'], chat_id: '200',
        },
        '聊天记录/_群聊/200.jsonl': '群聊副本',
        '角色卡/阿岚.png': '角色副本',
    } });
    h.write('groups/100.json', '原组');
    h.write('group chats/200.jsonl', '原群聊');
    h.write('characters/阿岚.png', '原角色');
    const result = await h.run({ overwrite: false });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(h.json('groups/100（1）.json'), {
        id: '100（1）', name: '同名小队', members: ['阿岚（1）.png'], disabled_members: ['阿岚（1）.png'],
        chats: ['200（1）'], chat_id: '200（1）',
    });
    assert.equal(h.read('groups/100.json'), '原组');
    assert.equal(h.read('group chats/200.jsonl'), '原群聊');
});

test('分配副本名后出现并发文件时拒绝覆盖，其他下载继续完成', async t => {
    const h = harness(t, { remote: { '世界书/设定.json': null, '世界书/另一份.json': { entries: {} } } });
    h.write('worlds/设定.json', '原件');
    h.remote['世界书/设定.json'] = () => {
        h.write('worlds/设定（1）.json', '其他请求刚写入');
        return { entries: {} };
    };
    const result = await h.run({ overwrite: false });
    assert.equal(result.errors.length, 1);
    assert.equal(result.downloaded, 1);
    assert.equal(h.read('worlds/设定.json'), '原件');
    assert.equal(h.read('worlds/设定（1）.json'), '其他请求刚写入');
});

test('无效 JSON 和路径不产生副本，也不触碰本地原件', async t => {
    const h = harness(t, { remote: { '美化/themes/深色.json': 'invalid JSON' } });
    h.write('themes/深色.json', '原件');
    const result = await h.run({ overwrite: false }, ['美化/themes/深色.json', '../settings.json']);
    assert.equal(result.downloaded, 0);
    assert.equal(result.errors.length, 2);
    assert.equal(h.read('themes/深色.json'), '原件');
    assert.equal(h.exists('themes/深色（1）.json'), false);
});

test('HTTP 下载路由明确传递覆盖开关，拒绝无效的开关值', async t => {
    const h = harness(t);
    const config = require('../server/config.js');
    const server = require('../server/index.js');
    const routes = new Map();
    t.mock.method(config, 'resolveConfig', () => ({}));
    t.mock.method(backup, 'prepareCrypto', async () => ({}));
    t.mock.method(cloud, 'download', async (_user, _config, _names, _paths, options) => options);
    t.mock.method(console, 'error', () => {});
    server.init({ post: (route, handler) => routes.set(route, handler) });
    for (const overwrite of [false, true, undefined, 'false']) {
        let result;
        const response = { json: data => { result = data; }, status() { return this; } };
        await routes.get('/cloud/download')({
            user: { directories: h.directories }, body: { paths: ['世界书/设定.json'], overwrite },
        }, response);
        assert.equal(result.ok, typeof overwrite === 'boolean');
        if (result.ok) assert.equal(result.overwrite, overwrite);
        else assert.equal(result.error, '下载覆盖选项无效。');
    }
});

test('同时下载同一 API 配置也不会重用副本名称或覆盖原配置', async t => {
    const profile = { id: 'p1', name: '连接', api: 'custom' };
    const h = harness(t, {
        settings: { extension_settings: { connectionManager: { selectedProfile: 'p1', profiles: [profile] } } },
        remote: { 'API配置/连接.json': { profiles: [profile], secrets: [], proxies: [] } },
    });
    const results = await Promise.all([h.run({ overwrite: false }), h.run({ overwrite: false })]);
    for (const result of results) assert.deepEqual(result.errors, []);
    const profiles = h.json('settings.json').extension_settings.connectionManager.profiles;
    assert.deepEqual(profiles[0], profile);
    assert.deepEqual(profiles.map(item => item.name), ['连接', '连接（1）', '连接（2）']);
    assert.equal(new Set(profiles.map(item => item.id)).size, 3);
});
