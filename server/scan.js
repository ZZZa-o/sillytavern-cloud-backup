const fs = require('node:fs');
const path = require('node:path');

const { sha256 } = require('./util.js');
const { syncRoots } = require('./paths.js');

/**
 * 扫描参与同步的本地目录，产出 { 相对路径: {hash, size, mtime} }。
 * hashCache 一般传上次的基线：大小与 mtime 都没变就复用旧哈希，
 * 避免每次同步都把所有聊天读一遍。
 */
async function scanLocal(directories, include, hashCache = {}) {
    const out = {};
    for (const root of syncRoots(directories, include)) {
        await walkLocal(root.dir, root.prefix, out, hashCache);
    }
    return out;
}

async function walkLocal(dir, prefix, out, hashCache) {
    if (!fs.existsSync(dir)) return;
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const full = path.join(dir, dirent.name);
        const rel = `${prefix}/${dirent.name}`;
        if (dirent.isDirectory()) {
            await walkLocal(full, rel, out, hashCache);
            continue;
        }
        if (!dirent.isFile()) continue;
        const stats = await fs.promises.stat(full);
        const mtime = stats.mtime.toISOString();
        const cached = hashCache[rel];
        const hash = (cached && cached.hash && cached.size === stats.size && cached.mtime === mtime)
            ? cached.hash
            : sha256(await fs.promises.readFile(full));
        out[rel] = { hash, size: stats.size, mtime };
    }
}

function statMtime(absPath) {
    try {
        return fs.statSync(absPath).mtime.toISOString();
    } catch {
        return '';
    }
}

module.exports = {
    scanLocal,
    statMtime,
};
