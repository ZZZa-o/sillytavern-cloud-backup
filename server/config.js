const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEY = 'webdav_chat_backup_password';
const DIRECTIONS = ['two-way', 'upload-only', 'download-only'];

function readWebDavPassword(directories) {
    const file = path.join(directories.root, 'secrets.json');
    if (!fs.existsSync(file)) return '';
    try {
        const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
        const values = secrets[SECRET_KEY];
        if (!Array.isArray(values) || values.length === 0) return '';
        const active = values.find(item => item && item.active) || values.at(-1);
        return typeof active?.value === 'string' ? active.value : '';
    } catch {
        return '';
    }
}

function normalizeInclude(include = {}) {
    return {
        chats: include.chats !== false,
        groupChats: include.groupChats !== false,
        characters: include.characters !== false,
        worlds: include.worlds !== false,
        settings: include.settings !== false,
    };
}

/** 把请求体里的设置整理成后端各模块统一使用的 config。 */
function resolveConfig(request) {
    const body = request.body?.settings || {};
    const url = String(body.url || '').trim();
    if (!url) {
        throw new Error('请先填写 WebDAV 地址。');
    }
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
        throw new Error('WebDAV 地址格式不正确。');
    }

    const include = normalizeInclude(body.include);
    if (!Object.values(include).some(Boolean)) {
        throw new Error('请至少选择一项备份内容。');
    }

    return {
        url,
        username: String(body.username || '').trim(),
        password: readWebDavPassword(request.user.directories),
        remotePath: String(body.remotePath || '').trim(),
        include,
        direction: DIRECTIONS.includes(body.direction) ? body.direction : 'two-way',
        deviceName: String(body.deviceName || '').trim().slice(0, 40),
        retention: Math.max(1, Math.min(200, Number.parseInt(body.retention, 10) || 10)),
    };
}

module.exports = {
    SECRET_KEY,
    readWebDavPassword,
    normalizeInclude,
    resolveConfig,
};
