/**
 * 判定离开页面前是否可调用 saveChatConditional 保存本地聊天。
 * 检查保存状态、生成状态、聊天加载状态及当前角色或群组。
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

    // 保存进行中时跳过。
    if (state.isChatSaving) return false;

    // 流式生成期间跳过。
    if (state.isStreaming) return false;

    // 聊天尚未加载完成时跳过。
    if (!state.chatLoaded) return false;

    // 未选择角色或群组时跳过。
    if (!hasEntity(state.thisChid) && !hasEntity(state.selectedGroup)) return false;

    // 当前角色或群组须与已加载聊天的对象一致。
    if (hasLoadedSnapshot(state) && !sameEntity(state)) return false;

    return true;
}

/**
 * 判定聊天加载完成：单人聊天使用 CHAT_LOADED，群聊使用 CHAT_CHANGED。
 * @param {'loaded' | 'changed'} kind
 * @param {boolean} hasGroup
 * @returns {boolean}
 */
export function chatLoadedAfterEvent(kind, hasGroup) {
    if (kind === 'loaded') return true;
    if (kind === 'changed') return !!hasGroup;
    return false;
}

/** 角色下标 0 表示第一张卡，是有效选择。 */
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
