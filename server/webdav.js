/**
 * WebDAV 通信原语：URL 构建、请求、PROPFIND 解析、目录遍历、JSON 读写。
 * 上层模块不应直接使用 fetch。
 */

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

async function getBuffer(config, segments) {
    const response = await webDavRequest(config, segments, { method: 'GET' }, [200]);
    return Buffer.from(await response.arrayBuffer());
}

async function putBuffer(config, segments, body, contentType = 'application/octet-stream') {
    await webDavRequest(config, segments, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType },
    }, [200, 201, 204]);
}

async function remove(config, segments) {
    await webDavRequest(config, segments, { method: 'DELETE' }, [200, 202, 204, 404]);
}

async function readJson(config, segments, fallback) {
    try {
        const response = await webDavRequest(config, segments, { method: 'GET' }, [200]);
        const text = await response.text();
        return text.trim() ? JSON.parse(text) : fallback;
    } catch {
        return fallback;
    }
}

async function writeJson(config, segments, value) {
    await putBuffer(
        config,
        segments,
        Buffer.from(JSON.stringify(value, null, 2), 'utf8'),
        'application/json; charset=utf-8',
    );
}

/** 建到 remotePath 本身。 */
async function ensureRoot(config) {
    const parts = splitRemotePath(config.remotePath);
    for (let index = 1; index <= parts.length; index++) {
        await webDavRequest(config, parts.slice(0, index), {
            method: 'MKCOL',
            includeRemotePath: false,
        }, [200, 201, 204, 405]);
    }
}

/**
 * 在 remotePath 下按需创建多级子目录。created 用于单次备份内去重。
 *
 * 405 是"已存在"（坚果云对已存在的目录直接回 201，也一并接受）。
 * 409 故意不在成功之列 —— 它表示父集合不存在，把它当成功只会让后续 PUT 莫名其妙地失败。
 */
async function ensureDir(config, segments, created) {
    const base = splitRemotePath(config.remotePath);
    for (let index = 1; index <= segments.length; index++) {
        const slice = segments.slice(0, index);
        const key = slice.join('/');
        if (created.has(key)) continue;
        await webDavRequest(config, [...base, ...slice], {
            method: 'MKCOL',
            includeRemotePath: false,
        }, [200, 201, 204, 405]);
        created.add(key);
    }
}

// --- PROPFIND -------------------------------------------------------------

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

/**
 * 列出远端一级目录。
 * 坚果云等服务不支持 Depth: infinity，所以只用 Depth: 1 逐层递归。
 */
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
        // Depth:1 会把被请求的目录自身也返回，按路径深度跳过
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
    remove,
    readJson,
    writeJson,
    ensureRoot,
    ensureDir,
    listDir,
    walk,
};
