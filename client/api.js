/** 调用服务端插件接口。 */
import { getRequestHeaders } from '/script.js';

import { characterNames } from './tavern.js';

const API_BASE = '/api/plugins/sillytavern-cloud-backup';

export async function api(action, payload = {}) {
    const response = await fetch(`${API_BASE}/${action}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    if (response.status === 404) throw new Error('后端插件未加载，请重启酒馆。');
    const data = await response.json();
    if (!response.ok || data.ok === false) {
        throw new Error(data.error);
    }
    return data;
}

/** 请求中附带 avatar 文件名到角色名的映射。 */
export function apiWithNames(action, payload = {}) {
    return api(action, {
        characterNames: characterNames(),
        ...payload,
    });
}
