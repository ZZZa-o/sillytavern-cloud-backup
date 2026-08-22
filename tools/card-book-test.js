/**
 * 角色卡 png 解析的单元测试。
 *
 *   node tools/card-book-test.js
 *
 * 测的是「这张卡里内嵌了哪本世界书」这个判断。它必须由后端读 png 得出：
 * 酒馆开了 performance.lazyLoadCharacters 之后，前端拿到的角色数据里
 * data.character_book 被整个丢掉，只靠前端判会把内嵌的书全部误列出来。
 */
const assert = require('node:assert');
const path = require('node:path');
const zlib = require('node:zlib');

const cards = require(path.join(__dirname, '..', 'server', 'cards.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${error.message}`);
    }
}

// ---------------------------------------------------------------------------
// 造一张最小可用的 png：签名 + IHDR + 若干 tEXt + IDAT + IEND
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** tEXt 的数据格式是「关键字 \0 正文」，正文是 latin1。 */
function textChunk(keyword, text) {
    return chunk('tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'latin1'),
    ]));
}

/** 角色卡数据是 base64 过的 UTF-8 JSON，所以中文书名也能原样带回来。 */
function cardChunk(keyword, card) {
    return textChunk(keyword, Buffer.from(JSON.stringify(card), 'utf8').toString('base64'));
}

function makePng(...textChunks) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);   // 宽
    ihdr.writeUInt32BE(1, 4);   // 高
    ihdr[8] = 8;                // 位深
    ihdr[9] = 0;                // 灰度
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdr),
        ...textChunks,
        // 酒馆写卡数据时是插在 IEND 之前的，这里也照这个顺序摆
        chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const withBook = name => ({ name: '角色甲', data: { name: '角色甲', character_book: { name, entries: [] } } });
const withoutBook = { name: '角色乙', data: { name: '角色乙' } };

// ---------------------------------------------------------------------------

console.log('\n[1] tEXt 块解析');

test('取得出关键字与正文', () => {
    const png = makePng(textChunk('chara', 'aGVsbG8='), textChunk('Software', 'SillyTavern'));
    const chunks = cards.extractTextChunks(png);
    assert.strictEqual(chunks.chara, 'aGVsbG8=');
    assert.strictEqual(chunks.software, 'SillyTavern', '关键字统一转小写');
});

test('不是 png 的数据不会解析出东西', () => {
    assert.deepStrictEqual(cards.extractTextChunks(Buffer.from('这不是图片')), {});
    assert.deepStrictEqual(cards.extractTextChunks(Buffer.alloc(0)), {});
});

test('截断的文件读到哪算哪，不抛异常也不死循环', () => {
    const png = makePng(textChunk('chara', 'aGVsbG8='));
    const truncated = png.subarray(0, png.length - 12);
    assert.strictEqual(cards.extractTextChunks(truncated).chara, 'aGVsbG8=');
    // 连块头都不完整时直接收工
    assert.deepStrictEqual(cards.extractTextChunks(png.subarray(0, 20)), {});
});

console.log('\n[2] 内嵌世界书取名');

test('V2 卡（chara）能取到书名', () => {
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('chara', withBook('世界书甲')))), '世界书甲');
});

test('V3 卡（ccv3）能取到书名', () => {
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('ccv3', withBook('世界书乙')))), '世界书乙');
});

test('两个块都在时以 ccv3 为准，与酒馆的读取顺序一致', () => {
    const png = makePng(cardChunk('chara', withBook('旧的')), cardChunk('ccv3', withBook('新的')));
    assert.strictEqual(cards.bookNameOf(png), '新的');
});

test('emoji 与中文书名原样带回来', () => {
    const name = '🪨我心匪石，不可转也。';
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('chara', withBook(name)))), name);
});

test('书名为空时退回「<角色名>\'s Lorebook」，与酒馆导入时的命名一致', () => {
    const card = { name: '角色甲', data: { name: '角色甲', character_book: { entries: [] } } };
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('chara', card))), "角色甲's Lorebook");
});

console.log('\n[3] 没有内嵌世界书的情况');

test('卡里没有 character_book 就返回空串', () => {
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('chara', withoutBook))), '');
});

test('没有卡数据块的普通图片返回空串', () => {
    assert.strictEqual(cards.bookNameOf(makePng(textChunk('Comment', '一张普通图片'))), '');
});

test('卡数据坏了不抛异常，只当作没有内嵌', () => {
    assert.strictEqual(cards.bookNameOf(makePng(textChunk('chara', '这不是合法的 base64 JSON'))), '');
    assert.strictEqual(cards.bookNameOf(makePng(textChunk('chara', ''))), '');
});

test('character_book 不是对象时也不当成内嵌', () => {
    const card = { name: '角色甲', data: { name: '角色甲', character_book: '不是对象' } };
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('chara', card))), '');
});

test('V1 老卡没有 data 层，一样安全返回空串', () => {
    assert.strictEqual(cards.bookNameOf(makePng(cardChunk('chara', { name: '角色丙' }))), '');
});

console.log(failed === 0
    ? `\n✅ 通过 ${passed} 项，失败 0 项\n`
    : `\n❌ 通过 ${passed} 项，失败 ${failed} 项\n`);

process.exit(failed === 0 ? 0 : 1);
