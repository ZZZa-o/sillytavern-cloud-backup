/** 与后端插件通信的唯一入口。 */
import { getRequestHeaders } from '/script.js';

import { characterNames, embeddedWorldNames } from './tavern.js';

const API_BASE = '/api/plugins/webdav-chat-backup';

export async function api(action, payload = {}) {
    const response = await fetch(`${API_BASE}/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        // 后端插件没加载时酒馆会返回 404 的 HTML，这里把它变成一句人能看懂的话
        data = { error: response.status === 404 ? '后端插件未加载，请重启酒馆。' : text.slice(0, 200) };
    }
    if (!response.ok || data.ok === false) {
        throw new Error(data.error || response.statusText || '请求失败');
    }
    return data;
}

/**
 * 带上只有前端知道的两样东西：
 *   characterNames   avatar 文件名 → 角色名，用来把云端文件存成看得懂的名字
 *   embeddedWorlds   已内嵌在角色卡里的世界书，「全选」时要跳过它们，
 *                    否则面板上明明没列出来，却还是被传了一份
 */
export function apiWithNames(action, payload = {}) {
    return api(action, {
        characterNames: characterNames(),
        embeddedWorlds: embeddedWorldNames(),
        ...payload,
    });
}
