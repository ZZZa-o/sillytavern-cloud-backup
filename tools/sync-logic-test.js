/**
 * 同步核心逻辑的单元测试。
 *
 *   node tools/sync-logic-test.js
 *
 * plan.js 与 paths.js 都是纯逻辑、不依赖 fflate，
 * 所以这里不需要指向 SillyTavern 的 node_modules。
 */
const assert = require('node:assert');
const path = require('node:path');

const serverDir = path.join(__dirname, '..', 'server');
const { analyzeJsonl, buildPlan, pruneTombstones } = require(path.join(serverDir, 'plan.js'));
const { safeSegment, safeRelPath, pathAllowed, conflictPathFor } = require(path.join(serverDir, 'paths.js'));

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

function buf(lines) {
    return Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

const ALL = { chats: true, groupChats: true, characters: true, worlds: true, settings: true };

function plan(local, remoteIndex, base, options = {}) {
    const remotePresent = options.remotePresent
        || Object.fromEntries(Object.keys(remoteIndex).map(key => [key, { size: 1, modified: '' }]));
    return buildPlan({
        local,
        remoteIndex,
        remotePresent,
        base,
        tombstones: options.tombstones || {},
        include: options.include || ALL,
    }, options.direction || 'two-way');
}

const H = name => `hash-${name}`;
const entry = name => ({ hash: H(name) });

console.log('\n[1] .jsonl 快进判定');

test('两端完全相同 → same', () => {
    const a = buf([{ m: 'meta' }, { m: 1 }, { m: 2 }]);
    assert.strictEqual(analyzeJsonl(a, a).type, 'same');
});

test('远端多出若干行 → 快进下载', () => {
    const local = buf([{ m: 'meta' }, { m: 1 }]);
    const remote = buf([{ m: 'meta' }, { m: 1 }, { m: 2 }, { m: 3 }]);
    const result = analyzeJsonl(local, remote);
    assert.strictEqual(result.type, 'fast-forward-download');
    assert.strictEqual(result.common, 2);
});

test('本地多出若干行 → 快进上传', () => {
    const local = buf([{ m: 'meta' }, { m: 1 }, { m: 2 }]);
    const remote = buf([{ m: 'meta' }, { m: 1 }]);
    assert.strictEqual(analyzeJsonl(local, remote).type, 'fast-forward-upload');
});

test('两端在同一位置写了不同内容 → 分叉', () => {
    const local = buf([{ m: 'meta' }, { m: 1 }, { m: 'A' }]);
    const remote = buf([{ m: 'meta' }, { m: 1 }, { m: 'B' }]);
    const result = analyzeJsonl(local, remote);
    assert.strictEqual(result.type, 'diverged');
    assert.strictEqual(result.common, 2);
});

test('改写历史消息（swipe）保守判为分叉', () => {
    const local = buf([{ m: 'meta' }, { m: 'edited' }, { m: 2 }]);
    const remote = buf([{ m: 'meta' }, { m: 'original' }, { m: 2 }, { m: 3 }]);
    assert.strictEqual(analyzeJsonl(local, remote).type, 'diverged');
});

test('仅结尾换行不同不算差异', () => {
    const a = Buffer.from('{"a":1}\n{"b":2}\n', 'utf8');
    const b = Buffer.from('{"a":1}\n{"b":2}', 'utf8');
    assert.strictEqual(analyzeJsonl(a, b).type, 'same');
});

console.log('\n[2] 三方比较');

test('两端一致 → 无操作', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.strictEqual(p.unchanged, 1);
    assert.strictEqual(p.upload.length + p.download.length + p.conflict.length, 0);
});

test('本地新增 → 上传', () => {
    const p = plan({ 'chats/A/x.jsonl': entry('v1') }, {}, {});
    assert.deepStrictEqual(p.upload.map(i => i.path), ['chats/A/x.jsonl']);
});

test('远端新增 → 下载', () => {
    const p = plan({}, { 'chats/A/x.jsonl': entry('v1') }, {});
    assert.deepStrictEqual(p.download.map(i => i.path), ['chats/A/x.jsonl']);
});

test('只有本地相对基线变化 → 上传', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v2') },
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.deepStrictEqual(p.upload.map(i => i.path), ['chats/A/x.jsonl']);
    assert.strictEqual(p.conflict.length, 0);
});

test('只有远端相对基线变化 → 下载', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/A/x.jsonl': entry('v2') },
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.deepStrictEqual(p.download.map(i => i.path), ['chats/A/x.jsonl']);
    assert.strictEqual(p.conflict.length, 0);
});

test('两端都相对基线变化 → 冲突', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('local') },
        { 'chats/A/x.jsonl': entry('remote') },
        { 'chats/A/x.jsonl': entry('base') },
    );
    assert.deepStrictEqual(p.conflict.map(i => i.path), ['chats/A/x.jsonl']);
});

test('本地删除且远端未变 → 删除远端', () => {
    const p = plan(
        {},
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.deepStrictEqual(p.deleteRemote.map(i => i.path), ['chats/A/x.jsonl']);
});

test('本地删除但远端已改 → 重新下载而不是删远端', () => {
    const p = plan(
        {},
        { 'chats/A/x.jsonl': entry('v2') },
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.deepStrictEqual(p.download.map(i => i.path), ['chats/A/x.jsonl']);
    assert.strictEqual(p.deleteRemote.length, 0);
});

test('远端删除且本地未变 → 删除本地', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        {},
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.deepStrictEqual(p.deleteLocal.map(i => i.path), ['chats/A/x.jsonl']);
});

test('远端删除但本地已改 → 重新上传，不删本地', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v2') },
        {},
        { 'chats/A/x.jsonl': entry('v1') },
    );
    assert.deepStrictEqual(p.upload.map(i => i.path), ['chats/A/x.jsonl']);
    assert.strictEqual(p.deleteLocal.length, 0);
});

console.log('\n[3] 墓碑：防止删除的文件被另一端推回来');

test('墓碑命中且本地未改 → 删除本地', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        {},
        {},
        { tombstones: { 'chats/A/x.jsonl': { hash: H('v1'), at: new Date().toISOString() } } },
    );
    assert.deepStrictEqual(p.deleteLocal.map(i => i.path), ['chats/A/x.jsonl']);
});

test('有墓碑但本地已改 → 重新上传（用户明确又编辑了）', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v2') },
        {},
        {},
        { tombstones: { 'chats/A/x.jsonl': { hash: H('v1'), at: new Date().toISOString() } } },
    );
    assert.deepStrictEqual(p.upload.map(i => i.path), ['chats/A/x.jsonl']);
});

test('没有基线也没有墓碑的本地文件 → 上传，绝不删除', () => {
    const p = plan({ 'chats/A/x.jsonl': entry('v1') }, {}, {});
    assert.strictEqual(p.deleteLocal.length, 0);
    assert.strictEqual(p.upload.length, 1);
});

test('过期墓碑被清理', () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const result = pruneTombstones({ a: { at: old }, b: { at: fresh } });
    assert.deepStrictEqual(Object.keys(result), ['b']);
});

console.log('\n[4] 同步方向');

test('仅上传：不下载、不删本地', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/B/y.jsonl': entry('v1') },
        {},
        { direction: 'upload-only' },
    );
    assert.strictEqual(p.download.length, 0);
    assert.strictEqual(p.deleteLocal.length, 0);
    assert.strictEqual(p.upload.length, 1);
    assert.strictEqual(p.skipped.length, 1);
});

test('仅下载：不上传、不删远端', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        { 'chats/B/y.jsonl': entry('v1') },
        {},
        { direction: 'download-only' },
    );
    assert.strictEqual(p.upload.length, 0);
    assert.strictEqual(p.deleteRemote.length, 0);
    assert.strictEqual(p.download.length, 1);
});

test('单向模式下冲突带有强制解决标记', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('local') },
        { 'chats/A/x.jsonl': entry('remote') },
        { 'chats/A/x.jsonl': entry('base') },
        { direction: 'upload-only' },
    );
    assert.strictEqual(p.conflict[0].resolution, 'force-upload');
});

console.log('\n[5] 远端索引缺失的兜底');

test('远端有文件但索引无哈希且本地也有 → 判为冲突而不是盲目覆盖', () => {
    const p = plan(
        { 'chats/A/x.jsonl': entry('v1') },
        {},
        {},
        { remotePresent: { 'chats/A/x.jsonl': { size: 1, modified: '' } } },
    );
    assert.deepStrictEqual(p.conflict.map(i => i.path), ['chats/A/x.jsonl']);
});

test('远端有文件但索引无哈希且本地没有 → 直接下载', () => {
    const p = plan(
        {},
        {},
        {},
        { remotePresent: { 'chats/A/x.jsonl': { size: 1, modified: '' } } },
    );
    assert.deepStrictEqual(p.download.map(i => i.path), ['chats/A/x.jsonl']);
});

console.log('\n[6] 范围过滤');

test('未勾选角色卡时不处理 characters/', () => {
    const p = plan(
        { 'characters/a.png': entry('v1'), 'chats/A/x.jsonl': entry('v1') },
        {},
        {},
        { include: { ...ALL, characters: false } },
    );
    assert.deepStrictEqual(p.upload.map(i => i.path), ['chats/A/x.jsonl']);
});

test('settings.json 永不进入同步', () => {
    assert.strictEqual(pathAllowed('settings.json', ALL), false);
});

test('已知前缀之外的路径一律忽略', () => {
    assert.strictEqual(pathAllowed('snapshots/st-webdav-backup-1.zip', ALL), false);
    assert.strictEqual(pathAllowed('.st-sync/index.json', ALL), false);
});

console.log('\n[7] 远端路径安全化');

test('中文角色名原样保留，便于在网盘里辨认', () => {
    assert.strictEqual(safeSegment('赛拉菲娜'), '赛拉菲娜');
});

test('空格与连字符必须保留（酒馆聊天文件名依赖它们）', () => {
    assert.strictEqual(safeSegment('2026-08-01 12h30m.jsonl'), '2026-08-01 12h30m.jsonl');
    assert.strictEqual(safeRelPath('chats/夏尔/2026-08-01 12h30m.jsonl'), 'chats/夏尔/2026-08-01 12h30m.jsonl');
});

test('非法字符被替换并追加哈希以避免撞名', () => {
    const a = safeSegment('a/b');
    const b = safeSegment('a:b');
    assert.ok(!/[\\/:*?"<>|]/.test(a), `仍含非法字符：${a}`);
    assert.notStrictEqual(a, b, '不同原名不能压成同一个目录');
});

test('冲突文件名保留原扩展名', () => {
    const name = conflictPathFor('chats/A/x.jsonl', '笔记本', '20260808-120000');
    assert.ok(name.endsWith('.jsonl'), name);
    assert.ok(name.startsWith('chats/A/x '), name);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
