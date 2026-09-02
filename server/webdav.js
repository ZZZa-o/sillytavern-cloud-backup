/**
 * WebDAV 通信原语：URL 构建、请求、PROPFIND 解析、目录遍历、JSON 读写。
 * 上层模块不应直接使用 fetch。
 *
 * 加密就挂在这一层：config.cryptoKey 有值时，putBuffer 加密、getBuffer 解密，
 * 上层（backup.js / cloud.js）一行都不用改，连 index.json 与 lock.json 都顺带
 * 保护上了 —— 索引里列着全部本地路径，本身就值得加密。
 *
 * getBuffer 走「降级读」：只有带魔数的才解密，明文原样返回。这样用户手动传上
 * 网盘的东西不会因为开了加密就读不出来。keycheck.json 是唯一的例外，它必须以
 * 明文读写（要靠它才能拿到 salt），所以单独走 RawBuffer 那对函数。
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

/** 明文读写。只给 keycheck.json 用 —— 它是加密体系的引导文件，不能被加密。 */
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

/**
 * 下载并按需解密。
 *
 * 没配密钥却拿到密文时不硬解也不报错 —— 原样返回让上层去处理，
 * 报错文案由 index.js 的 keycheck 环节统一给出，那里才说得清是怎么回事。
 */
async function getBuffer(config, segments) {
    const raw = await getRawBuffer(config, segments);
    if (!config.cryptoKey) return raw;
    return encryption.decrypt(raw, config.cryptoKey);
}

async function putBuffer(config, segments, body, contentType = 'application/octet-stream') {
    // 加密后就不再是原来的类型了，声称是 json 只会误导网盘的预览器
    const payload = config.cryptoKey ? encryption.encrypt(body, config.cryptoKey) : body;
    const type = config.cryptoKey ? 'application/octet-stream' : contentType;
    await putRawBuffer(config, segments, payload, type);
}

async function remove(config, segments) {
    await webDavRequest(config, segments, { method: 'DELETE' }, [200, 202, 204, 404]);
}

/** 读 JSON。走 getBuffer 而不是直接 fetch，才能一并享受解密与降级读。 */
async function readJson(config, segments, fallback) {
    try {
        const text = (await getBuffer(config, segments)).toString('utf8');
        return text.trim() ? JSON.parse(text) : fallback;
    } catch {
        return fallback;
    }
}

/** 明文读 JSON。同 getRawBuffer，只给 keycheck.json 用。 */
async function readRawJson(config, segments, fallback) {
    try {
        const text = (await getRawBuffer(config, segments)).toString('utf8');
        return text.trim() ? JSON.parse(text) : fallback;
    } catch {
        return fallback;
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

/**
 * MKCOL 回 405 有两种截然不同的含义，必须靠 PROPFIND 分辨：
 *   目录已存在        → 无害，RFC 4918 就是这么规定的（坚果云则直接回 201）
 *   该层根本不让创建  → 致命，但如果放过去，错误会一路拖到 PUT 才以
 *                       「Method Not Allowed」的面目出现，完全看不出真正的原因
 *
 * 后者在 NAS 上很常见：WebDAV 根目录往往是共享文件夹的只读列表，
 * 不能在它下面直接建东西（OPTIONS 的 Allow 头里没有 MKCOL / PUT 就是这个情况）。
 */
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
            `远程路径 ${shown} 不存在，服务器又拒绝创建它（MKCOL 405）。`
            + `WebDAV 根目录通常不允许直接新建文件夹，请把「远程路径」改成以一个已存在的`
            + `共享文件夹开头，例如「共享名/${splitRemotePath(config.remotePath).at(-1) || 'backup'}」。`,
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
 * 在 remotePath 下按需创建多级子目录。created 用于单次备份内去重。
 *
 * 405 交给 assertCollectionExists 分辨是"已存在"还是"不让建"。
 * 409 故意不在成功之列 —— 它表示父集合不存在，把它当成功只会让后续 PUT 莫名其妙地失败。
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
