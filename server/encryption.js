/**
 * 文件内容的 AES-256-GCM 加密与解密。
 * 密文格式：STCB1（5B 魔数）| IV（12B）| tag（16B）| ciphertext。
 * 每个云端目录使用固定 salt 从口令派生主密钥，每个文件生成随机 IV。
 * salt 与校验信息存于 .st-sync/keycheck.json；无魔数的数据按明文读取。
 */
const crypto = require('node:crypto');

const MAGIC = Buffer.from('STCB1', 'utf8');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;
const KEY_LEN = 32;
const SALT_LEN = 16;

// scrypt 参数：N=32768、r=8、p=1；显式设置内存上限。
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

/** 生成主密钥的哈希指纹，供远端索引标记加密密钥。 */
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

/** 解密带 STCB1 魔数的数据，明文原样返回。 */
function decrypt(buffer, key) {
    if (!isEncrypted(buffer)) return buffer;
    const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = buffer.subarray(MAGIC.length + IV_LEN, HEADER_LEN);
    const body = buffer.subarray(HEADER_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
        // final() 校验 GCM 认证标签，验证成功后返回完整明文。
        return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
        const error = new Error('解密失败：加密口令不正确，或云端文件已损坏。');
        error.code = 'STCB_DECRYPT_FAILED';
        throw error;
    }
}

// 口令校验：keycheck.json 明文保存 salt、KDF 参数、密钥指纹及固定测试数据的密文。

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
 * 用云端 keycheck 验证口令，返回 { ok, key, reason }。
 * 验证失败时 ok 为 false、key 为 null。
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
