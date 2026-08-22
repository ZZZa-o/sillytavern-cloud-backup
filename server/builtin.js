/**
 * 认出「酒馆自带的内容」。目前只需要背景图。
 *
 * 酒馆首次创建用户目录时，会把 default/content/ 下的默认内容整份复制过去
 * （见酒馆的 content-manager.js）。所以用户的 backgrounds/ 里躺着的那二十来张
 * 风景图并不是他自己传的，全量备份时把它们推上网盘纯属浪费流量与空间 ——
 * 换台机器装好酒馆，这些图本来就在。
 *
 * 判定依据是文件名：复制过去的就是同名文件，没有改名的余地。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 酒馆源码根目录。
 *
 * 首选 process.cwd()：酒馆的 server.js 启动时就 chdir 到了源码目录。
 * 退路是从本文件往上数三层 —— 插件装在 <酒馆>/plugins/sillytavern-cloud-backup/server/。
 * Docker 里两条路径都指向容器内的 /home/node/app，同样成立。
 */
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

/**
 * 酒馆自带背景图的文件名集合。
 *
 * 结果缓存到进程退出：这批文件跟着酒馆版本走，运行期间不会变。
 * 找不到 default/content/ 时返回空集，等于不排除任何图 —— 宁可多传，不能漏传。
 */
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
