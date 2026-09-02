/**
 * 离开页面前"要不要逼酒馆落盘"的判定。
 *
 * 自动上传扫的是磁盘上的 .jsonl，而聊天在酒馆内存里 —— 最后几条消息未必已经写下去。
 * 所以关标签页/切后台时先调一次酒馆自己的 saveChatConditional()，再谈上传。
 *
 * 但这一脚不能乱踩：存错时机会把半截回复写进存档，或者更糟，把 A 角色的内容
 * 写进 B 角色的文件。下面五道门就是干这个的。判定与副作用分开，纯函数好测。
 */

/**
 * @param {{
 *   thisChid?: unknown,
 *   selectedGroup?: unknown,
 *   loadedThisChid?: unknown,
 *   loadedSelectedGroup?: unknown,
 *   chatLoaded?: boolean,
 *   isChatSaving?: boolean,
 *   isStreaming?: boolean,
 * } | null | undefined} state
 * @returns {boolean}
 */
export function shouldFlushChat(state) {
    if (!state || typeof state !== 'object') return false;

    // 酒馆自己正在写盘，再喊一次只会撞上去
    if (state.isChatSaving) return false;

    // 流式生成中：这会儿的最后一条消息是半截的，存下去等于把残句固化进存档
    if (state.isStreaming) return false;

    // 本次会话从没成功加载过聊天。此时内存里是空的，存下去会拿空白覆盖掉真存档
    if (!state.chatLoaded) return false;

    // 连角色和群组都没有，不知道该存去哪儿
    if (!hasEntity(state.thisChid) && !hasEntity(state.selectedGroup)) return false;

    // 加载之后又切过角色/群组：这时存下去会把当前内存内容写进另一个实体的文件
    if (hasLoadedSnapshot(state) && !sameEntity(state)) return false;

    return true;
}

/**
 * 某个事件之后，本次会话算不算"已经加载好聊天了"。
 *
 * 单人聊天：CHAT_CHANGED 之后还会来一发 CHAT_LOADED，以后者为准。
 * 群聊：只发 CHAT_CHANGED，永远等不到 CHAT_LOADED —— 所以群聊必须认 CHAT_CHANGED，
 * 否则群里的自动落盘会被上面第三道门全部挡掉。
 *
 * @param {'loaded' | 'changed'} kind
 * @param {boolean} hasGroup
 * @returns {boolean}
 */
export function chatLoadedAfterEvent(kind, hasGroup) {
    if (kind === 'loaded') return true;
    if (kind === 'changed') return !!hasGroup;
    return false;
}

/**
 * this_chid 为 0 是合法的角色下标（第一张卡）。
 * 写成 if (!thisChid) 会把第一张卡当成"没选角色"，那张卡的聊天就永远不落盘了。
 */
function hasEntity(value) {
    return value !== undefined && value !== null && value !== '';
}

function entityKey(thisChid, selectedGroup) {
    if (hasEntity(selectedGroup)) return `g:${String(selectedGroup)}`;
    if (hasEntity(thisChid)) return `c:${String(thisChid)}`;
    return '';
}

function hasLoadedSnapshot(state) {
    return hasEntity(state.loadedThisChid) || hasEntity(state.loadedSelectedGroup);
}

function sameEntity(state) {
    return entityKey(state.thisChid, state.selectedGroup)
        === entityKey(state.loadedThisChid, state.loadedSelectedGroup);
}
