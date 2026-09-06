/** 从角色卡 PNG 解析内嵌世界书，供独立世界书列表过滤。 */
const fs = require('node:fs');
const path = require('node:path');

const configStore = require('./config.js');

const CACHE_FILE = 'card-cache.json';

// 限制角色卡读取并发数。
const CONCURRENCY = 8;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 解析

/**
 * 读取 PNG 的 tEXt 块，返回 { 小写关键字: 原文 }。
 * 跳过 8 字节签名后，按长度、类型、数据和 CRC 顺序遍历；越界时返回已读取部分。
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
 * 返回内嵌世界书名，无内嵌数据时返回空串。
 * 优先 character_book.name，否则使用 <角色名>'s Lorebook。
 */
function bookNameOf(buffer) {
    const chunks = extractTextChunks(buffer);
    // V3 的 ccv3 数据优先于 chara。
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

// 缓存：卡没动过就不重新解析

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
        // 忽略缓存写入失败。
        console.warn('[SillyTavern Cloud Backup] 写入角色卡缓存失败：', error.message);
    }
}

// 对外

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

/** 列出本机角色卡内嵌的世界书名。 */
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

    // 清理已删除角色卡的缓存。
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
