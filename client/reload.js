/**
 * 下载后的热刷新：让新文件立刻出现在酒馆里，不用整页重载。
 *
 * 走的都是酒馆自己的入口，和手动导入是同一条路：
 *   角色卡        getCharacters()
 *   世界书        updateWorldInfoList()
 *   预设 / 主题    getSettings() —— 重拉 /api/settings/get，酒馆据此重建各个下拉框
 *   背景图        getBackgrounds()
 *
 * 只有两样东西没有热加载入口：settings.json（影响面铺满整个界面）和快速回复
 * （QR 扩展的 loadSets 没有导出）。这两样才需要让用户刷新页面。
 */
import { getCharacters, saveSettingsDebounced, getSettings } from '/script.js';
import { updateWorldInfoList } from '/scripts/world-info.js';
import { power_user } from '/scripts/power-user.js';
import { getBackgrounds } from '/scripts/backgrounds.js';

import { notify } from './panel.js';

// ---------------------------------------------------------------------------
// 让刚下载的角色卡排在列表最前面
// ---------------------------------------------------------------------------

const SORT_FIELD = 'date_added';
const SORT_ORDER = 'desc';
const SORT_OPTION_ID = 'stcb-sort-recent';

/**
 * 往酒馆的角色排序下拉框里补一个「最近导入」。
 *
 * 酒馆自带的排序选项里没有一个是按文件落到本机的时间排的 ——
 * 「Newest」用的是 create_date，那是卡里作者自己填的时间，跟什么时候下载的无关。
 * 唯一可用的是 date_added（后端取 png 的 ctime），但它不在下拉框里，
 * 直接改 power_user 会让下拉框变空白、用户也没法切回 A-Z，所以先把选项补上。
 */
export function ensureRecentSortOption() {
    const select = $('#character_sort_order');
    if (!select.length || document.getElementById(SORT_OPTION_ID)) return;

    // 必须用 attr 写 data-*：酒馆的 change 处理器是拿 .data('field') 读的
    select.append($('<option>')
        .attr('id', SORT_OPTION_ID)
        .attr('data-field', SORT_FIELD)
        .attr('data-order', SORT_ORDER)
        .text('最近导入'));

    // 酒馆在页面加载时就按 power_user 选中过一次，那会儿这个选项还不存在，这里补选
    if (power_user.sort_field === SORT_FIELD && power_user.sort_order === SORT_ORDER) {
        $(`#${SORT_OPTION_ID}`).prop('selected', true);
    }
}

/** 把角色列表切成「最近导入」排序，让刚下载的卡出现在第一个。 */
function sortByRecent() {
    power_user.sort_field = SORT_FIELD;
    power_user.sort_order = SORT_ORDER;
    // 必须清掉：上一次若是「收藏」排序会留下 sort_rule='boolean'，
    // 那条分支按真假值比较，套到时间戳上排出来的顺序是错的
    power_user.sort_rule = null;

    ensureRecentSortOption();
    $(`#${SORT_OPTION_ID}`).prop('selected', true);
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// 按下载到的类别刷新
// ---------------------------------------------------------------------------

// /api/settings/get 的响应里带着这些目录的全部内容，重拉一次酒馆就会重建对应的下拉框。
// 不在这张表里的两个：backgrounds 有自己的接口，QuickReplies 由 QR 扩展自己读且没留入口。
const SETTINGS_DIRS = ['OpenAI Settings', 'themes'];

/**
 * 按下载到的类别刷新对应列表。
 * 返回一句给用户看的话；没有任何需要说明的就返回空串。
 */
export async function reloadTouched(touched) {
    if (!touched) return '';

    const dirs = Array.isArray(touched.touchedDirs) ? touched.touchedDirs : [];
    const refreshed = [];

    if (touched.characters > 0) {
        try {
            // 顺序要紧：getCharacters 内部最后会调 printCharacters(true)，
            // 排序必须在那之前设好，否则列表还是按旧规则画的
            sortByRecent();
            await getCharacters();
            refreshed.push('角色列表');
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 刷新角色列表失败：', error);
        }
    }

    if (touched.worlds > 0) {
        try {
            await updateWorldInfoList();
            refreshed.push('世界书列表');
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 刷新世界书列表失败：', error);
        }
    }

    // settings.json 也被覆盖时不热加载 —— 那份设置铺满整个界面，
    // 半热加载只会得到一半新一半旧的状态，不如老实让用户刷新。
    const settingsOverwritten = touched.settings > 0;

    if (!settingsOverwritten && dirs.some(dir => SETTINGS_DIRS.includes(dir))) {
        try {
            await getSettings();
            if (touched.presets > 0) refreshed.push('预设');
            if (touched.themes > 0) refreshed.push('美化');
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 刷新预设与美化失败：', error);
        }
    }

    if (dirs.includes('backgrounds')) {
        try {
            await getBackgrounds();
            refreshed.push('背景图');
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 刷新背景图失败：', error);
        }
    }

    if (refreshed.length) {
        notify('success', `${refreshed.join('、')}已刷新`);
    }

    // 聊天文件不用管：酒馆的「管理聊天文件」是现读的，落盘即可见。

    const stale = [];
    if (settingsOverwritten) stale.push('设置');
    if (dirs.includes('QuickReplies')) stale.push('快速回复');

    return stale.length ? `${stale.join('、')}需要刷新页面才生效。` : '';
}
