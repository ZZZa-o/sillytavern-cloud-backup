/** 读取酒馆前端的角色卡、世界书和名称映射。 */
import { characters, this_chid } from '/script.js';
import { world_names, world_info } from '/scripts/world-info.js';

function characterList() {
    return Array.isArray(characters) ? characters.filter(item => item?.avatar) : [];
}

function worldList() {
    return Array.isArray(world_names) ? world_names.map(String) : [];
}

/** 去掉扩展名。charLore 用的就是这个形式当键。 */
function stemOf(avatar) {
    return String(avatar || '').replace(/\.[^.]+$/, '');
}

/** 构建 avatar 文件名到角色名的映射。 */
export function characterNames() {
    const map = {};
    for (const item of characterList()) map[item.avatar] = item.name || '';
    return map;
}

/** 供范围弹窗渲染的角色列表。 */
export function characterEntries() {
    return characterList().map(item => ({ value: item.avatar, label: item.name || item.avatar }));
}

export function currentAvatar() {
    const list = characterList();
    const index = Number(this_chid);
    return Number.isInteger(index) && list[index]?.avatar ? list[index].avatar : '';
}

/** 获取当前角色名，用于云端文件筛选。 */
export function currentCharacterName() {
    const list = characterList();
    const index = Number(this_chid);
    const item = Number.isInteger(index) ? list[index] : null;
    return item ? (item.name || item.avatar) : '';
}

// 内嵌世界书

/** 缓存由 actions.js 加载的后端内嵌世界书名单。 */
let backendEmbedded = new Set();

export function setEmbeddedBooks(list) {
    backendEmbedded = new Set(Array.isArray(list) ? list.map(String) : []);
}

/** 合并后端名单与前端角色数据中的内嵌世界书名。 */
function embeddedBookNames() {
    const names = new Set(backendEmbedded);
    for (const item of characterList()) {
        const book = item?.data?.character_book;
        if (!book) continue;
        // 沿用酒馆 importEmbeddedWorldInfo 的命名规则。
        const named = String(book.name || '').trim() || (item.name ? `${item.name}'s Lorebook` : '');
        if (named) names.add(named);
    }
    return names;
}

/** 读取 data.extensions.world 中的世界书引用关系，返回 { 世界书名: { owner } }。 */
export function linkedWorlds() {
    const linked = new Map();
    const lore = Array.isArray(world_info?.charLore) ? world_info.charLore : [];

    const add = (book, owner) => {
        const name = String(book || '').trim();
        if (!name || linked.has(name)) return;
        linked.set(name, { owner });
    };

    for (const item of characterList()) {
        const owner = item.name || item.avatar;
        add(item?.data?.extensions?.world, owner);
        const extra = lore.find(entry => entry?.name === stemOf(item.avatar));
        for (const book of extra?.extraBooks || []) add(book, owner);
    }

    return linked;
}

/** 列出本机 worlds/ 中已内嵌在角色卡里的世界书。 */
export function embeddedWorldNames() {
    const embedded = embeddedBookNames();
    return worldList().filter(name => embedded.has(name));
}

/** 生成独立世界书选项；仅被引用而未内嵌的世界书附带提示。 */
export function worldEntries() {
    const linked = linkedWorlds();
    const embedded = embeddedBookNames();
    return worldList()
        .filter(name => !embedded.has(name))
        .map(name => {
            const link = linked.get(name);
            return {
                value: name,
                label: name,
                note: link ? `「${link.owner}」未内嵌此书，建议勾选` : '',
                warn: true,
            };
        });
}
