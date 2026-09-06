/**
 * 多方案配置测试：凭据保存、当前方案投影与配置校验。
 * 运行：node tools/config-profile-test.js
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

function configured(fields) {
    const base = defaultConfig();
    return mergeConfig(base, {
        ...toStored(base), profiles: [{ ...base.profiles[0], ...fields }],
    });
}

console.log('\n配置读写');

test('连接信息保存在当前方案', () => {
    const merged = configured({
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

test('已经是分钟的配置照原样收下', () => {
    const merged = mergeConfig(defaultConfig(), { auto: { intervalMinutes: 45 } });
    assert.strictEqual(merged.auto.intervalMinutes, 45);
});

test('间隔被夹在 15 分钟到 7 天之间', () => {
    assert.strictEqual(mergeConfig(defaultConfig(), { auto: { intervalMinutes: 1 } }).auto.intervalMinutes, 15);
    assert.strictEqual(mergeConfig(defaultConfig(), { auto: { intervalMinutes: 99999 } }).auto.intervalMinutes, 10080);
    assert.throws(() => mergeConfig(defaultConfig(), { auto: { intervalMinutes: 'x' } }), /必须是数字/);
});

test('配置序列化后保留方案和连接信息', () => {
    const first = configured({ url: 'https://a.example/dav/', username: 'alice' });
    const again = mergeConfig(defaultConfig(), toStored(first));
    assert.strictEqual(again.profiles.length, 1);
    assert.strictEqual(again.profiles[0].username, 'alice');
});

console.log('\n密码');

test('保存时留空表示不修改，不会把已存的密码清掉', () => {
    const saved = configured({ url: 'https://a.example/dav/', password: 'secret' });
    // 模拟前端提交空密码。
    const resaved = mergeConfig(saved, {
        ...toStored(saved),
        profiles: saved.profiles.map(item => ({ ...item, password: '' })),
    });
    assert.strictEqual(resaved.profiles[0].password, 'secret');
});

test('显式 clearPassword 才真的清掉', () => {
    const saved = configured({ url: 'https://a.example/dav/', password: 'secret' });
    const cleared = mergeConfig(saved, {
        ...toStored(saved),
        profiles: saved.profiles.map(item => ({ ...item, password: '', clearPassword: true })),
    });
    assert.strictEqual(cleared.profiles[0].password, '');
});

test('按 id 保留重命名或更换地址后的密码', () => {
    const saved = configured({ url: 'https://a.example/dav/', password: 'secret' });
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
    const saved = configured({ url: 'https://a.example/dav/', password: 'secret' });
    const pub = publicConfig(saved);
    assert.ok(!JSON.stringify(pub).includes('secret'));
    assert.strictEqual(pub.hasPassword, true);
    assert.strictEqual(pub.profiles[0].hasPassword, true);
    assert.strictEqual(pub.profiles[0].password, undefined);
});

test('落盘仅保存方案字段', () => {
    const saved = configured({ url: 'https://a.example/dav/', password: 'secret' });
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

test('当前方案不存在时报告错误', () => {
    assert.throws(() => mergeConfig(defaultConfig(), { ...twoProfiles, activeProfileId: 'p-gone' }), /当前方案不存在/);
});

test('备份范围与自动上传是全局的，不跟着方案走', () => {
    const merged = mergeConfig(defaultConfig(), {
        ...twoProfiles,
        scope: { worlds: { all: true, selected: [] } },
        auto: { enabled: true, intervalMinutes: 30 },
    });
    assert.strictEqual(merged.scope.worlds.all, true);
    assert.strictEqual(merged.auto.intervalMinutes, 30);
    // 方案中省略全局范围与自动上传字段。
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

test('拒绝重复的方案 ID', () => {
    assert.throws(() => mergeConfig(defaultConfig(), {
        profiles: [{ id: 'same' }, { id: 'same' }], activeProfileId: 'same',
    }), /方案 ID/);
});

test('没带 profiles 的请求不会把已存的方案冲掉', () => {
    const saved = mergeConfig(defaultConfig(), twoProfiles);
    const merged = mergeConfig(saved, { scope: {}, auto: { enabled: true } });
    assert.strictEqual(merged.profiles.length, 2);
    assert.strictEqual(merged.profiles[1].password, 'pw2');
});

test('拒绝删除全部方案', () => {
    assert.throws(() => mergeConfig(defaultConfig(), { profiles: [] }), /至少要保留/);
});

console.log('\n加密设置（方案级）');

test('默认不开加密，也没有口令', () => {
    const config = defaultConfig();
    assert.strictEqual(config.encryption.enabled, false);
    assert.strictEqual(config.encryption.passphrase, '');
});

test('新建方案默认关闭加密', () => {
    const merged = configured({
        url: 'https://dav.example.com/dav/',
        username: 'alice',
        password: 'pw',
    });
    assert.strictEqual(merged.encryption.enabled, false);
    assert.strictEqual(merged.profiles[0].encryption.passphrase, '');
});

test('口令留空时保留已保存的口令', () => {
    const saved = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    // 提交空口令，验证原口令保留。
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

test('按 id 保留重命名或更换地址后的口令', () => {
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

test('publicConfig 回传加密口令', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    const shown = publicConfig(merged);
    assert.strictEqual(shown.encryption.enabled, true);
    assert.strictEqual(shown.encryption.hasPassphrase, true);
    assert.strictEqual(shown.encryption.passphrase, 'secret');
    assert.strictEqual(shown.profiles[0].encryption.passphrase, 'secret');
});

test('publicConfig 隐藏 WebDAV 授权密码', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [{
            id: 'p1',
            url: 'https://a.example/dav/',
            password: 'davpw',
            encryption: { enabled: true, passphrase: 'secret' },
        }],
        activeProfileId: 'p1',
    });
    const shown = publicConfig(merged);
    assert.strictEqual(JSON.stringify(shown).includes('davpw'), false);
    assert.strictEqual(shown.hasPassword, true);
    assert.strictEqual(shown.profiles[0].password, undefined);
});

test('toStored 保存加密口令', () => {
    const merged = mergeConfig(defaultConfig(), {
        profiles: [{ id: 'p1', url: 'https://a.example/dav/', encryption: { enabled: true, passphrase: 'secret' } }],
        activeProfileId: 'p1',
    });
    assert.strictEqual(toStored(merged).profiles[0].encryption.passphrase, 'secret');
});

console.log(`\n${failed ? '❌' : '✅'} 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
