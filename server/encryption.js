/**
 * 上传内容的端到端加密。
 *
 * 密文格式（全部为二进制拼接）：
 *
 *   STCB1 (5B 魔数) | iv (12B) | tag (16B) | ciphertext
 *
 * 魔数是整套方案的支点 —— 它让「降级读」成为可能：getBuffer 拿到数据先看头，
 * 有魔数才解密，没有就原样返回。于是用户手动传到网盘上的明文 png / json
 * 仍然能正常下载使用，加密开关也就不会把已有的东西弄成一堆打不开的文件。
 *
 * 密钥派生只跑一次：一轮备份动辄几百个文件，每个都跑一遍 scrypt 会慢到不能用。
 * 主密钥由「口令 + 每个云端仓库一份的固定 salt」派生，之后所有文件复用它，
 * 各自配一个随机 IV。AES-GCM 在同密钥下配随机 96 位 IV，文件数远小于 2^32 时是安全的。
 *
 * salt 存在云端 .st-sync/keycheck.json 里（salt 公开无害）。这也是跨设备的关键：
 * 另一台设备输入同一口令就能派生出同一把密钥，不需要在设备之间搬运任何密钥文件。
 */
const crypto = require('node:crypto');

const MAGIC = Buffer.from('STCB1', 'utf8');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;
const KEY_LEN = 32;
const SALT_LEN = 16;

// scrypt 参数。N=32768 在普通机器上约 100ms 一次 —— 因为只在派生主密钥时跑一次，
// 这个代价完全可以接受，换来的是对着云端密文暴力猜口令变得极慢。
//
// maxmem 必须显式给：Node 默认上限 32MB，而 N=32768,r=8 需要约 128 * N * r = 32MB，
// 卡在边界上会直接抛 "memory limit exceeded"。
const KDF = { N: 32768, r: 8, p: 1 };
const KDF_MAXMEM = 64 * 1024 * 1024;

const CHECK_PLAINTEXT = Buffer.from('stcb-ok', 'utf8');

function newSalt() {
    return crypto.randomBytes(SALT_LEN);
}

/** 口令 + salt → 32 字节主密钥。salt 可以是 Buffer 或 base64 字符串。 */
function deriveKey(passphrase, salt) {
    const text = String(passphrase ?? '');
    if (!text) throw new Error('加密口令为空。');
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'base64');
    if (!saltBuffer.length) throw new Error('加密盐值无效。');
    return crypto.scryptSync(text, saltBuffer, KEY_LEN, { ...KDF, maxmem: KDF_MAXMEM });
}

/**
 * 密钥指纹，写进远端索引用于识别「这批文件是哪把钥匙加的」。
 *
 * 派生自密钥的哈希而不是密钥本身，泄露它不会削弱加密；它只是个标签。
 */
function keyIdOf(key) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function isEncrypted(buffer) {
    return Buffer.isBuffer(buffer)
        && buffer.length >= HEADER_LEN
        && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

function encrypt(buffer, key) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/**
 * 解密。调用方应当先用 isEncrypted 判断 —— 这里再判一次是防御性的，
 * 拿到明文时原样返回而不是抛错，语义上等同于「这份数据没被本插件加密过」。
 */
function decrypt(buffer, key) {
    if (!isEncrypted(buffer)) return buffer;
    const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = buffer.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
    const body = buffer.subarray(HEADER_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
        // GCM 的认证标签在 final() 时校验，密钥不对或密文被改动都在这里抛出。
        // 关键是 update() 的返回值绝不能在 final() 之前交出去 —— 那等于泄露未经认证的数据
        return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
        const error = new Error('解密失败：加密口令不正确，或云端文件已损坏。');
        error.code = 'STCB_DECRYPT_FAILED';
        throw error;
    }
}

// ---------------------------------------------------------------------------
// keycheck：口令校验
//
// 这是整套方案里最要紧的一环。没有它，换设备时口令输错一个字符，「从云端下载」
// 就会把一堆解不开的字节写回角色卡目录，把本地数据毁掉。有了它，口令不对在
// 任何磁盘写入发生之前就会被拦住。
//
// keycheck.json 自己必须是明文的 —— 要靠它才能拿到 salt，加密它就成了鸡生蛋。
// 它只含 salt、KDF 参数、密钥指纹和一小段固定明文的密文，都不泄露口令。
// ---------------------------------------------------------------------------

const KEYCHECK_VERSION = 1;

function buildKeycheck(key, salt) {
    return {
        version: KEYCHECK_VERSION,
        saltB64: Buffer.isBuffer(salt) ? salt.toString('base64') : String(salt),
        kdf: { ...KDF },
        keyId: keyIdOf(key),
        check: encrypt(CHECK_PLAINTEXT, key).toString('base64'),
    };
}

/** 用口令新建一份 keycheck（首次在某个云端目录启用加密时）。 */
function createKeycheck(passphrase) {
    const salt = newSalt();
    const key = deriveKey(passphrase, salt);
    return { key, salt, keycheck: buildKeycheck(key, salt) };
}

/**
 * 拿云端那份 keycheck 验口令。
 *
 * 返回 { ok, key, reason }。ok 为假时 key 必为 null —— 调用方据此中止，
 * 绝不能拿着一把没验过的钥匙去解文件然后往磁盘上写。
 */
function verifyKeycheck(raw, passphrase) {
    if (!raw || typeof raw !== 'object' || !raw.saltB64 || !raw.check) {
        return { ok: false, key: null, reason: '云端的加密校验文件缺失或损坏。' };
    }
    let key;
    try {
        key = deriveKey(passphrase, raw.saltB64);
    } catch (error) {
        return { ok: false, key: null, reason: error.message };
    }
    try {
        const plain = decrypt(Buffer.from(String(raw.check), 'base64'), key);
        if (!plain.equals(CHECK_PLAINTEXT)) {
            return { ok: false, key: null, reason: '云端的加密校验文件内容异常。' };
        }
    } catch {
        return { ok: false, key: null, reason: '加密口令与云端不符。' };
    }
    return { ok: true, key, reason: '' };
}

module.exports = {
    MAGIC,
    KDF,
    KEYCHECK_VERSION,
    newSalt,
    deriveKey,
    keyIdOf,
    isEncrypted,
    encrypt,
    decrypt,
    buildKeycheck,
    createKeycheck,
    verifyKeycheck,
};
