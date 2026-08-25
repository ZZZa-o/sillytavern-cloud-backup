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
 * 当前正在聊的角色叫什么。
 * 云端是按角色名存放的，「当前角色」筛选要拿它去匹配远端路径，avatar 文件名对不上。
 */
export function currentCharacterName() {
    const list = characterList();
    const index = Number(this_chid);
    const item = Number.isInteger(index) ? list[index] : null;
    return item ? (item.name || item.avatar) : '';
}

// ---------------------------------------------------------------------------
// 内嵌世界书
// ---------------------------------------------------------------------------

/**
 * 后端解析 png 得出的内嵌世界书名单。
 *
 * 为什么不由前端自己算：酒馆开了 `performance.lazyLoadCharacters` 之后，
 * characters[] 是 shallow 版本，data.character_book 被整个丢掉（见后端 cards.js），
 * 前端怎么判都是"没内嵌"，内嵌的书就会重复出现在选择列表里。
 *
 * 由 actions.js 在启动时和打开范围弹窗前灌进来 —— 这里不直接调 api.js，
 * 否则 api.js ↔ tavern.js 会绕成循环依赖。
 */
let backendEmbedded = new Set();

export function setEmbeddedBooks(list) {
    backendEmbedded = new Set(Array.isArray(list) ? list.map(String) : []);
}

/**
 * 全部内嵌世界书的名字。
 *
 * 后端名单为主；再并上前端自己能看到的那些，用来兜住后端还没应答的头几秒。
 * 没开 lazyload 时前端这份是准的，开了则为空集，并集在两种情况下都不会误判。
 */
function embeddedBookNames() {
    const names = new Set(backendEmbedded);
    for (const item of characterList()) {
        const book = item?.data?.character_book;
        if (!book) continue;
        // 命名规则要与酒馆 importEmbeddedWorldInfo 一致，否则对不上 worlds/ 里的文件
        const named = String(book.name || '').trim() || (item.name ? `${item.name}'s Lorebook` : '');
        if (named) names.add(named);
    }
    return names;
}

/**
 * 哪些世界书已经链接到角色卡上。返回 { 世界书名 → { owner } }。
 *
 * 只管"谁引用了它"，不管"有没有内嵌" —— 引用关系来自 data.extensions.world，
 * 这个字段在 shallow 里保留着，前端算得准。
 */
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

/** 本机 worlds/ 里那些已内嵌在角色卡中、不该单独列出来的世界书。 */
export function embeddedWorldNames() {
    const embedded = embeddedBookNames();
    return worldList().filter(name => embedded.has(name));
}

/**
 * 供范围弹窗渲染的世界书列表：只留独立世界书。
 *
 * 内嵌的直接不出现 —— 数据跟着角色卡走，隐藏是安全的。
 * 只有引用没内嵌的留下来并带一句提示：卡传上去了书没传，换台机器就成了空引用。
 */
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
                note: link ? `已链接「${link.owner}」但卡内无副本，建议勾选` : '',
                warn: true,
            };
        });
}
