/** 人设与 API 配置的逐项提取、合并和内容变化测试。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const synthetic = require('../server/synthetic.js');
const paths = require('../server/paths.js');

const SETTINGS = {
    api_server: 'http://source.example/',
    power_user: {
        personas: { 'a.png': '甲', 'b.png': '乙' },
        persona_descriptions: {
            'a.png': { description: '甲的设定', position: 0, depth: 2, role: 0 },
            'b.png': { description: '乙的设定', position: 0, depth: 2, role: 0 },
        },
        default_persona: 'a.png',
    },
    proxies: [{ name: '源机代理', url: 'http://proxy.example/', password: 'TEST-PROXY-PW' }],
    extension_settings: {
        connectionManager: {
            selectedProfile: 'p1',
            profiles: [
                { id: 'p1', name: '配置一', api: 'custom', 'secret-id': 's1', proxy: '源机代理' },
                { id: 'p2', name: '配置二', api: 'custom', 'secret-id': 's2', proxy: 'None' },
            ],
        },
    },
};
const SECRETS = {
    api_key_custom: [
        { id: 's1', value: 'TEST-KEY-ONE', label: '密钥一', active: true },
        { id: 's2', value: 'TEST-KEY-TWO', label: '密钥二', active: false },
        { id: 'unused', value: 'TEST-KEY-UNUSED', label: '未引用', active: false },
    ],
};
const PERSONA = 'personas/甲.json';
const PROFILE = 'api-profiles/配置一.json';

function withUser(settings, secrets, fn, avatars = Object.keys(settings.power_user?.personas || {})) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stcb-synth-'));
    const directories = { root, avatars: path.join(root, 'User Avatars') };
    fs.mkdirSync(directories.avatars);
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings), 'utf8');
    fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify(secrets), 'utf8');
    for (const avatar of avatars) fs.writeFileSync(path.join(directories.avatars, avatar), 'fixture');
    const read = name => JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'));
    try {
        return fn(directories, read);
    } finally {
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function build(directories, file) {
    return synthetic.build(file, directories, paths.buildNameIndex({}, directories));
}

function fromSource(files) {
    return withUser(SETTINGS, SECRETS, directories => files.map(file => build(directories, file)));
}

test('只为勾选的人设生成文件', () => {
    withUser(SETTINGS, SECRETS, directories => {
        const names = paths.buildNameIndex({}, directories);
        const files = synthetic.listPersonaFiles(directories, { all: false, selected: ['a.png'] }, names.personas.byAvatar);
        assert.deepEqual(files.map(file => file.localRel), [PERSONA]);
        const data = JSON.parse(build(directories, PERSONA));
        assert.equal(data.avatar, 'a.png');
        assert.equal(data.name, '甲');
        assert.equal(data.description.description, '甲的设定');
        assert.equal(data.isDefault, true);
        assert.equal(JSON.stringify(data).includes('乙'), false);
    });
});

test('非默认人设不携带默认状态', () => {
    withUser(SETTINGS, SECRETS, directories => {
        assert.equal(JSON.parse(build(directories, 'personas/乙.json')).isDefault, false);
    });
});

test('导入人设保留本机其他人设和设置', () => {
    const local = {
        api_server: 'http://local.example/',
        power_user: {
            personas: { 'mine.png': '本机' },
            persona_descriptions: { 'mine.png': { description: '本机设定' } },
            default_persona: 'mine.png',
        },
    };
    const [buffer] = fromSource(['personas/乙.json']);
    withUser(local, {}, (directories, read) => {
        synthetic.merge('personas/乙.json', directories, buffer);
        const after = read('settings');
        assert.equal(after.api_server, local.api_server);
        assert.equal(after.power_user.personas['mine.png'], '本机');
        assert.equal(after.power_user.personas['b.png'], '乙');
        assert.equal(after.power_user.default_persona, 'mine.png');
        assert.equal(after.power_user.persona_descriptions['mine.png'].description, '本机设定');
    });
});

test('导入空白人设会清除对应的本机名字与描述', () => {
    withUser(SETTINGS, SECRETS, (directories, read) => {
        const incoming = { avatar: 'a.png', name: '', description: null, isDefault: false };
        synthetic.merge(PERSONA, directories, Buffer.from(JSON.stringify(incoming)));
        const power = read('settings').power_user;
        assert.equal(power.personas['a.png'], '');
        assert.equal(Object.hasOwn(power.persona_descriptions, 'a.png'), false);
        assert.equal(power.persona_descriptions['b.png'].description, '乙的设定');
    });
});

test('已读取的人设在下载合并后立即使用新内容', () => {
    withUser(SETTINGS, SECRETS, directories => {
        const incoming = JSON.parse(build(directories, PERSONA));
        incoming.description.description = '云端修改后的人设';
        synthetic.merge(PERSONA, directories, Buffer.from(JSON.stringify(incoming)));
        const updated = JSON.parse(build(directories, PERSONA));
        assert.equal(updated.description.description, incoming.description.description);
    });
});

test('拒绝人设文件中的越界头像路径', () => {
    withUser(SETTINGS, SECRETS, directories => {
        assert.throws(() => synthetic.merge(PERSONA, directories,
            Buffer.from(JSON.stringify({ avatar: '../../outside.png' }))), /头像文件名/);
    });
});

test('单档 API 配置只携带引用的密钥和代理', () => {
    withUser(SETTINGS, SECRETS, directories => {
        const data = JSON.parse(build(directories, PROFILE));
        assert.deepEqual(data.profiles.map(item => item.id), ['p1']);
        assert.deepEqual(data.secrets.map(item => item.id), ['s1']);
        assert.equal(data.secrets[0].value, 'TEST-KEY-ONE');
        assert.equal(data.secrets[0].key, 'api_key_custom');
        assert.deepEqual(data.proxies.map(item => item.name), ['源机代理']);
        assert.equal(data.proxies[0].password, 'TEST-PROXY-PW');
    });
});

test('没有引用代理的配置不带代理数据', () => {
    withUser(SETTINGS, SECRETS, directories => {
        const data = JSON.parse(build(directories, 'api-profiles/配置二.json'));
        assert.deepEqual(data.secrets.map(item => item.id), ['s2']);
        assert.deepEqual(data.proxies, []);
    });
});

test('逐档导入保留本机连接、密钥和代理', () => {
    const local = {
        api_server: 'http://local.example/',
        proxies: [{ name: '本机代理', url: 'http://local-proxy.example/' }],
        extension_settings: { connectionManager: {
            selectedProfile: 'local',
            profiles: [{ id: 'local', name: '本机配置' }],
        } },
    };
    const localSecrets = { api_key_custom: [{ id: 'local-secret', value: 'TEST-LOCAL', active: true }] };
    const files = [PROFILE, 'api-profiles/配置二.json'];
    const buffers = fromSource(files);
    withUser(local, localSecrets, (directories, read) => {
        files.forEach((file, index) => synthetic.merge(file, directories, buffers[index]));
        const after = read('settings');
        const manager = after.extension_settings.connectionManager;
        assert.deepEqual(manager.profiles.map(item => item.id).sort(), ['local', 'p1', 'p2']);
        assert.equal(manager.selectedProfile, 'local');
        assert.equal(after.api_server, local.api_server);
        assert.deepEqual(after.proxies.map(item => item.name).sort(), ['本机代理', '源机代理']);
        const secrets = read('secrets').api_key_custom;
        assert.deepEqual(secrets.map(item => item.id).sort(), ['local-secret', 's1', 's2']);
        assert.deepEqual(secrets.filter(item => item.active).map(item => item.id), ['local-secret']);
        assert.equal(secrets.find(item => item.id === 's1').value, 'TEST-KEY-ONE');
    });
});

test('首次导入时激活导入的密钥', () => {
    const [buffer] = fromSource([PROFILE]);
    withUser({}, {}, (directories, read) => {
        synthetic.merge(PROFILE, directories, buffer);
        assert.deepEqual(read('secrets').api_key_custom.filter(item => item.active).map(item => item.id), ['s1']);
    });
});

test('反复导入同一配置不会复制条目', () => {
    const [buffer] = fromSource([PROFILE]);
    withUser({}, {}, (directories, read) => {
        synthetic.merge(PROFILE, directories, buffer);
        synthetic.merge(PROFILE, directories, buffer);
        assert.equal(read('settings').extension_settings.connectionManager.profiles.length, 1);
        assert.equal(read('secrets').api_key_custom.length, 1);
    });
});

test('相同内容反复生成得到相同字节', () => {
    withUser(SETTINGS, SECRETS, directories => {
        for (const file of [PERSONA, PROFILE]) {
            assert.deepEqual(build(directories, file), build(directories, file));
        }
    });
});

test('对象键顺序不影响合成内容', () => {
    function reverseKeys(value) {
        if (Array.isArray(value)) return value.map(reverseKeys);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
        }
        return value;
    }
    const first = fromSource([PERSONA, PROFILE]);
    const reordered = withUser(reverseKeys(SETTINGS), reverseKeys(SECRETS),
        directories => [build(directories, PERSONA), build(directories, PROFILE)]);
    assert.deepEqual(reordered, first);
});

test('修改人设内容只改变对应人设文件', () => {
    const changed = structuredClone(SETTINGS);
    changed.power_user.persona_descriptions['a.png'].description = '新的设定';
    const first = fromSource([PERSONA, 'personas/乙.json', PROFILE]);
    const after = withUser(changed, SECRETS,
        directories => [build(directories, PERSONA), build(directories, 'personas/乙.json'), build(directories, PROFILE)]);
    assert.notDeepEqual(after[0], first[0]);
    assert.deepEqual(after.slice(1), first.slice(1));
});

test('修改无关设置不改变人设和 API 配置文件', () => {
    const changed = { ...SETTINGS, api_server: 'http://another.example/', unrelated: 'changed' };
    const after = withUser(changed, SECRETS, directories => [build(directories, PERSONA), build(directories, PROFILE)]);
    assert.deepEqual(after, fromSource([PERSONA, PROFILE]));
});

test('轮换密钥会改变引用它的配置文件', () => {
    const secrets = structuredClone(SECRETS);
    secrets.api_key_custom[0].value = 'TEST-ROTATED';
    const after = withUser(SETTINGS, secrets,
        directories => [build(directories, PROFILE), build(directories, 'api-profiles/配置二.json')]);
    const first = fromSource([PROFILE, 'api-profiles/配置二.json']);
    assert.notDeepEqual(after[0], first[0]);
    assert.deepEqual(after[1], first[1]);
});

test('可选项列表不包含密钥正文', () => {
    withUser(SETTINGS, SECRETS, directories => {
        assert.deepEqual(synthetic.listPersonas(directories).map(item => item.value), ['a.png', 'b.png']);
        const profiles = synthetic.listApiProfiles(directories);
        assert.deepEqual(profiles.map(item => item.value), ['p1', 'p2']);
        assert.equal(profiles.every(item => item.hasSecret), true);
        assert.equal(JSON.stringify(profiles).includes('TEST-KEY'), false);
    });
});

test('没有内容时显示空列表', () => {
    withUser({}, {}, directories => {
        assert.deepEqual(synthetic.listPersonas(directories), []);
        assert.deepEqual(synthetic.listApiProfiles(directories), []);
    });
});

test('人设选项只列出现有头像', () => {
    const settings = structuredClone(SETTINGS);
    settings.power_user.personas['gone.png'] = '已删除';
    withUser(settings, SECRETS, directories => {
        assert.deepEqual(synthetic.listPersonas(directories).map(item => item.value), ['a.png', 'b.png']);
    }, ['a.png', 'b.png']);
});

test('人设长名称显示摘要并保留完整名字', () => {
    const settings = structuredClone(SETTINGS);
    settings.power_user.personas['a.png'] = '甲'.repeat(80);
    withUser(settings, SECRETS, directories => {
        const item = synthetic.listPersonas(directories).find(entry => entry.value === 'a.png');
        assert.ok(item.label.length <= 41);
        assert.equal(item.fullName.length, 80);
    });
});

test('逐项备份路径可以往返映射', () => {
    withUser(SETTINGS, SECRETS, directories => {
        const names = paths.buildNameIndex({}, directories);
        for (const file of [PERSONA, PROFILE, 'User Avatars/a.png']) {
            assert.equal(paths.toLocal(paths.toRemote(file, names), names), file);
        }
        assert.equal(paths.toRemote(PERSONA, names), '用户人设/甲/persona.json');
        assert.equal(paths.toRemote(PROFILE, names), 'API配置/配置一.json');
    });
});

test('范围只包含选中的人设和配置', () => {
    withUser(SETTINGS, SECRETS, directories => {
        const names = paths.buildNameIndex({}, directories);
        const scope = { personas: { all: false, selected: ['a.png'] }, apiProfiles: { all: false, selected: ['p1'] } };
        assert.equal(paths.inScope(PERSONA, scope, names), true);
        assert.equal(paths.inScope('personas/乙.json', scope, names), false);
        assert.equal(paths.inScope(PROFILE, scope, names), true);
        assert.equal(paths.inScope('api-profiles/配置二.json', scope, names), false);
    });
});
