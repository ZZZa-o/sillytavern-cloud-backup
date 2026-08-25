/**
 * 备份核心逻辑的单元测试。
 *
 *   node tools/backup-logic-test.js
 *
 * 只测纯函数：路径映射、范围判定、上传/下载计划。
 * server/ 下这些模块只依赖 Node 内置模块，不需要指向 SillyTavern 的 node_modules。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require(path.join(__dirname, '..', 'server', 'paths.js'));
const configStore = require(path.join(__dirname, '..', 'server', 'config.js'));
const { buildPlan, summarizePlan, scopeDirStats } = require(path.join(__dirname, '..', 'server', 'backup.js'));

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
    chats: { all: true, selected: [], skip: [] },
    worlds: { all: true, selected: [] },
    presets: {
        openAI_Settings: { all: true, selected: [] },
        quickreplies: { all: true, selected: [] },
    },
    themes: {
        themes: { all: true, selected: [] },
        backgrounds: { all: true, selected: [] },
    },
    personas: { all: true, selected: [] },
    apiProfiles: { all: true, selected: [] },
};

const scopeWith = patch => ({ ...ALL_SCOPE, ...patch });

/** 预设/美化：只改其中一个目录，其余保持全选。 */
const dirScope = (group, key, selection) => scopeWith({
    [group]: { ...ALL_SCOPE[group], [key]: selection },
});

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

console.log('\n[2] 云端七个文件夹');

test('七类各自落到自己的文件夹', () => {
    assert.strictEqual(paths.toRemote('worlds/世界书甲.json', NAMES), '世界书/世界书甲.json');
    assert.strictEqual(paths.toRemote('personas.json', NAMES), '用户人设/personas.json');
    assert.strictEqual(paths.toRemote('api-profiles.json', NAMES), 'API配置/api-profiles.json');
    assert.ok(paths.toRemote('characters/m3p8w5.png', NAMES).startsWith('角色卡/'));
    assert.ok(paths.toRemote('chats/m3p8w5/x.jsonl', NAMES).startsWith('聊天记录/'));
    assert.strictEqual(paths.toRemote('QuickReplies/默认.json', NAMES), '预设/QuickReplies/默认.json');
    assert.strictEqual(paths.toRemote('themes/暗色.json', NAMES), '美化/themes/暗色.json');
});

test('预设与美化的第二层沿用酒馆原目录名，带空格也不转义', () => {
    assert.strictEqual(
        paths.toRemote('OpenAI Settings/我的预设.json', NAMES),
        '预设/OpenAI Settings/我的预设.json');
    assert.strictEqual(
        paths.toRemote('backgrounds/风景 图.jpg', NAMES),
        '美化/backgrounds/风景 图.jpg');
});

test('群聊与群组收在聊天记录下面', () => {
    assert.strictEqual(paths.toRemote('group chats/群甲/x.jsonl', NAMES), '聊天记录/_群聊/群甲/x.jsonl');
    assert.strictEqual(paths.toRemote('groups/g1.json', NAMES), '聊天记录/_群组/g1.json');
});

test('不认识的本地路径不产生远端路径', () => {
    assert.strictEqual(paths.toRemote('backups/x.zip', NAMES), null);
    assert.strictEqual(paths.toRemote('', NAMES), null);
});

test('已经不备份的那些目录不再产生远端路径', () => {
    for (const local of ['instruct/Alpaca.json', 'context/Default.json', 'sysprompt/x.json',
        'reasoning/x.json', 'TextGen Settings/x.json', 'NovelAI Settings/x.json',
        'KoboldAI Settings/x.json', 'movingUI/layout.json']) {
        assert.strictEqual(paths.toRemote(local, NAMES), null, local);
    }
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
        'OpenAI Settings/我的预设.json',
        'QuickReplies/默认.json',
        'themes/暗色.json',
        'backgrounds/风景 图.jpg',
        'personas.json',
        'User Avatars/user-default.png',
        'api-profiles.json',
    ];
    for (const local of samples) {
        const remote = paths.toRemote(local, NAMES);
        assert.strictEqual(paths.toLocal(remote, NAMES), local, `${local} → ${remote} → ${paths.toLocal(remote, NAMES)}`);
    }
});

test('预设与美化的第二层认白名单，串组或穿目录一律拒绝', () => {
    // 白名单本身就是越界防护：不在这一组里的目录名根本还原不出本地路径
    assert.strictEqual(paths.toLocal('预设/../../etc/passwd', NAMES), null);
    assert.strictEqual(paths.toLocal('美化/../personas.json', NAMES), null);
    assert.strictEqual(paths.toLocal('预设/themes/x.json', NAMES), null, '主题不属于预设组');
    assert.strictEqual(paths.toLocal('美化/QuickReplies/x.json', NAMES), null, '快速回复不属于美化组');
    assert.strictEqual(paths.toLocal('预设/没这个目录/x.json', NAMES), null);
    assert.strictEqual(paths.toLocal('预设/instruct/x.json', NAMES), null, '已经不备份的目录也还原不出来');
    assert.strictEqual(paths.toLocal('预设/OpenAI Settings', NAMES), null, '只到目录名不是文件');
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

test('全选时六类都在范围内', () => {
    assert.strictEqual(paths.inScope('characters/k7f2q9x1.png', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/x.jsonl', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('worlds/世界书甲.json', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('OpenAI Settings/我的预设.json', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('themes/暗色.json', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('personas.json', ALL_SCOPE), true);
    assert.strictEqual(paths.inScope('api-profiles.json', ALL_SCOPE), true);
});

test('只选一张角色卡时，别的角色卡与它的聊天都被排除', () => {
    const scope = scopeWith({ characters: { all: false, selected: ['k7f2q9x1.png'] } });
    assert.strictEqual(paths.inScope('characters/k7f2q9x1.png', scope), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/x.jsonl', scope), true);
    assert.strictEqual(paths.inScope('characters/m3p8w5.png', scope), false);
    assert.strictEqual(paths.inScope('chats/m3p8w5/x.jsonl', scope), false);
});

test('聊天记录跟随角色卡：关掉聊天只留角色卡', () => {
    const scope = scopeWith({ chats: { all: false, selected: [], skip: [] } });
    assert.strictEqual(paths.inScope('characters/k7f2q9x1.png', scope), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/x.jsonl', scope), false);
    assert.strictEqual(paths.inScope('group chats/群甲/x.jsonl', scope), false);
});

test('聊天可以逐条勾：只勾中的那条进范围', () => {
    const scope = scopeWith({
        chats: { all: false, selected: ['k7f2q9x1/2026-08-01 12h30m.jsonl'], skip: [] },
    });
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/2026-08-01 12h30m.jsonl', scope), true);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/2026-07-01 09h00m.jsonl', scope), false);
    // 逐条模式下群聊无从跟随，不带
    assert.strictEqual(paths.inScope('group chats/群甲/x.jsonl', scope), false);
});

test('全选态下单独排除某几条，其余照传', () => {
    const scope = scopeWith({
        chats: { all: true, selected: [], skip: ['k7f2q9x1/私密.jsonl'] },
    });
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/私密.jsonl', scope), false);
    assert.strictEqual(paths.inScope('chats/k7f2q9x1/别的.jsonl', scope), true);
});

test('没勾角色卡时，它的聊天一条都不传', () => {
    const scope = scopeWith({
        characters: { all: false, selected: ['k7f2q9x1.png'] },
        chats: { all: false, selected: ['m3p8w5/x.jsonl'], skip: [] },
    });
    // 聊天被显式勾了，但它的角色卡没勾 —— 云端不该出现无主的聊天记录
    assert.strictEqual(paths.inScope('chats/m3p8w5/x.jsonl', scope), false);
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

test('整份 settings.json 不再是备份对象', () => {
    assert.strictEqual(paths.inScope('settings.json', ALL_SCOPE), false);
    assert.strictEqual(paths.toRemote('settings.json', NAMES), null);
    assert.strictEqual(paths.toLocal('设置/settings.json', NAMES), null);
});

test('人设与 API 配置各自按项勾选', () => {
    const only = scopeWith({
        personas: { all: false, selected: ['mine.png'] },
        apiProfiles: { all: false, selected: [] },
    });
    assert.strictEqual(paths.inScope('personas.json', only), true, '选了人设就要传人设数据');
    assert.strictEqual(paths.inScope('User Avatars/mine.png', only), true);
    assert.strictEqual(paths.inScope('User Avatars/别人的.png', only), false);
    assert.strictEqual(paths.inScope('api-profiles.json', only), false, '一个配置档都没勾');
});

test('范围之外的路径一律拒绝', () => {
    assert.strictEqual(paths.inScope('backups/x.zip', ALL_SCOPE), false);
    assert.strictEqual(paths.inScope('.st-sync/index.json', ALL_SCOPE), false);
    assert.strictEqual(paths.inScope('secrets.json', ALL_SCOPE), false);
    // 已经不备份的目录，哪怕全选也进不来
    assert.strictEqual(paths.inScope('instruct/Alpaca.json', ALL_SCOPE), false);
    assert.strictEqual(paths.inScope('movingUI/layout.json', ALL_SCOPE), false);
});

console.log('\n[4a] 预设与美化按文件勾选');

test('预设勾到具体某个文件，同目录里没勾的不进范围', () => {
    const scope = dirScope('presets', 'openAI_Settings', { all: false, selected: ['我的预设.json'] });
    assert.strictEqual(paths.inScope('OpenAI Settings/我的预设.json', scope), true);
    assert.strictEqual(paths.inScope('OpenAI Settings/Default.json', scope), false);
    // 另一个目录不受影响
    assert.strictEqual(paths.inScope('QuickReplies/默认.json', scope), true);
});

test('整目录全选时，目录下新增的文件自动纳入', () => {
    const scope = dirScope('presets', 'openAI_Settings', { all: true, selected: [] });
    assert.strictEqual(paths.inScope('OpenAI Settings/刚存的.json', scope), true);
});

test('主题逐个勾，背景图是整类开关', () => {
    const scope = scopeWith({
        themes: {
            themes: { all: false, selected: ['毛玻璃.json'] },
            backgrounds: { all: false, selected: [] },
        },
    });
    assert.strictEqual(paths.inScope('themes/毛玻璃.json', scope), true);
    assert.strictEqual(paths.inScope('themes/Azure.json', scope), false);
    assert.strictEqual(paths.inScope('backgrounds/风景.jpg', scope), false);
});

test('两组互不干涉：勾了预设不会把美化也带上', () => {
    const scope = scopeWith({
        themes: {
            themes: { all: false, selected: [] },
            backgrounds: { all: false, selected: [] },
        },
    });
    assert.strictEqual(paths.inScope('OpenAI Settings/x.json', scope), true);
    assert.strictEqual(paths.inScope('QuickReplies/默认.json', scope), true);
    assert.strictEqual(paths.inScope('themes/暗色.json', scope), false);
    assert.strictEqual(paths.inScope('backgrounds/风景.jpg', scope), false);
});

console.log('\n[4b] 自带内容：内嵌世界书与酒馆自带背景图');

test('全选背景图时，跳过酒馆自带的那批图', () => {
    const scope = dirScope('themes', 'backgrounds', {
        all: true, selected: [], exclude: ['tavern day.jpg'],
    });
    assert.strictEqual(paths.inScope('backgrounds/tavern day.jpg', scope), false);
    assert.strictEqual(paths.inScope('backgrounds/我拍的.jpg', scope), true);
});

test('没有排除名单时背景图全传', () => {
    const scope = dirScope('themes', 'backgrounds', { all: true, selected: [] });
    assert.strictEqual(paths.inScope('backgrounds/tavern day.jpg', scope), true);
});

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
    assert.strictEqual(paths.categoryOf('personas.json'), 'personas');
    assert.strictEqual(paths.categoryOf('User Avatars/x.png'), 'personas');
    assert.strictEqual(paths.categoryOf('api-profiles.json'), 'apiProfiles');
    assert.strictEqual(paths.categoryOf('settings.json'), 'other');
    assert.strictEqual(paths.categoryOf('OpenAI Settings/x.json'), 'presets');
    assert.strictEqual(paths.categoryOf('QuickReplies/默认.json'), 'presets');
    assert.strictEqual(paths.categoryOf('themes/暗色.json'), 'themes');
    assert.strictEqual(paths.categoryOf('backgrounds/风景.jpg'), 'themes');
    assert.strictEqual(paths.categoryOf('backups/x.zip'), 'other');
    assert.strictEqual(paths.categoryOf('instruct/Alpaca.json'), 'other');
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
    openAI_Settings: '/data/user/OpenAI Settings',
    quickreplies: '/data/user/QuickReplies',
    themes: '/data/user/themes',
    // backgrounds 故意不给：酒馆没建过的目录不该被当成要扫的根
};

test('全选时，夹具提供的目录都要扫', () => {
    const roots = paths.scanRoots(DIRECTORIES, ALL_SCOPE).map(item => item.prefix);
    assert.deepStrictEqual(roots.sort(), [
        'OpenAI Settings', 'QuickReplies', 'characters', 'chats',
        'group chats', 'groups', 'themes', 'worlds',
    ]);
});

test('酒馆没建过的目录不会被当成要扫的根', () => {
    const roots = paths.scanRoots(DIRECTORIES, ALL_SCOPE);
    assert.ok(roots.every(item => !!item.dir), JSON.stringify(roots));
    assert.ok(!roots.some(item => item.prefix === 'backgrounds'));
});

test('只勾了美化时，角色卡与预设目录都不扫', () => {
    const scope = scopeWith({
        characters: { all: false, selected: [] },
        chats: { all: false, selected: [], skip: [] },
        worlds: { all: false, selected: [] },
        presets: {
            openAI_Settings: { all: false, selected: [] },
            quickreplies: { all: false, selected: [] },
        },
    });
    const roots = paths.scanRoots(DIRECTORIES, scope).map(item => item.prefix);
    assert.deepStrictEqual(roots.sort(), ['themes']);
});

test('预设只勾了其中一个目录时，另一个不扫', () => {
    const scope = dirScope('presets', 'quickreplies', { all: false, selected: [] });
    const roots = paths.scanRoots(DIRECTORIES, scope).map(item => item.prefix);
    assert.ok(roots.includes('OpenAI Settings'), roots.join(','));
    assert.ok(!roots.includes('QuickReplies'), roots.join(','));
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
    // 合成文件最终读写的都是 settings.json
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'personas.json'), path.join('/data/user', 'settings.json'));
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'api-profiles.json'), path.join('/data/user', 'settings.json'));
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'settings.json'), null, '整份设置已不在备份范围内');
    assert.strictEqual(
        paths.localAbsPath(DIRECTORIES, 'OpenAI Settings/我的预设.json'),
        path.resolve('/data/user/OpenAI Settings/我的预设.json'),
    );
});

test('穿目录的路径被拒绝', () => {
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'characters/../../secrets.json'), null);
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'unknown/x.png'), null);
    assert.strictEqual(paths.localAbsPath(DIRECTORIES, 'themes/../../../etc/passwd'), null);
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

console.log('\n[8] 全新配置与目录清单');

test('全新安装什么都不勾，一个目录都不用扫', () => {
    const scope = configStore.defaultConfig().scope;
    assert.strictEqual(paths.describeScope(scope), '未选择任何内容');
    for (const local of [
        'characters/k7f2q9x1.png', 'chats/k7f2q9x1/x.jsonl', 'worlds/世界书甲.json',
        'OpenAI Settings/我的预设.json', 'QuickReplies/默认.json',
        'themes/暗色.json', 'backgrounds/风景.jpg',
        'personas.json', 'User Avatars/x.png', 'api-profiles.json',
    ]) {
        assert.strictEqual(paths.inScope(local, scope), false, local);
    }
    assert.deepStrictEqual(paths.scanRoots(DIRECTORIES, scope), []);
});

test('范围文案按目录逐个报，背景图不说"全部"', () => {
    const scope = {
        ...configStore.defaultConfig().scope,
        presets: {
            openAI_Settings: { all: true, selected: [] },
            quickreplies: { all: false, selected: ['默认.json'] },
        },
        themes: {
            themes: { all: false, selected: [] },
            backgrounds: { all: true, selected: [] },
        },
    };
    assert.strictEqual(paths.describeScope(scope), 'OpenAI 预设 全部、快速回复 1 个、背景图');
});

test('目录清单带文件明细，标题去掉 .json 扩展名', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stcb-'));
    try {
        fs.writeFileSync(path.join(dir, '我的预设.json'), 'x');
        const stats = scopeDirStats({ openAI_Settings: dir });

        const preset = stats.presets.find(item => item.key === 'openAI_Settings');
        assert.strictEqual(preset.detail, true);
        assert.strictEqual(preset.files, 1);
        assert.deepStrictEqual(
            preset.entries.map(item => [item.value, item.label]),
            [['我的预设.json', '我的预设']]);

        // 背景图不出明细，只是个整类开关
        const background = stats.themes.find(item => item.key === 'backgrounds');
        assert.strictEqual(background.detail, false);
        assert.strictEqual(background.entries, undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项，失败 ${failed} 项\n`);process.exit(failed === 0 ? 0 : 1);
