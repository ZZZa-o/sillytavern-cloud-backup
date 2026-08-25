/**
 * 合成文件的单元测试：用户人设与 API 连接配置。
 *
 *   node tools/synthetic-test.js
 *
 * 这两样都不是磁盘上的真实文件，而是从 settings.json / secrets.json 里抽出来的字段。
 * 下载时要**合并**回去而不是整份覆盖 —— 一旦搞错就会连 API 地址、界面偏好一起冲掉，
 * 所以这里在临时目录里造一台"目标机"，逐条断言什么该变、什么绝对不能动。
 *
 * 测试里的"密钥"都是编造的字符串，不涉及任何真实凭据。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const synthetic = require(path.join(__dirname, '..', 'server', 'synthetic.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${error.message}`);
    }
}

/** 造一个临时的用户数据目录，跑完就删。 */
function withUserDir(settings, secrets, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stcb-synth-'));
    try {
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 4), 'utf8');
        fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(secrets, null, 4), 'utf8');
        return fn({ root: dir }, {
            settings: () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')),
            secrets: () => JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')),
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const ALL = { all: true, selected: [] };

// 源机：两个人设、两个连接配置，各自引用一个密钥；另有一个代理预设
const SOURCE_SETTINGS = {
    api_server: 'http://源机地址/',
    power_user: {
        personas: { 'a.png': '甲', 'b.png': '乙' },
        persona_descriptions: {
            'a.png': { description: '甲的设定', position: 0, depth: 2, role: 0, lorebook: '', title: '' },
            'b.png': { description: '乙的设定', position: 0, depth: 2, role: 0, lorebook: '', title: '' },
        },
        default_persona: 'a.png',
    },
    proxies: [{ name: '源机代理', url: 'http://proxy', password: 'PROXYPW' }],
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

const SOURCE_SECRETS = {
    api_key_custom: [
        { id: 's1', value: 'KEY-ONE', label: '密钥一', active: true },
        { id: 's2', value: 'KEY-TWO', label: '密钥二', active: false },
        { id: 's3', value: 'KEY-UNUSED', label: '没被引用的', active: false },
    ],
};

console.log('\n[1] 用户人设');

test('只抽勾中的人设，没勾的不带走', () => {
    withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS, (dirs) => {
        const data = JSON.parse(synthetic.build('personas.json', dirs, {
            personas: { all: false, selected: ['a.png'] },
        }).toString());
        assert.deepStrictEqual(Object.keys(data.personas), ['a.png']);
        assert.deepStrictEqual(Object.keys(data.persona_descriptions), ['a.png']);
    });
});

test('默认人设没被勾中时不带走，免得指向一个不存在的人设', () => {
    withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS, (dirs) => {
        const data = JSON.parse(synthetic.build('personas.json', dirs, {
            personas: { all: false, selected: ['b.png'] },
        }).toString());
        assert.strictEqual(data.default_persona, null);
    });
});

test('下载是合并：本机人设保留，云端的加进来', () => {
    const local = {
        api_server: 'http://本机地址/',
        power_user: {
            personas: { 'mine.png': '本机' },
            persona_descriptions: { 'mine.png': { description: '本机的' } },
        },
    };
    withUserDir(local, {}, (dirs, read) => {
        const backup = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
            src => synthetic.build('personas.json', src, { personas: ALL }));
        synthetic.merge('personas.json', dirs, backup);

        const after = read.settings();
        assert.deepStrictEqual(
            Object.keys(after.power_user.personas).sort(),
            ['a.png', 'b.png', 'mine.png']);
        assert.strictEqual(after.power_user.persona_descriptions['mine.png'].description, '本机的');
        // 其余设置一个字都不能动
        assert.strictEqual(after.api_server, 'http://本机地址/');
    });
});

console.log('\n[2] API 连接配置');

test('勾中的配置连它引用的密钥明文与代理一起带上', () => {
    withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS, (dirs) => {
        const data = JSON.parse(synthetic.build('api-profiles.json', dirs, {
            apiProfiles: { all: false, selected: ['p1'] },
        }).toString());

        assert.deepStrictEqual(data.profiles.map(p => p.id), ['p1']);
        assert.deepStrictEqual(data.secrets.map(s => s.id), ['s1']);
        assert.strictEqual(data.secrets[0].value, 'KEY-ONE', '密钥要以明文备份');
        assert.strictEqual(data.secrets[0].key, 'api_key_custom', '要记住它属于哪个 key');
        assert.deepStrictEqual(data.proxies.map(p => p.name), ['源机代理']);
        assert.strictEqual(data.proxies[0].password, 'PROXYPW', '代理密码同样明文带上');
    });
});

test('没被任何勾中配置引用的密钥不会被带走', () => {
    withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS, (dirs) => {
        const data = JSON.parse(synthetic.build('api-profiles.json', dirs, {
            apiProfiles: { all: false, selected: ['p2'] },
        }).toString());
        assert.deepStrictEqual(data.secrets.map(s => s.id), ['s2']);
        // proxy 是 None，不该拽上任何代理
        assert.deepStrictEqual(data.proxies, []);
    });
});

test('下载是合并：本机配置、密钥、代理与其余设置都保留', () => {
    const local = {
        api_server: 'http://本机地址/',
        proxies: [{ name: '本机代理', url: 'http://local', password: 'LOCALPW' }],
        extension_settings: {
            connectionManager: {
                selectedProfile: 'local-1',
                profiles: [{ id: 'local-1', name: '本机配置' }],
            },
        },
    };
    const localSecrets = {
        api_key_custom: [{ id: 'local-s', value: 'LOCALKEY', label: '本机密钥', active: true }],
    };

    withUserDir(local, localSecrets, (dirs, read) => {
        const backup = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
            src => synthetic.build('api-profiles.json', src, { apiProfiles: ALL }));
        synthetic.merge('api-profiles.json', dirs, backup);

        const after = read.settings();
        const manager = after.extension_settings.connectionManager;
        assert.deepStrictEqual(manager.profiles.map(p => p.id).sort(), ['local-1', 'p1', 'p2']);
        // 当前连着哪个是设备状态，不该被云端切走
        assert.strictEqual(manager.selectedProfile, 'local-1');
        assert.strictEqual(after.api_server, 'http://本机地址/', '其余设置不能动');
        assert.deepStrictEqual(after.proxies.map(p => p.name).sort(), ['本机代理', '源机代理']);

        const secrets = read.secrets();
        assert.deepStrictEqual(secrets.api_key_custom.map(s => s.id).sort(), ['local-s', 's1', 's2']);
        assert.strictEqual(
            secrets.api_key_custom.find(s => s.id === 's1').value, 'KEY-ONE',
            '密钥明文要能原样落地');
    });
});

test('合并后本机原本激活的密钥仍然激活，且只有一个', () => {
    const localSecrets = {
        api_key_custom: [{ id: 'local-s', value: 'LOCALKEY', label: '本机密钥', active: true }],
    };
    withUserDir({}, localSecrets, (dirs, read) => {
        const backup = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
            src => synthetic.build('api-profiles.json', src, { apiProfiles: ALL }));
        synthetic.merge('api-profiles.json', dirs, backup);

        const list = read.secrets().api_key_custom;
        assert.strictEqual(list.filter(s => s.active).length, 1, '激活的密钥只能有一个');
        assert.strictEqual(list.find(s => s.active).id, 'local-s', '不该把本机在用的连接切走');
    });
});

test('全新机器一个密钥都没有时，导入的第一个自动激活', () => {
    withUserDir({}, {}, (dirs, read) => {
        const backup = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
            src => synthetic.build('api-profiles.json', src, { apiProfiles: ALL }));
        synthetic.merge('api-profiles.json', dirs, backup);

        const list = read.secrets().api_key_custom;
        assert.strictEqual(list.filter(s => s.active).length, 1);
    });
});

console.log('\n[3] 源数据变了要能被发现');

test('同样的数据两次序列化完全一致，不会白白重传', () => {
    withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS, (dirs) => {
        for (const file of ['personas.json', 'api-profiles.json']) {
            const group = file === 'personas.json' ? 'personas' : 'apiProfiles';
            const first = synthetic.build(file, dirs, { [group]: ALL });
            const second = synthetic.build(file, dirs, { [group]: ALL });
            assert.strictEqual(first.toString(), second.toString(), file);
        }
    });
});

test('键的插入顺序不同但内容相同时，结果依然一致', () => {
    const flipped = {
        ...SOURCE_SETTINGS,
        power_user: {
            default_persona: 'a.png',
            persona_descriptions: SOURCE_SETTINGS.power_user.persona_descriptions,
            personas: { 'b.png': '乙', 'a.png': '甲' },
        },
    };
    const a = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
        d => synthetic.build('personas.json', d, { personas: ALL }).toString());
    const b = withUserDir(flipped, SOURCE_SECRETS,
        d => synthetic.build('personas.json', d, { personas: ALL }).toString());
    assert.strictEqual(a, b);
});

test('源数据一改，合成结果就跟着变', () => {
    const changed = {
        ...SOURCE_SETTINGS,
        power_user: {
            ...SOURCE_SETTINGS.power_user,
            persona_descriptions: {
                ...SOURCE_SETTINGS.power_user.persona_descriptions,
                'a.png': { description: '改过的设定' },
            },
        },
    };
    const before = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
        d => synthetic.build('personas.json', d, { personas: ALL }).toString());
    const after = withUserDir(changed, SOURCE_SECRETS,
        d => synthetic.build('personas.json', d, { personas: ALL }).toString());
    assert.notStrictEqual(before, after);
});

test('密钥换了也算变化', () => {
    const rotated = {
        api_key_custom: SOURCE_SECRETS.api_key_custom.map(
            item => (item.id === 's1' ? { ...item, value: 'KEY-ROTATED' } : item)),
    };
    const before = withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS,
        d => synthetic.build('api-profiles.json', d, { apiProfiles: ALL }).toString());
    const after = withUserDir(SOURCE_SETTINGS, rotated,
        d => synthetic.build('api-profiles.json', d, { apiProfiles: ALL }).toString());
    assert.notStrictEqual(before, after);
});

console.log('\n[4] 可选项列表');

test('列出人设与配置档，标明哪个带密钥', () => {
    withUserDir(SOURCE_SETTINGS, SOURCE_SECRETS, (dirs) => {
        assert.deepStrictEqual(
            synthetic.listPersonas(dirs).map(p => p.value).sort(), ['a.png', 'b.png']);
        const profiles = synthetic.listApiProfiles(dirs);
        assert.deepStrictEqual(profiles.map(p => p.value), ['p1', 'p2']);
        assert.strictEqual(profiles[0].label, '配置一');
        assert.ok(profiles.every(p => p.hasSecret), '这两个配置都引用了密钥');
        // 列表是给界面用的，绝不能把密钥本身带出来
        assert.ok(!JSON.stringify(profiles).includes('KEY-'), '可选项列表里不该出现密钥');
    });
});

test('酒馆还没建过这两样东西时返回空列表，不抛异常', () => {
    withUserDir({}, {}, (dirs) => {
        assert.deepStrictEqual(synthetic.listPersonas(dirs), []);
        assert.deepStrictEqual(synthetic.listApiProfiles(dirs), []);
    });
});

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
