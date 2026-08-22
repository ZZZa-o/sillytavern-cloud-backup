/**
 * 角色卡里内嵌的世界书。
 *
 * 为什么要在后端读 png：酒馆开了 `performance.lazyLoadCharacters` 之后，
 * 前端拿到的 characters[] 是 shallow 版本（src/endpoints/characters.js 的 toShallow），
 * 只留下 data.extensions.world，**data.character_book 被整个丢掉**。
 * 前端据此判断"内嵌"会永远得到 false，内嵌的世界书就会重复出现在选择列表里。
 *
 * 所以内嵌与否一律由后端直接解析 png 得出，lazyload 开不开都是同一条路。
 * 谁链接了这本书仍旧由前端算 —— data.extensions.world 在 shallow 里保留着。
 */
const fs = require('node:fs');
const path = require('node:path');

const configStore = require('./config.js');

const CACHE_FILE = 'card-cache.json';

// 读 png 是纯 IO，并发几个能明显快过串行；开太多会顶满文件句柄
const CONCURRENCY = 8;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// PNG 解析
// ---------------------------------------------------------------------------

/**
 * 取出 png 里的全部 tEXt 块，返回 { 小写关键字: 原文 }。
 *
 * PNG 是链式结构：8 字节签名之后，每块 = 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC。
 * 只能从头顺着走，没法从中间切进去，所以这里必须读完整个文件。
 * 损坏或截断的文件在越界时直接停下，返回已经读到的部分。
 */
function extractTextChunks(buffer) {
    const out = {};
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return out;

    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) break;

        if (type === 'tEXt') {
            const data = buffer.subarray(dataStart, dataEnd);
            // tEXt 的数据是「关键字 \0 正文」
            const separator = data.indexOf(0);
            if (separator > 0) {
                const keyword = data.toString('latin1', 0, separator).toLowerCase();
                out[keyword] = data.toString('latin1', separator + 1);
            }
        }

        if (type === 'IEND') break;
        offset = dataEnd + 4;
    }
    return out;
}

/**
 * 一张卡内嵌的世界书叫什么名字；没内嵌返回空串。
 *
 * 名字要与酒馆导入后落到 worlds/ 里的文件名一致，否则对不上号。
 * 酒馆的规则见 public/scripts/world-info.js 的 importEmbeddedWorldInfo：
 * 优先用 character_book.name，为空则退回 `<角色名>'s Lorebook`。
 */
function bookNameOf(buffer) {
    const chunks = extractTextChunks(buffer);
    // ccv3 是 V3 卡，与 chara 同时存在时以它为准（酒馆的读取顺序也是这样）
    const raw = chunks.ccv3 || chunks.chara;
    if (!raw) return '';

    let card;
    try {
        card = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
        return '';
    }

    const book = card?.data?.character_book;
    if (!book || typeof book !== 'object') return '';

    const named = String(book.name || '').trim();
    if (named) return named;

    const character = String(card?.data?.name || card?.name || '').trim();
    return character ? `${character}'s Lorebook` : '';
}

async function readBookName(absPath) {
    try {
        return bookNameOf(await fs.promises.readFile(absPath));
    } catch (error) {
        console.warn(`[SillyTavern Cloud Backup] 读取角色卡失败：${path.basename(absPath)} — ${error.message}`);
        return '';
    }
}

// ---------------------------------------------------------------------------
// 缓存：卡没动过就不重新解析
// ---------------------------------------------------------------------------

function cacheFilePath(directories) {
    return path.join(directories.root, configStore.CONFIG_DIR, CACHE_FILE);
}

function readCache(directories) {
    try {
        const parsed = JSON.parse(fs.readFileSync(cacheFilePath(directories), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeCache(directories, entries) {
    try {
        const file = cacheFilePath(directories);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
    } catch (error) {
        // 缓存丢了只是下次慢一点，不该让备份因此失败
        console.warn('[SillyTavern Cloud Backup] 写入角色卡缓存失败：', error.message);
    }
}

// ---------------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------------

/** 按固定并发把任务跑完，返回与输入等长的结果数组。 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    const run = async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

/**
 * 本机所有角色卡内嵌的世界书名字。
 * 结果用于把这些书从"独立世界书"列表里排除 —— 它们跟着角色卡一起备份，不必单独传一份。
 */
async function embeddedBookNames(directories) {
    const dir = directories?.characters;
    const names = new Set();
    if (!dir || !fs.existsSync(dir)) return names;

    const cache = readCache(directories);
    const next = {};
    let changed = false;

    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = dirents
        .filter(dirent => dirent.isFile() && dirent.name.toLowerCase().endsWith('.png'))
        .map(dirent => dirent.name);

    await mapLimit(files, CONCURRENCY, async (fileName) => {
        const absPath = path.join(dir, fileName);
        let stats;
        try {
            stats = await fs.promises.stat(absPath);
        } catch {
            return;
        }

        const mtime = stats.mtime.toISOString();
        const cached = cache[fileName];
        let book;
        if (cached && cached.size === stats.size && cached.mtime === mtime && typeof cached.book === 'string') {
            book = cached.book;
        } else {
            book = await readBookName(absPath);
            changed = true;
        }

        next[fileName] = { size: stats.size, mtime, book };
        if (book) names.add(book);
    });

    // 卡被删掉时缓存条目也要跟着消失，否则文件只增不减
    if (changed || Object.keys(next).length !== Object.keys(cache).length) {
        writeCache(directories, next);
    }

    return names;
}

module.exports = {
    embeddedBookNames,
    // 纯函数，供单元测试
    extractTextChunks,
    bookNameOf,
};
