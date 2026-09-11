/**
 * 下载后刷新角色卡、世界书、主题、预设、背景与人设列表。
 * 快速回复和 API 配置通过提示引导用户刷新页面。
 */
import { getCharacters, saveSettingsDebounced, getRequestHeaders } from '/script.js';
import { updateWorldInfoList } from '/scripts/world-info.js';
import { power_user, loadPowerUserSettings, applyPowerUserSettings } from '/scripts/power-user.js';
import { loadOpenAISettings } from '/scripts/openai.js';
import { getBackgrounds } from '/scripts/backgrounds.js';
import { getUserAvatars, setPersonaDescription, user_avatar } from '/scripts/personas.js';

// 让刚下载的角色卡排在列表最前面

const SORT_FIELD = 'date_added';
const SORT_ORDER = 'desc';
const SORT_OPTION_ID = 'stcb-sort-recent';

/** 添加按 date_added（角色卡文件的 ctime）排序的「最近导入」选项。 */
export function ensureRecentSortOption() {
    const select = $('#character_sort_order');
    if (!select.length || document.getElementById(SORT_OPTION_ID)) return;

    // 通过 data-* 属性提供排序字段。
    select.append($('<option>')
        .attr('id', SORT_OPTION_ID)
        .attr('data-field', SORT_FIELD)
        .attr('data-order', SORT_ORDER)
        .text('最近导入'));

    // 根据当前排序设置恢复下拉框选中项。
    if (power_user.sort_field === SORT_FIELD && power_user.sort_order === SORT_ORDER) {
        $(`#${SORT_OPTION_ID}`).prop('selected', true);
    }
}

/** 将角色列表切换为「最近导入」排序。 */
function sortByRecent() {
    power_user.sort_field = SORT_FIELD;
    power_user.sort_order = SORT_ORDER;
    // 清除旧排序规则。
    power_user.sort_rule = null;

    ensureRecentSortOption();
    $(`#${SORT_OPTION_ID}`).prop('selected', true);
    saveSettingsDebounced();
}

// 从 /api/settings/get 读取主题与 OpenAI 预设列表。

/** 读取酒馆设置，调用 loadPowerUserSettings 和 loadOpenAISettings 更新列表。 */
async function reloadSettingsLists(needThemes, needPresets) {
    const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`读取酒馆设置失败：HTTP ${response.status}`);

    const data = await response.json();
    const settings = JSON.parse(data.settings);

    if (needThemes) {
        await loadPowerUserSettings(settings, data);
        applyPowerUserSettings();
        // 列表加载完成后按 value 去重，并恢复选中项。
        dedupeOptions('#themes', power_user.theme);
        dedupeOptions('#movingUIPresets', power_user.movingUIPreset);
    }

    if (needPresets) {
        // 重新填充 OpenAI 预设下拉框。
        loadOpenAISettings(data, settings.oai_settings ?? settings);
    }
}

/** 同 value 的选项保留最后一项，并恢复指定选中值。 */
function dedupeOptions(selector, selectedValue) {
    const select = document.querySelector(selector);
    if (!select) return;

    const seen = new Set();
    for (let i = select.options.length - 1; i >= 0; i--) {
        const option = select.options[i];
        if (seen.has(option.value)) option.remove();
        else seen.add(option.value);
    }
    if (seen.has(selectedValue)) select.value = selectedValue;
}

// 按下载到的类别刷新

/**
 * 按下载结果中的 touched、touchedDirs 和 personaData 刷新对应列表。
 * 返回刷新结果及是否需要刷新页面，由下载操作统一显示反馈。
 */
export async function reloadTouched(result) {
    const { touched, touchedDirs: dirs } = result;
    const refreshed = [];
    const stale = [];

    // 先加载主题与预设，再设置角色排序并刷新角色列表。
    const needThemes = dirs.includes('themes');
    const needPresets = dirs.includes('OpenAI Settings');
    if (needThemes || needPresets) {
        try {
            await reloadSettingsLists(needThemes, needPresets);
            if (needThemes) refreshed.push('美化');
            if (needPresets) refreshed.push('预设');
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 刷新美化与预设失败：', error);
            // 记录刷新失败的类别。
            if (needThemes) stale.push('美化');
            if (needPresets) stale.push('预设');
        }
    }

    if (touched.characters > 0) {
        try {
            // 先设置角色排序，再重新获取并渲染角色列表。
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

    if (touched.personas > 0) {
        try {
            await reloadPersonas(result?.personaData);
            refreshed.push('用户人设');
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 刷新用户人设失败：', error);
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

    // 聊天列表由酒馆的「管理聊天文件」读取。

    if (touched.apiProfiles > 0) stale.push('API 配置');
    if (dirs.includes('QuickReplies')) stale.push('快速回复');

    return {
        message: (refreshed.length ? `${refreshed.join('、')}已刷新。` : '')
            + (stale.length ? `请刷新页面加载${stale.join('、')}。` : ''),
        needsReload: stale.length > 0,
    };
}

/**
 * 将合并后的人设字段写入 power_user，再重绘人设面板。
 * 缺少 data 时仅重绘面板。
 */
async function reloadPersonas(data) {
    if (data && typeof data === 'object') {
        if (data.personas) power_user.personas = data.personas;
        if (data.persona_descriptions) power_user.persona_descriptions = data.persona_descriptions;
        if (data.default_persona !== undefined) power_user.default_persona = data.default_persona;
    }

    await getUserAvatars(true);

    // 同步当前人设的 persona_description* 字段与描述输入框。
    const current = power_user.persona_descriptions?.[user_avatar];
    if (current) {
        power_user.persona_description = current.description ?? '';
        power_user.persona_description_position = current.position ?? power_user.persona_description_position;
        power_user.persona_description_depth = current.depth ?? power_user.persona_description_depth;
        power_user.persona_description_role = current.role ?? power_user.persona_description_role;
        power_user.persona_description_lorebook = current.lorebook ?? '';
        setPersonaDescription();
    }
}
