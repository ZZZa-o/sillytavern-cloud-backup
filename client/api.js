/** 与后端插件通信的唯一入口。 */
import { getRequestHeaders } from '/script.js';

import { characterNames } from './tavern.js';

const API_BASE = '/api/plugins/sillytavern-cloud-backup';

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
 * 带上只有前端知道的东西：avatar 文件名 → 角色名，
 * 用来把云端文件存成看得懂的名字（后端只看得到 avatar 文件名）。
 */
export function apiWithNames(action, payload = {}) {
    return api(action, {
        characterNames: characterNames(),
        ...payload,
    });
}
