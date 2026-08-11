/**
 * 读取酒馆前端的角色卡与世界书状态。
 *
 * 单独成一个模块，是因为 api.js（提交给后端）和 scope.js（渲染选择列表）都要用它，
 * 塞进任何一边都会绕出循环依赖。
 */
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

/**
 * 后端只看得到 avatar 文件名，png 里的角色叫什么只有前端知道 ——
 * 网盘里要按角色名存文件，就得把这张对照表带上。
 */
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

/**
 * 哪些世界书已经链接到角色卡上。返回 { 世界书名 → { owner, embedded } }。
 *
 * embedded 表示那张卡的 png 里内嵌了 character_book。区分这一点很重要：
 *   内嵌了 —— 世界书数据跟着角色卡一起走，从列表里隐藏掉是安全的；
 *   只有引用没内嵌 —— 卡传上去了世界书没传，换台机器就成了空引用，
 *                     所以这种必须留在列表里，并且标出来提醒用户勾上。
 */
export function linkedWorlds() {
    const linked = new Map();
    const lore = Array.isArray(world_info?.charLore) ? world_info.charLore : [];

    const add = (book, owner, embedded) => {
        const name = String(book || '').trim();
        if (!name) return;
        const prev = linked.get(name);
        linked.set(name, {
            owner: prev?.owner || owner,
            // 只要有一张卡内嵌了副本，这本书就算有备份
            embedded: !!prev?.embedded || embedded,
        });
    };

    for (const item of characterList()) {
        const owner = item.name || item.avatar;
        const embedded = !!item?.data?.character_book;
        add(item?.data?.extensions?.world, owner, embedded);
        const extra = lore.find(entry => entry?.name === stemOf(item.avatar));
        for (const book of extra?.extraBooks || []) add(book, owner, embedded);
    }

    return linked;
}

/** 已内嵌在角色卡里、不该单独列出来的世界书。 */
export function embeddedWorldNames() {
    const linked = linkedWorlds();
    return worldList().filter(name => linked.get(name)?.embedded);
}

/**
 * 供范围弹窗渲染的世界书列表：只留独立世界书。
 * 被角色卡内嵌的直接不出现；只有引用没内嵌的留下来，并带一句提示。
 */
export function worldEntries() {
    const linked = linkedWorlds();
    return worldList()
        .filter(name => !linked.get(name)?.embedded)
        .map(name => {
            const link = linked.get(name);
            return {
                value: name,
                label: name,
                note: link ? `已链接「${link.owner}」但卡内无副本，建议勾选` : '',
            };
        });
}
