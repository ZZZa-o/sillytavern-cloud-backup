/**
 * 离开页面前保存条件的单元测试。
 * 运行：node tools/flush-guard-test.mjs
 */
import assert from 'node:assert';
import { shouldFlushChat, chatLoadedAfterEvent } from '../client/flush-guard.js';

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

/** 各用例共用的有效聊天状态。 */
function okState(overrides = {}) {
    return {
        thisChid: 3,
        selectedGroup: null,
        loadedThisChid: 3,
        loadedSelectedGroup: null,
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
        ...overrides,
    };
}

console.log('\n落盘守卫');

test('一切正常时放行', () => {
    assert.strictEqual(shouldFlushChat(okState()), true);
});

test('酒馆正在写盘时不落盘', () => {
    assert.strictEqual(shouldFlushChat(okState({ isChatSaving: true })), false);
});

test('流式生成期间跳过保存', () => {
    assert.strictEqual(shouldFlushChat(okState({ isStreaming: true })), false);
});

test('聊天尚未加载时跳过保存', () => {
    assert.strictEqual(shouldFlushChat(okState({ chatLoaded: false })), false);
});

test('既没角色也没群组时不落盘', () => {
    assert.strictEqual(
        shouldFlushChat(okState({ thisChid: null, selectedGroup: null, loadedThisChid: null })),
        false,
    );
});

test('this_chid 为 0 是合法角色下标，第一张卡照样落盘', () => {
    assert.strictEqual(
        shouldFlushChat(okState({ thisChid: 0, loadedThisChid: 0 })),
        true,
    );
});

test('加载后切换角色时跳过保存', () => {
    assert.strictEqual(
        shouldFlushChat(okState({ thisChid: 5, loadedThisChid: 3 })),
        false,
    );
});

test('群聊：当前群组与加载时一致，放行', () => {
    assert.strictEqual(
        shouldFlushChat(okState({
            thisChid: null, selectedGroup: 'g1',
            loadedThisChid: null, loadedSelectedGroup: 'g1',
        })),
        true,
    );
});

test('从角色切到群组不落盘', () => {
    assert.strictEqual(
        shouldFlushChat(okState({ selectedGroup: 'g1', loadedSelectedGroup: null })),
        false,
    );
});

test('没有加载快照时不拦（刚绑好事件还没记下实体）', () => {
    assert.strictEqual(
        shouldFlushChat(okState({ loadedThisChid: null, loadedSelectedGroup: null })),
        true,
    );
});

test('传进来的不是对象一律不落盘', () => {
    assert.strictEqual(shouldFlushChat(null), false);
    assert.strictEqual(shouldFlushChat(undefined), false);
    assert.strictEqual(shouldFlushChat('yes'), false);
});

console.log('\n加载判定');

test('CHAT_LOADED 一律算加载完成', () => {
    assert.strictEqual(chatLoadedAfterEvent('loaded', false), true);
    assert.strictEqual(chatLoadedAfterEvent('loaded', true), true);
});

test('群聊收到 CHAT_CHANGED 时标记加载完成', () => {
    assert.strictEqual(chatLoadedAfterEvent('changed', true), true);
});

test('单人聊天的 CHAT_CHANGED 不算，要等后面那发 CHAT_LOADED', () => {
    assert.strictEqual(chatLoadedAfterEvent('changed', false), false);
});

test('认不出的事件一律不算', () => {
    assert.strictEqual(chatLoadedAfterEvent('whatever', true), false);
});

console.log(`\n${failed ? '❌' : '✅'} 通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
