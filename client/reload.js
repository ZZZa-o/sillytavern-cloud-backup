/**
 * 下载后的热刷新：让新文件立刻出现在酒馆里，不用整页重载。
 *
 * 手动导入角色卡 / 世界书时酒馆走的就是这两个函数，这里只是复用它们。
 * settings.json 是唯一必须重载页面的 —— 它在启动时就被读进内存并铺满整个界面，没有热加载入口。
 */
import { getCharacters } from '/script.js';
import { updateWorldInfoList } from '/scripts/world-info.js';

import { notify } from './panel.js';

/**
 * 按下载到的类别刷新对应列表。
 * 返回一句给用户看的话；没有任何需要说明的就返回空串。
 */
export async function reloadTouched(touched) {
    if (!touched) return '';

    const refreshed = [];

    if (touched.characters > 0) {
        try {
            await getCharacters();
            refreshed.push('角色列表');
        } catch (error) {
            console.warn('[WebDAV Chat Backup] 刷新角色列表失败：', error);
        }
    }

    if (touched.worlds > 0) {
        try {
            await updateWorldInfoList();
            refreshed.push('世界书列表');
        } catch (error) {
            console.warn('[WebDAV Chat Backup] 刷新世界书列表失败：', error);
        }
    }

    if (refreshed.length) {
        notify('success', `${refreshed.join('与')}已刷新，无需重载页面`);
    }

    // 聊天文件不用管：酒馆的「管理聊天文件」是现读的，落盘即可见。

    if (touched.settings > 0) {
        notify('warning', '设置已被覆盖，需要刷新页面才会生效');
        return '设置已覆盖，请刷新页面。';
    }

    return '';
}
