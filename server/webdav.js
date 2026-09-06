/**
 * WebDAV 请求、URL 构建、目录遍历及文件读写。
 * cryptoKey 存在时自动加密上传内容、解密下载内容；明文文件保持原样。
 * keycheck.json 通过 RawBuffer 接口明文读写。
 */
const encryption = require('./encryption.js');

function splitRemotePath(remotePath) {
    return String(remotePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => part !== '.' && part !== '..');
}

function splitUrlPath(pathname) {
    return String(pathname || '/')
        .split('/')
        .filter(Boolean)
        .map(decodeSegment);
}

function decodeSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function buildRemoteUrl(config, extraSegments = [], includeRemotePath = true) {
    const target = new URL(config.url);
    const baseSegments = splitUrlPath(target.pathname);
    const segments = includeRemotePath
        ? [...splitRemotePath(config.remotePath), ...extraSegments]
        : extraSegments;
    target.pathname = `/${[...baseSegments, ...segments].map(encodeURIComponent).join('/')}`;
    return target.toString();
}

function authHeaders(config) {
    if (!config.username && !config.password) return {};
    const raw = `${config.username}:${config.password}`;
    return { Authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
}

async function webDavRequest(config, extraSegments, options, expectedStatuses) {
    const url = buildRemoteUrl(config, extraSegments, options.includeRemotePath !== false);
    const response = await fetch(url, {
        method: options.method,
        headers: { ...authHeaders(config), ...(options.headers || {}) },
        body: options.body,
    });
    if (!expectedStatuses.includes(response.status)) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            text = '';
        }
        const detail = text ? `：${text.slice(0, 300)}` : '';
        const error = new Error(`WebDAV ${options.method} 失败 (${response.status})${detail}`);
        error.status = response.status;
        throw error;
    }
    return response;
}

/** 以原始字节读写 keycheck.json。 */
async function getRawBuffer(config, segments) {
    const response = await webDavRequest(config, segments, { method: 'GET' }, [200]);
    return Buffer.from(await response.arrayBuffer());
}

async function putRawBuffer(config, segments, body, contentType = 'application/octet-stream') {
    await webDavRequest(config, segments, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType },
    }, [200, 201, 204]);
}

/** 下载文件；配置了密钥时尝试解密，否则返回原始字节。 */
async function getBuffer(config, segments) {
    const raw = await getRawBuffer(config, segments);
    if (!config.cryptoKey) return raw;
    return encryption.decrypt(raw, config.cryptoKey);
}

async function putBuffer(config, segments, body, contentType = 'application/octet-stream') {
    // 加密内容使用 application/octet-stream 类型。
    const payload = config.cryptoKey ? encryption.encrypt(body, config.cryptoKey) : body;
    const type = config.cryptoKey ? 'application/octet-stream' : contentType;
    await putRawBuffer(config, segments, payload, type);
}

async function remove(config, segments) {
    await webDavRequest(config, segments, { method: 'DELETE' }, [200, 202, 204, 404]);
}

/** 通过 getBuffer 读取并解析 JSON。 */
async function readJson(config, segments) {
    try {
        const text = (await getBuffer(config, segments)).toString('utf8');
        return JSON.parse(text);
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

/** 明文读 JSON。同 getRawBuffer，只给 keycheck.json 用。 */
async function readRawJson(config, segments) {
    try {
        const text = (await getRawBuffer(config, segments)).toString('utf8');
        return JSON.parse(text);
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

/** 明文写 JSON。同上。 */
async function writeRawJson(config, segments, value) {
    await putRawBuffer(
        config,
        segments,
        Buffer.from(JSON.stringify(value, null, 2), 'utf8'),
        'application/json; charset=utf-8',
    );
}

async function writeJson(config, segments, value) {
    await putBuffer(
        config,
        segments,
        Buffer.from(JSON.stringify(value, null, 2), 'utf8'),
        'application/json; charset=utf-8',
    );
}

/** MKCOL 返回 405 时使用 PROPFIND 验证目录是否已存在。 */
async function assertCollectionExists(config, segments) {
    const shown = `/${segments.join('/')}`;
    let response;
    try {
        response = await webDavRequest(config, segments, {
            method: 'PROPFIND',
            includeRemotePath: false,
            headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
            body: PROPFIND_BODY,
        }, [207, 200]);
    } catch (error) {
        const error2 = new Error(
            `无法创建目录「${shown}」（405）。请检查权限，或使用已有共享目录。`,
        );
        error2.status = 405;
        error2.cause = error;
        throw error2;
    }
    return response;
}

/** 建到 remotePath 本身。 */
async function ensureRoot(config) {
    const parts = splitRemotePath(config.remotePath);
    for (let index = 1; index <= parts.length; index++) {
        const slice = parts.slice(0, index);
        const response = await webDavRequest(config, slice, {
            method: 'MKCOL',
            includeRemotePath: false,
        }, [200, 201, 204, 405]);
        if (response.status === 405) await assertCollectionExists(config, slice);
    }
}

/**
 * 在 remotePath 下创建多级目录，并用 created 记录已创建路径。
 * 405 交由 assertCollectionExists 验证；409 作为错误处理。
 */
async function ensureDir(config, segments, created) {
    const base = splitRemotePath(config.remotePath);
    for (let index = 1; index <= segments.length; index++) {
        const slice = segments.slice(0, index);
        const key = slice.join('/');
        if (created.has(key)) continue;
        const full = [...base, ...slice];
        const response = await webDavRequest(config, full, {
            method: 'MKCOL',
            includeRemotePath: false,
        }, [200, 201, 204, 405]);
        if (response.status === 405) await assertCollectionExists(config, full);
        created.add(key);
    }
}

// PROPFIND

const PROPFIND_BODY = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<d:propfind xmlns:d="DAV:">',
    '<d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop>',
    '</d:propfind>',
].join('');

function firstXmlValue(block, tag) {
    const match = block.match(new RegExp(`<[^>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${tag}>`, 'i'));
    return match ? decodeXml(match[1].trim()) : '';
}

function decodeXml(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function hrefSegments(href) {
    let pathname = href;
    try {
        pathname = new URL(href, 'http://placeholder.local').pathname;
    } catch {
        pathname = href;
    }
    return String(pathname).split('/').filter(Boolean).map(decodeSegment);
}

function parsePropfind(xml) {
    const responses = xml.match(/<[^>]*:?response[\s\S]*?<\/[^>]*:?response>/gi) || [];
    const items = [];
    for (const block of responses) {
        const href = firstXmlValue(block, 'href');
        if (!href) continue;
        const segments = hrefSegments(href);
        if (!segments.length) continue;
        items.push({
            name: segments.at(-1),
            depth: segments.length,
            isDir: /collection/i.test(firstXmlValue(block, 'resourcetype') || ''),
            size: Number(firstXmlValue(block, 'getcontentlength') || 0),
            modified: firstXmlValue(block, 'getlastmodified') || '',
        });
    }
    return items;
}

/** 使用 Depth: 1 列出一级目录。 */
async function listDir(config, segments) {
    let response;
    try {
        response = await webDavRequest(config, segments, {
            method: 'PROPFIND',
            headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
            body: PROPFIND_BODY,
        }, [207, 200]);
    } catch (error) {
        if (error.status === 404) return { files: [], dirs: [] };
        throw error;
    }

    const xml = await response.text();
    const selfDepth = splitUrlPath(new URL(buildRemoteUrl(config, segments)).pathname).length;
    const files = [];
    const dirs = [];
    for (const item of parsePropfind(xml)) {
        // 跳过 PROPFIND 返回的当前目录。
        if (item.depth <= selfDepth) continue;
        if (item.isDir) dirs.push(item.name);
        else files.push(item);
    }
    return { files, dirs };
}

/** 递归遍历，产出 { 远端相对路径: {size, modified} }。skipTopLevel 用于跳过元数据目录。 */
async function walk(config, segments, prefix, out, skipTopLevel = []) {
    const { files, dirs } = await listDir(config, segments);
    for (const file of files) {
        out[`${prefix}${file.name}`] = { size: file.size, modified: file.modified };
    }
    for (const dir of dirs) {
        if (!prefix && skipTopLevel.includes(dir)) continue;
        await walk(config, [...segments, dir], `${prefix}${dir}/`, out, skipTopLevel);
    }
}

module.exports = {
    splitRemotePath,
    buildRemoteUrl,
    webDavRequest,
    getBuffer,
    putBuffer,
    getRawBuffer,
    putRawBuffer,
    remove,
    readJson,
    writeJson,
    readRawJson,
    writeRawJson,
    ensureRoot,
    ensureDir,
    listDir,
    walk,
};
