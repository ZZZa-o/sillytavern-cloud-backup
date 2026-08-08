const crypto = require('node:crypto');
const path = require('node:path');

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function timestampForFile(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 防止 `..` 之类的路径穿出目标目录。 */
function ensureInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`目标路径越界：${child}`);
    }
}

function randomId(bytes = 3) {
    return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
    sha256,
    timestampForFile,
    ensureInside,
    randomId,
};
