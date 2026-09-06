/** 按文件名识别 default/content/ 中的酒馆自带背景图。 */
const fs = require('node:fs');
const path = require('node:path');

/** 查找酒馆源码根目录：优先 process.cwd()，其次使用插件所在目录的上级路径。 */
function serverRoots() {
    return [process.cwd(), path.resolve(__dirname, '..', '..', '..')];
}

/** 自带内容的某个子目录，找不到返回空串。 */
function builtinDir(name) {
    for (const root of serverRoots()) {
        const dir = path.join(root, 'default', 'content', name);
        try {
            if (fs.statSync(dir).isDirectory()) return dir;
        } catch {
            // 换下一个候选
        }
    }
    return '';
}

let backgroundCache = null;

/** 读取并缓存自带背景图文件名；找不到目录时返回空集。 */
function builtinBackgrounds() {
    if (backgroundCache) return backgroundCache;

    const dir = builtinDir('backgrounds');
    let names = [];
    if (dir) {
        try {
            names = fs.readdirSync(dir, { withFileTypes: true })
                .filter(dirent => dirent.isFile() && !dirent.name.startsWith('.'))
                .map(dirent => dirent.name);
        } catch (error) {
            console.warn('[SillyTavern Cloud Backup] 读取自带背景图清单失败：', error.message);
        }
    }

    backgroundCache = new Set(names);
    return backgroundCache;
}

module.exports = {
    builtinBackgrounds,
};
