/**
 * 备份核心逻辑的单元测试。
 *
 *   node tools/backup-logic-test.js
 *
 * 只测纯函数：路径映射、范围判定、上传/下载计划。
 * server/ 下这些模块只依赖 Node 内置模块，不需要指向 SillyTavern 的 node_modules。
 */
const assert = require('node:assert');
const path = require('node:path');

const paths = require(path.join(__dirname, '..', 'server', 'paths.js'));
const { buildPlan, summarizePlan } = require(path.join(__dirname, '..', 'server', 'backup.js'));

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

// 常用夹具：角色甲的 png 文件名是一串乱码，正是本插件要解决的场景
const NAMES = paths.buildNameIndex({
    'k7f2q9x1.png': '角色甲',
    'm3p8w5.png': '角色乙',
    'n9t4r6.png': '角色丙',
});

const ALL_SCOPE = {
    characters: { all: true, selected: [] },
    chats: { enabled: true },
    worlds: { all: true, selected: [] },
    settings: { enabled: true },
};

const scopeWith = patch => ({ ...ALL_SCOPE, ...patch });

console.log('\n[1] 角色名映射');

test('乱码 png 按角色名存到云端', () => {
    assert.strictEqual(
        paths.toRemote('characters/k7f2q9x1.png', NAMES),
        '角色卡/角色甲.png',
    );
});

test('聊天目录同样换成角色名', () => {
    assert.strictEqual(
        paths.toRemote('chats/k7f2q9x1/2026-08-01 12h30m.jsonl', NAMES),
        '聊天记录/角色甲/2026-08-01 12h30m.jsonl',
    );
});

test('角色附件目录跟着角色名走', () => {
    assert.strictEqual(
        paths.toRemote('characters/k7f2q9x1/note.png', NAMES),
        '角色卡/角色甲/note.png',
    );
});

test('没有角色名映射时退回文件名，不报错', () => {
    const empty = paths.buildNameIndex({});
    assert.strictEqual(paths.toRemote('characters/未知卡.png', empty), '角色卡/未知卡.png');
    assert.strictEqual(paths.toRemote('chats/未知卡/x.jsonl', empty), '聊天记录/未知卡/x.jsonl');
});

test('重名角色加序号，且同一批输入结果稳定', () => {
    const input = { 'b.png': '角色甲', 'a.png': '角色甲' };
    const first = paths.buildNameIndex(input);
    const second = paths.buildNameIndex(input);
    assert.deepStrictEqual(first.byAvatar, second.byAvatar);
    const values = Object.values(first.byAvatar).sort();
    assert.deepStrictEqual(values, ['角色甲', '角色甲 (2)']);
});

test('角色名里的非法字符被转义', () => {
    const names = paths.buildNameIndex({ 'x.png': 'a/b:c' });
    const remote = paths.toRemote('characters/x.png', names);
    assert.ok(!/[\\:*?"<>|]/.test(remote.split('/')[1]), remote);
    assert.strictEqual(remote.split('/').length, 2, `不该多出目录层级：${remote}`);
});

console.log('\n[2] 云端四个文件夹');

test('四类各自落到自己的文件夹', () => {
    assert.strictEqual(paths.toRemote('worlds/世界书甲.json', NAMES), '世界书/世界书甲.json');
    assert.strictEqual(paths.toRemote('settings.json', NAMES), '设置/settings.json');
    assert.ok(paths.toRemote('characters/m3p8w5.png', NAMES).startsWith('角色卡/'));
    assert.ok(paths.toRemote('chats/m3p8w5/x.jsonl', NAMES).startsWith('聊天记录/'));
});

test('群聊与群组收在聊天记录下面', () => {
    assert.strictEqual(paths.toRemote('group chats/群甲/x.jsonl', NAMES), '聊天记录/_群聊/群甲/x.jsonl');
    assert.strictEqual(paths.toRemote('groups/g1.json', NAMES), '聊天记录/_群组/g1.json');
});

test('不认识的本地路径不产生远端路径', () => {
    assert.strictEqual(paths.toRemote('backups/x.zip', NAMES), null);
    assert.strictEqual(paths.toRemote('', NAMES), null);
});

console.log('\n[3] 远端 → 本地往返');

test('每一类都能原样还原', () => {
    const samples = [
        'characters/k7f2q9x1.png',
        'characters/k7f2q9x1/note.png',
        'chats/k7f2q9x1/2026-08-01 12h30m.jsonl',
        'group chats/群甲/x.jsonl',
        'groups/g1.json',
        'worlds/世界书甲.json',
        'settings.json',
    ];
    for (const local of samples) {
        const remote = paths.toRemote(local, NAMES);
        assert.strictEqual(paths.toLocal(remote, NAMES), local, `${local} → ${remote} → ${paths.toLocal(remote, NAMES)}`);
    }
});

test('换台机器没有同名角色时，按角色名新建而不是丢内容', () => {
    const empty = paths.buildNameIndex({});
    assert.strictEqual(paths.toLocal('角色卡/角色甲.png', empty), 'characters/角色甲.png');
    assert.strictEqual(paths.toLocal('聊天记录/角色甲/x.jsonl', empty), 'chats/角色甲/x.jsonl');
});

test('元数据与认不出来的路径不会被当成可还原的文件', () => {
    assert.strictEqual(paths.toLocal('.st-sync/index.json', NAMES), null);
    assert.strictEqual(paths.toLocal('随手传的/东西.zip', NAMES), null);
});

console.log('\n[4] 范围判定');

test('全选时四类都在范围内', () => {
    assert.strictEqual(paths.inScope('characters/k7f2q9x1.png', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/x.jsonl', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('worlds/世界书甲.json', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('settings.json', ALL_SCOPE), true);
});

test('只选一张角色卡时，别的角色卡与它的聊天都被排除', () => {
    const scope = scopeWith({ characters: { all: false, selected: ['k7f2q9x1.png'] } });
    assert.strictEqual(paths.inScope('characters/k7f2q9x1.png', scope), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/x.jsonl', scope), true);
    assert.strictEqual(paths.inScope('characters/m3p8w5.png', scope), false);
    assert.strictEqual(paths.inScope('chats/m3p8w5/x.jsonl', scope), false);
});

test('聊天记录跟随角色卡：关掉聊天只留角色卡', () => {
    const scope = scopeWith({ chats: { enabled: false } });
    assert.strictEqual(paths.inScope('characters/k7f2q9x1.png', scope), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/x.jsonl', scope), false);
    assert.strictEqual(paths.inScope('group chats/群甲/x.jsonl', scope), false);
});

test('群聊不隶属角色卡，只选一张卡时依然整体带上', () => {
    const scope = scopeWith({ characters: { all: false, selected: ['k7f2q9x1.png'] } });
    assert.strictEqual(paths.inScope('group chats/群甲/x.jsonl', scope), true);
    assert.strictEqual(paths.inScope('groups/g1.json', scope), true);
});

test('世界书按名字选', () => {
    const scope = scopeWith({ worlds: { all: false, selected: ['世界书甲'] } });
    assert.strictEqual(paths.inScope('worlds/世界书甲.json', scope), true);
    assert.strictEqual(paths.inScope('worlds/世界书乙.json', scope), false);
});

test('设置默认不备份，勾上才进范围', () => {
    assert.strictEqual(paths.inScope('settings.json', scopeWith({ settings: { enabled: false } })), false);
    assert.strictEqual(paths.inScope('settings.json', scopeWith({ settings: { enabled: true } })), true);
});

test('范围之外的路径一律拒绝', () => {
    assert.strictEqual(paths.inScope('backups/x.zip', ALL_SCOPE), false);
    assert.strictEqual(paths.inScope('.st-sync/index.json', ALL_SCOPE), false);
    assert.strictEqual(paths.inScope('secrets.json', ALL_SCOPE), false);
});

console.log('\n[4b] 已内嵌在角色卡里的世界书');

test('全选世界书时，跳过已内嵌在角色卡里的那些', () => {
    const scope = scopeWith({ worlds: { all: true, selected: [], exclude: ['世界书甲'] } });
    assert.strictEqual(paths.inScope('worlds/世界书甲.json', scope), false);
    assert.strictEqual(paths.inScope('worlds/世界书乙.json', scope), true);
});

test('用户显式勾选的世界书照传，排除名单不越权', () => {
    const scope = scopeWith({ worlds: { all: false, selected: ['世界书甲'], exclude: ['世界书甲'] } });
    assert.strictEqual(paths.inScope('worlds/世界书甲.json', scope), true);
});

test('没有排除名单时行为不变', () => {
    const scope = scopeWith({ worlds: { all: true, selected: [] } });
    assert.strictEqual(paths.inScope('worlds/世界书甲.json', scope), true);
});

console.log('\n[4c] 下载后要热刷新哪个列表');

test('每类文件都能归到正确的类别', () => {
    assert.strictEqual(paths.categoryOf('characters/角色甲.png'), 'characters');
    assert.strictEqual(paths.categoryOf('characters/角色甲/note.png'), 'characters');
    assert.strictEqual(paths.categoryOf('worlds/世界书甲.json'), 'worlds');
    assert.strictEqual(paths.categoryOf('chats/角色甲/x.jsonl'), 'chats');
    assert.strictEqual(paths.categoryOf('group chats/群甲/x.jsonl'), 'chats');
    assert.strictEqual(paths.categoryOf('groups/g1.json'), 'chats');
    assert.strictEqual(paths.categoryOf('settings.json'), 'settings');
    assert.strictEqual(paths.categoryOf('backups/x.zip'), 'other');
    assert.strictEqual(paths.categoryOf(''), 'other');
});

console.log('\n[5] 待扫描目录');

const DIRECTORIES = {
    root: '/data/user',
    characters: '/data/user/characters',
    chats: '/data/user/chats',
    groupChats: '/data/user/group chats',
    groups: '/data/user/groups',
    worlds: '/data/user/worlds',
    backups: '/data/user/backups',
};

test('全选时五个目录都要扫', () => {
    const roots = paths.scanRoots(DIRECTORIES, ALL_SCOPE).map(item => item.prefix);
    assert.deepStrictEqual(roots.sort(), ['characters', 'chats', 'group chats', 'groups', 'worlds']);
});

test('取消全部角色卡后，角色卡与单人聊天都不扫', () => {
    const scope = scopeWith({ characters: { all: false, selected: [] } });
    const roots = paths.scanRoots(DIRECTORIES, scope).map(item => item.prefix);
    assert.ok(!roots.includes('characters'), roots.join(','));
    assert.ok(!roots.includes('chats'), roots.join(','));
    assert.ok(roots.includes('worlds'), roots.join(','));
});

console.log('\n[6] 本地路径解析与越界防护');

test('相对路径能还原成绝对路径', () => {
    assert.strictEqual(
        paths.localAbsPath(DIRECTORIES, 'characters/k7f2q9x1.png'),
        path.resolve('/data/user/characters/k7f2q9x1.png'),
    );
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'settings.json'), path.join('/data/user', 'settings.json'));
});

test('穿目录的路径被拒绝', () => {
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'characters/../../secrets.json'), null);
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'unknown/x.png'), null);
});

console.log('\n[7] 上传 / 下载计划');

const H = name => `hash-${name}`;

function plan(local, remoteIndex, remotePresentKeys, scope = ALL_SCOPE) {
    const remotePresent = Object.fromEntries(
        (remotePresentKeys ?? Object.keys(remoteIndex)).map(key => [key, { size: 1, modified: '' }]),
    );
    return buildPlan({
        local: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, { hash: H(v) }])),
        remoteIndex: Object.fromEntries(Object.entries(remoteIndex).map(([k, v]) => [k, { hash: H(v) }])),
        remotePresent,
        scope,
    });
}

test('两端相同 → 不动', () => {
    const p = plan({ 'worlds/a.json': 'v1' }, { 'worlds/a.json': 'v1' });
    assert.strictEqual(p.unchanged, 1);
    assert.strictEqual(p.upload.length, 0);
    assert.strictEqual(p.download.length, 0);
});

test('只有本机有 → 只出现在上传清单', () => {
    const p = plan({ 'worlds/a.json': 'v1' }, {});
    assert.deepStrictEqual(p.upload.map(i => i.path), ['worlds/a.json']);
    assert.strictEqual(p.download.length, 0);
});

test('只有云端有 → 只出现在下载清单', () => {
    const p = plan({}, { 'worlds/a.json': 'v1' });
    assert.deepStrictEqual(p.download.map(i => i.path), ['worlds/a.json']);
    assert.strictEqual(p.upload.length, 0);
});

test('两端内容不同 → 两个清单里都有，由用户点哪个按钮决定', () => {
    const p = plan({ 'worlds/a.json': 'local' }, { 'worlds/a.json': 'remote' });
    assert.deepStrictEqual(p.upload.map(i => i.path), ['worlds/a.json']);
    assert.deepStrictEqual(p.download.map(i => i.path), ['worlds/a.json']);
    assert.strictEqual(p.unchanged, 0);
});

test('云端有文件但索引没记哈希 → 不静默跳过', () => {
    const p = plan({ 'worlds/a.json': 'v1' }, {}, ['worlds/a.json']);
    assert.strictEqual(p.upload[0].reason, 'remote-unindexed');
    assert.strictEqual(p.download[0].reason, 'remote-unindexed');
});

test('范围外的文件不进任何清单', () => {
    const scope = scopeWith({ worlds: { all: false, selected: [] } });
    const p = plan({ 'worlds/a.json': 'v1', 'characters/m3p8w5.png': 'v1' }, {}, [], scope);
    assert.deepStrictEqual(p.upload.map(i => i.path), ['characters/m3p8w5.png']);
});

test('计划摘要带计数且长列表会截断', () => {
    const many = {};
    for (let i = 0; i < 45; i++) many[`worlds/w${i}.json`] = 'v1';
    const summary = summarizePlan(plan(many, {}));
    assert.strictEqual(summary.counts.upload, 45);
    assert.strictEqual(summary.upload.length, 40);
    assert.strictEqual(summary.truncated, true);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
