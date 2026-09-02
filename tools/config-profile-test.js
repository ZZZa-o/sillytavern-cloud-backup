/**
 * 多方案配置与旧格式迁移的单元测试。
 *
 *   node tools/config-profile-test.js
 *
 * 重点是三件容易出事的东西：
 *   旧配置迁移  连接信息从顶层搬进 profiles，间隔从小时折成分钟
 *   密码语义    前端从不回显密码，保存时送的是空串，不能因此把密码清掉
 *   投影一致    上层还按 config.url 取值，顶层投影必须始终等于当前方案
 */
const assert = require('node:assert');

const configStore = require('../server/config.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.error(`  ✗ ${name}\n    ${error.message}`);
    }
}

const { defaultConfig, mergeConfig, publicConfig, toStored, withActive } = configStore;

console.log('\n旧配置迁移');

test('顶层连接信息被包成一个方案', () => {
    const merged = mergeConfig(defaultConfig(), {
        url: 'https://dav.example.com/dav/',
        username: 'alice',
        password: 'pw',
        remotePath: 'mybak',
    });
    assert.strictEqual(merged.profiles.length, 1);
    assert.strictEqual(merged.profiles[0].url, 'https://dav.example.com/dav/');
    assert.strictEqual(merged.profiles[0].remotePath, 'mybak');
    assert.strictEqual(merged.activeProfileId, merged.profiles[0].id);
});

test('间隔按小时折成分钟 —— 6 是 6 小时，不是 6 分钟', () => {
    const merged = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', auto: { intervalHours: 6 } });
    assert.strictEqual(merged.auto.intervalMinutes, 360);
});

test('已经是分钟的配置照原样收下', () => {
    const merged = mergeConfig(defaultConfig(), { auto: { intervalMinutes: 45 } });
    assert.strictEqual(merged.auto.intervalMinutes, 45);
});

test('间隔被夹在 15 分钟到 7 天之间', () => {
    assert.strictEqual(mergeConfig(defaultConfig(), { auto: { intervalMinutes: 1 } }).auto.intervalMinutes, 15);
    assert.strictEqual(mergeConfig(defaultConfig(), { auto: { intervalMinutes: 99999 } }).auto.intervalMinutes, 10080);
    assert.strictEqual(mergeConfig(defaultConfig(), { auto: { intervalMinutes: 'x' } }).auto.intervalMinutes, 360);
});

test('已经是新格式的配置不再重复迁移', () => {
    const first = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', username: 'alice' });
    const again = mergeConfig(defaultConfig(), toStored(first));
    assert.strictEqual(again.profiles.length, 1);
    assert.strictEqual(again.profiles[0].username, 'alice');
});

console.log('\n密码');

test('保存时留空表示不修改，不会把已存的密码清掉', () => {
    const saved = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', password: 'secret' });
    // 前端回送时密码位置是空串
    const resaved = mergeConfig(saved, {
        ...toStored(saved),
        profiles: saved.profiles.map(item => ({ ...item, password: '' })),
    });
    assert.strictEqual(resaved.profiles[0].password, 'secret');
});

test('显式 clearPassword 才真的清掉', () => {
    const saved = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', password: 'secret' });
    const cleared = mergeConfig(saved, {
        ...toStored(saved),
        profiles: saved.profiles.map(item => ({ ...item, password: '', clearPassword: true })),
    });
    assert.strictEqual(cleared.profiles[0].password, '');
});

test('改名换地址都不会把密码弄丢（按 id 找旧密码）', () => {
    const saved = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', password: 'secret' });
    const edited = mergeConfig(saved, {
        ...toStored(saved),
        profiles: saved.profiles.map(item => ({
            ...item, password: '', name: '改过的名字', url: 'https://b.example/dav/',
        })),
    });
    assert.strictEqual(edited.profiles[0].password, 'secret');
    assert.strictEqual(edited.profiles[0].name, '改过的名字');
});

test('给前端的配置里没有任何密码明文', () => {
    const saved = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', password: 'secret' });
    const pub = publicConfig(saved);
    assert.ok(!JSON.stringify(pub).includes('secret'));
    assert.strictEqual(pub.hasPassword, true);
    assert.strictEqual(pub.profiles[0].hasPassword, true);
    assert.strictEqual(pub.profiles[0].password, undefined);
});

test('落盘只写权威字段，密码不会存成两份', () => {
    const saved = mergeConfig(defaultConfig(), { url: 'https://a.example/dav/', password: 'secret' });
    assert.deepStrictEqual(
        Object.keys(toStored(saved)).sort(),
        ['activeProfileId', 'auto', 'profiles', 'scope'],
    );
});

console.log('\n多方案');

const twoProfiles = {
    activeProfileId: 'p-two',
    profiles: [
        { id: 'p-one', name: '坚果云', url: 'https://one.example/dav/', password: 'pw1', remotePath: 'a' },
        { id: 'p-two', name: '备用', url: 'https://two.example/dav/', password: 'pw2', remotePath: 'b' },
    ],
};

test('顶层是当前方案的投影', () => {
    const merged = mergeConfig(defaultConfig(), twoProfiles);
    assert.strictEqual(merged.url, 'https://two.example/dav/');
    assert.strictEqual(merged.remotePath, 'b');
    assert.strictEqual(merged.password, 'pw2');
});

test('切换方案后投影跟着换，两条的密码互不干扰', () => {
    const merged = mergeConfig(defaultConfig(), twoProfiles);
    const switched = withActive({ ...merged, activeProfileId: 'p-one' });
    assert.strictEqual(switched.url, 'https://one.example/dav/');
    assert.strictEqual(switched.password, 'pw1');
    assert.strictEqual(switched.profiles[1].password, 'pw2');
});

test('activeProfileId 指向不存在的方案时退回第一条', () => {
    const merged = mergeConfig(defaultConfig(), { ...twoProfiles, activeProfileId: 'p-gone' });
    assert.strictEqual(merged.activeProfileId, 'p-one');
    assert.strictEqual(merged.url, 'https://one.example/dav/');
});

test('备份范围与自动上传是全局的，不跟着方案走', () => {
    const merged = mergeConfig(defaultConfig(), {
        ...twoProfiles,
        scope: { worlds: { all: true, selected: [] } },
        auto: { enabled: true, intervalMinutes: 30 },
    });
    assert.strictEqual(merged.scope.worlds.all, true);
    assert.strictEqual(merged.auto.intervalMinutes, 30);
    // 方案自己不带这两样
    assert.strictEqual(merged.profiles[0].scope, undefined);
    assert.strictEqual(merged.profiles[0].auto, undefined);
});

test('上次备份时间记在各自方案上', () => {
    const merged = mergeConfig(defaultConfig(), {
        activeProfileId: 'p-two',
        profiles: [
            { id: 'p-one', name: 'A', url: 'https://a.example/dav/', lastBackupAt: '2026-01-01T00:00:00.000Z' },
            { id: 'p-two', name: 'B', url: 'https://b.example/dav/', lastBackupAt: '2026-06-01T00:00:00.000Z' },
        ],
    });
    assert.strictEqual(merged.lastBackupAt, '2026-06-01T00:00:00.000Z');
    assert.strictEqual(merged.profiles[0].lastBackupAt, '2026-01-01T00:00:00.000Z');
});

test('手改配置粘出两条同 id 时重发一个，不让它们互相串', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [
            { id: 'same', name: 'A', url: 'https://a.example/dav/' },
            { id: 'same', name: 'B', url: 'https://b.example/dav/' },
        ],
    });
    assert.strictEqual(merged.profiles.length, 2);
    assert.notStrictEqual(merged.profiles[0].id, merged.profiles[1].id);
});

test('没带 profiles 的请求不会把已存的方案冲掉', () => {
    const saved = mergeConfig(defaultConfig(), twoProfiles);
    const merged = mergeConfig(saved, { scope: {}, auto: { enabled: true } });
    assert.strictEqual(merged.profiles.length, 2);
    assert.strictEqual(merged.profiles[1].password, 'pw2');
});

test('方案被删光时兜底补一条空的', () => {
    const merged = mergeConfig(defaultConfig(), { profiles: [] });
    assert.strictEqual(merged.profiles.length, 1);
    assert.strictEqual(merged.url, '');
});

console.log('\n加密设置（方案级）');

test('默认不开加密，也没有口令', () => {
    const config = defaultConfig();
    assert.strictEqual(config.encryption.enabled, false);
    assert.strictEqual(config.encryption.passphrase, '');
});

test('老配置迁移过来时加密默认关闭，不影响现有用户', () => {
    const merged = mergeConfig(defaultConfig(), {
        url: 'https://dav.example.com/dav/',
        username: 'alice',
        password: 'pw',
    });
    assert.strictEqual(merged.encryption.enabled, false);
    assert.strictEqual(merged.profiles[0].encryption.passphrase, '');
});

test('口令留空表示不修改，不会因为前端没回显就被清掉', () => {
    const saved = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    // 前端保存配置时送的是空口令 —— 这是常态，每次点「保存配置」都这样
    const again = mergeConfig(saved, {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: '' } }],
        activeProfileId: 'p1',
    });
    assert.strictEqual(again.encryption.passphrase, 'secret');
});

test('clearPassphrase 才真的清掉口令', () => {
    const saved = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    const cleared = mergeConfig(saved, {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: false, clearPassphrase: true } }],
        activeProfileId: 'p1',
    });
    assert.strictEqual(cleared.encryption.passphrase, '');
    assert.strictEqual(cleared.encryption.enabled, false);
});

test('改名换地址都不会把口令弄丢（按 id 找旧值）', () => {
    const saved = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', name: '坚果云', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    const renamed = mergeConfig(saved, {
        profiles: [{ id: 'p1', name: '换个名字', url: 'https://b.example/dav/', encryption: { enabled: true } }],
        activeProfileId: 'p1',
    });
    assert.strictEqual(renamed.encryption.passphrase, 'secret');
});

test('两个方案的加密设置互不干扰：坚果云开着，NAS 关着', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [
            { id: 'p1', name: '坚果云', url: 'https://dav.jianguoyun.com/dav/', encryption: { enabled: true, passphrase: 'secret' } },
            { id: 'p2', name: 'NAS', url: 'https://nas.local/dav/', encryption: { enabled: false } },
        ],
        activeProfileId: 'p2',
    });
    assert.strictEqual(merged.profiles[0].encryption.enabled, true);
    assert.strictEqual(merged.profiles[1].encryption.enabled, false);
    // 顶层投影跟着当前方案走
    assert.strictEqual(merged.encryption.enabled, false);
});

test('publicConfig 不回传口令明文，只说存没存', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    const shown = publicConfig(merged);
    assert.strictEqual(JSON.stringify(shown).includes('secret'), false);
    assert.strictEqual(shown.encryption.hasPassphrase, true);
    assert.strictEqual(shown.encryption.enabled, true);
    assert.strictEqual(shown.profiles[0].encryption.hasPassphrase, true);
    assert.strictEqual(shown.profiles[0].encryption.passphrase, undefined);
});

test('toStored 把口令留在盘上（它是权威数据，不能丢）', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    assert.strictEqual(toStored(merged).profiles[0].encryption.passphrase, 'secret');
});

console.log(`\n${failed ? '❌' : '✅'} 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
