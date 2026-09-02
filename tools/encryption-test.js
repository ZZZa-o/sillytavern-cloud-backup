/**
 * 端到端加密的单元测试。
 *
 *   node tools/encryption-test.js
 *
 * 这里验的每一条错了都会毁数据，所以必须由机器跑而不是靠眼睛看：
 *   往返一致   密文解回来必须��原文逐字节相同，二进制（png）也一样
 *   降级读     明文数据走 decrypt 要原样返回，否则手动传上网盘的文件就废了
 *   错口令     必须抛错，且绝不能吐出半截数据
 *   keycheck   口令不对时 ok 为假且 key 为 null —— 调用方靠它拦住下载
 */
const assert = require('node:assert');
const crypto = require('node:crypto');

const encryption = require('../server/encryption.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.error(`  ✗ ${name}\n    ${error.message}`);
    }
}

const PASSPHRASE = 'correct horse battery staple';
const SALT = encryption.newSalt();
const KEY = encryption.deriveKey(PASSPHRASE, SALT);

console.log('\n加解密往返');

test('文本往返后逐字节相同', () => {
    const plain = Buffer.from('角色卡里的人设文本，含中文与 emoji 🐴', 'utf8');
    const back = encryption.decrypt(encryption.encrypt(plain, KEY), KEY);
    assert.ok(back.equals(plain));
});

test('二进制往返后逐字节相同', () => {
    // 拿真实 png 的文件头打底，后面接一段随机数据 —— 角色卡就是这个形状
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        crypto.randomBytes(4096),
    ]);
    const back = encryption.decrypt(encryption.encrypt(png, KEY), KEY);
    assert.ok(back.equals(png));
});

test('空文件也能往返', () => {
    const empty = Buffer.alloc(0);
    const back = encryption.decrypt(encryption.encrypt(empty, KEY), KEY);
    assert.strictEqual(back.length, 0);
});

test('同一份明文两次加密的密文不同（IV 是随机的）', () => {
    const plain = Buffer.from('same input', 'utf8');
    assert.ok(!encryption.encrypt(plain, KEY).equals(encryption.encrypt(plain, KEY)));
});

test('密文里搜不到原文', () => {
    const secret = '这段话绝不该出现在密文里';
    const cipher = encryption.encrypt(Buffer.from(secret, 'utf8'), KEY);
    assert.strictEqual(cipher.toString('utf8').includes(secret), false);
    assert.strictEqual(cipher.toString('latin1').includes(secret), false);
});

console.log('\n降级读：明文原样返回');

test('明文 json 走 decrypt 原样返回', () => {
    const plain = Buffer.from('{"manually":"uploaded"}', 'utf8');
    assert.strictEqual(encryption.isEncrypted(plain), false);
    assert.ok(encryption.decrypt(plain, KEY).equals(plain));
});

test('明文 png 走 decrypt 原样返回', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    assert.ok(encryption.decrypt(png, KEY).equals(png));
});

test('比魔数还短的数据不会被误判', () => {
    assert.strictEqual(encryption.isEncrypted(Buffer.from('ST', 'utf8')), false);
});

test('恰好以魔数开头但长度不足的数据不会被误判', () => {
    assert.strictEqual(encryption.isEncrypted(Buffer.from('STCB1', 'utf8')), false);
});

test('加密后的数据认得出是密文', () => {
    assert.strictEqual(encryption.isEncrypted(encryption.encrypt(Buffer.from('x'), KEY)), true);
});

console.log('\n错口令与损坏');

test('错口令解密抛错，不吐出任何数据', () => {
    const cipher = encryption.encrypt(Buffer.from('机密', 'utf8'), KEY);
    const wrong = encryption.deriveKey('wrong passphrase', SALT);
    assert.throws(() => encryption.decrypt(cipher, wrong), /口令不正确|已损坏/);
});

test('密文被改动一个字节就解不开（GCM 认证生效）', () => {
    const cipher = encryption.encrypt(Buffer.from('完整性', 'utf8'), KEY);
    cipher[cipher.length - 1] ^= 0xff;
    assert.throws(() => encryption.decrypt(cipher, KEY), /口令不正确|已损坏/);
});

test('认证标签被改动也解不开', () => {
    const cipher = encryption.encrypt(Buffer.from('tag', 'utf8'), KEY);
    cipher[18] ^= 0xff; // 落在 tag 区间（5 魔数 + 12 iv 之后）
    assert.throws(() => encryption.decrypt(cipher, KEY), /口令不正确|已损坏/);
});

console.log('\n密钥派生');

test('同口令同 salt 派生出同一把钥匙', () => {
    const a = encryption.deriveKey(PASSPHRASE, SALT);
    const b = encryption.deriveKey(PASSPHRASE, SALT);
    assert.ok(a.equals(b));
    assert.strictEqual(encryption.keyIdOf(a), encryption.keyIdOf(b));
});

test('salt 用 base64 字符串传也得到同一把钥匙（跨设备就靠这个）', () => {
    const fromBuffer = encryption.deriveKey(PASSPHRASE, SALT);
    const fromB64 = encryption.deriveKey(PASSPHRASE, SALT.toString('base64'));
    assert.ok(fromBuffer.equals(fromB64));
});

test('换口令 keyId 就变', () => {
    const other = encryption.deriveKey('another passphrase', SALT);
    assert.notStrictEqual(encryption.keyIdOf(KEY), encryption.keyIdOf(other));
});

test('换 salt keyId 也变', () => {
    const other = encryption.deriveKey(PASSPHRASE, encryption.newSalt());
    assert.notStrictEqual(encryption.keyIdOf(KEY), encryption.keyIdOf(other));
});

test('空口令直接拒绝', () => {
    assert.throws(() => encryption.deriveKey('', SALT), /口令为空/);
});

console.log('\nkeycheck：口令校验');

const created = encryption.createKeycheck(PASSPHRASE);

test('新建的 keycheck 用同一口令验得过', () => {
    const verdict = encryption.verifyKeycheck(created.keycheck, PASSPHRASE);
    assert.strictEqual(verdict.ok, true);
    assert.ok(verdict.key.equals(created.key));
});

test('错口令验不过，且 key 为 null', () => {
    const verdict = encryption.verifyKeycheck(created.keycheck, 'wrong');
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.key, null);
    assert.match(verdict.reason, /口令与云端不符/);
});

test('keycheck 缺失时验不过', () => {
    assert.strictEqual(encryption.verifyKeycheck(null, PASSPHRASE).ok, false);
    assert.strictEqual(encryption.verifyKeycheck({}, PASSPHRASE).ok, false);
});

test('keycheck 的 check 被改坏时验不过', () => {
    const broken = { ...created.keycheck, check: Buffer.from('garbage').toString('base64') };
    assert.strictEqual(encryption.verifyKeycheck(broken, PASSPHRASE).ok, false);
});

test('keycheck 里不含口令明文', () => {
    const dumped = JSON.stringify(created.keycheck);
    assert.strictEqual(dumped.includes(PASSPHRASE), false);
});

test('另一台设备靠 keycheck 里的 salt 就能派生出同一把钥匙', () => {
    // 模拟设备 B：手上只有云端那份 keycheck 和用户输入的口令
    const verdict = encryption.verifyKeycheck(created.keycheck, PASSPHRASE);
    const cipher = encryption.encrypt(Buffer.from('设备 A 传上去的', 'utf8'), created.key);
    assert.strictEqual(encryption.decrypt(cipher, verdict.key).toString('utf8'), '设备 A 传上去的');
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
