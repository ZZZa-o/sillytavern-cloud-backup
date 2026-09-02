/**
 * 现场诊断：在装着酒馆的那台机器上跑，打印插件到底看到了什么。
 *
 *   cd ~/SillyTavern && node plugins/sillytavern-cloud-backup/tools/diagnose.js
 *
 * 专治「面板显示后端已连接，但聊天记录/用户人设/API 配置一片空白」。
 * 手机（Termux）与电脑上的表现不一样时，把两边的输出贴出来一比就知道差在哪。
 *
 * 只读，不改任何文件。密码与密钥一律打码，输出可以直接贴给别人看。
 */
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 定位酒馆
// ---------------------------------------------------------------------------

/** 从本文件往上找，或者用当前目录 —— 装在 plugins/ 下时上溯三层就是酒馆根目录。 */
function findTavernRoot() {
    const guesses = [
        process.argv[2],
        path.resolve(__dirname, '..', '..', '..'),
        process.cwd(),
        path.join(process.cwd(), 'SillyTavern'),
        path.join(process.env.HOME || '', 'SillyTavern'),
    ];
    for (const guess of guesses) {
        if (!guess) continue;
        if (fs.existsSync(path.join(guess, 'server.js')) && fs.existsSync(path.join(guess, 'data'))) {
            return path.resolve(guess);
        }
    }
    return '';
}

/** 酒馆的用户目录模板，取自 src/constants.js。这里只列插件用得到的那些。 */
const TEMPLATE = {
    root: '',
    characters: 'characters',
    chats: 'chats',
    groups: 'groups',
    groupChats: 'group chats',
    worlds: 'worlds',
    avatars: 'User Avatars',
    openAI_Settings: 'OpenAI Settings',
    quickreplies: 'QuickReplies',
    themes: 'themes',
    backgrounds: 'backgrounds',
};

function line(title) {
    console.log(`\n===== ${title} =====`);
}

function mask(value) {
    const text = String(value ?? '');
    if (!text) return '(空)';
    return `${text.slice(0, 2)}***${text.slice(-2)}（长度 ${text.length}）`;
}

/**
 * 加密状态。口令只报长度不报内容 —— 诊断输出是会被贴到 issue 里的东西。
 *
 * 「开了但没口令」要特别点出来：后端会直接拒绝连接（resolveConfig 里拦着），
 * 而用户看到的只是一句连不上，未必想得到是这个原因。
 */
function describeEncryption(encryption) {
    if (!encryption?.enabled) return '未开启';
    if (!encryption.passphrase) return '已开启，但没有口令【连接会被拒绝】';
    return `已开启，口令 ${mask(encryption.passphrase)}`;
}

// ---------------------------------------------------------------------------

const ST_ROOT = findTavernRoot();
if (!ST_ROOT) {
    console.error('没找到酒馆目录。请在酒馆根目录下运行，或者把路径当参数传进来：');
    console.error('  node tools/diagnose.js ~/SillyTavern');
    process.exit(1);
}

line('环境');
console.log('酒馆根目录 :', ST_ROOT);
console.log('Node       :', process.version);
console.log('平台       :', process.platform, process.arch);

// ---- 插件装在哪、什么版本 ----

line('插件安装状态');
const serverDir = path.join(ST_ROOT, 'plugins', 'sillytavern-cloud-backup');
const extDir = path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', 'sillytavern-cloud-backup');

for (const [label, dir, versionFile] of [
    ['服务端插件 plugins/', serverDir, 'package.json'],
    ['前端扩展 third-party/', extDir, 'manifest.json'],
]) {
    if (!fs.existsSync(dir)) {
        console.log(`${label}: 【没装】${dir}`);
        continue;
    }
    let version = '(读不到版本)';
    try {
        version = JSON.parse(fs.readFileSync(path.join(dir, versionFile), 'utf8')).version || version;
    } catch { /* 版本读不到不影响别的判断 */ }
    console.log(`${label}: v${version}  ${dir}`);
}

// 新版才有的文件与接口。缺了就说明装的是旧版，或者只更新了一半
const NEW_MARKERS = [
    ['server/synthetic.js', '用户人设 / API 配置'],
    ['server/backup.js', '备份主体'],
];
for (const [rel, what] of NEW_MARKERS) {
    const file = path.join(serverDir, rel);
    console.log(`  ${rel.padEnd(22)} ${fs.existsSync(file) ? '有' : '【缺失】'}  (${what})`);
}
// 直接在源码里找新版才有的路由与函数名，比看版本号可靠
const indexSrc = (() => {
    try { return fs.readFileSync(path.join(serverDir, 'server', 'index.js'), 'utf8'); } catch { return ''; }
})();
for (const marker of ['chats/list', 'listPersonas', 'listApiProfiles', 'chatCounts']) {
    console.log(`  /status 提供 ${marker.padEnd(16)} ${indexSrc.includes(marker) ? '是' : '【否 —— 装的是旧版服务端】'}`);
}

// ---- 用户目录 ----

line('用户目录');
const dataRoot = path.join(ST_ROOT, 'data');
let handles = [];
try {
    handles = fs.readdirSync(dataRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
        .map(d => d.name);
} catch { /* 下面会报没有用户 */ }
console.log('data/ 下的用户 :', handles.length ? handles.join(', ') : '【一个都没有】');

const handle = handles.includes('default-user') ? 'default-user' : handles[0];
if (!handle) {
    console.error('没有找到任何用户目录，后面的检查没法做了。');
    process.exit(1);
}
console.log('本次检查的用户:', handle);

const directories = {};
for (const key of Object.keys(TEMPLATE)) {
    directories[key] = path.join(dataRoot, handle, TEMPLATE[key]);
}

for (const key of ['root', 'characters', 'chats', 'themes', 'openAI_Settings']) {
    const dir = directories[key];
    let note = '【不存在】';
    try {
        const stats = fs.statSync(dir);
        note = stats.isDirectory() ? '存在' : '存在但不是目录';
        if (fs.lstatSync(dir).isSymbolicLink()) note += '（是符号链接 → ' + fs.readlinkSync(dir) + '）';
    } catch { /* 保持"不存在" */ }
    console.log(`  ${key.padEnd(16)} ${note}  ${dir}`);
}

// ---- readdir 的 d_type 靠不靠得住 ----
// 安卓共享存储（FUSE）不返回 d_type，Dirent 的 isDirectory()/isFile() 会双双为假，
// 用它做判断的代码会把整个目录静默跳过。这是手机与电脑表现不同的头号嫌疑。

line('readdir 类型判定（安卓共享存储的经典坑）');
function checkDirType(dir, label) {
    if (!fs.existsSync(dir)) { console.log(`  ${label}: 目录不存在`); return; }
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
        console.log(`  ${label}: readdir 失败 —— ${error.message}`);
        return;
    }
    let unknown = 0;
    for (const dirent of dirents) {
        if (!dirent.isDirectory() && !dirent.isFile()) unknown++;
    }
    console.log(`  ${label}: 共 ${dirents.length} 项，其中 ${unknown} 项 Dirent 认不出类型`
        + (unknown ? '  ← 【就是这里，d_type 不可用】' : '  (正常)'));
}
checkDirType(directories.chats, 'chats');
checkDirType(directories.characters, 'characters');
checkDirType(directories.themes, 'themes');

// ---- 聊天记录 ----

line('聊天记录');
function statKind(parent, name) {
    try {
        const stats = fs.statSync(path.join(parent, name));
        return stats.isDirectory() ? 'dir' : (stats.isFile() ? 'file' : 'other');
    } catch { return 'gone'; }
}

let chatDirs = [];
let chatTotal = 0;
try {
    for (const dirent of fs.readdirSync(directories.chats, { withFileTypes: true })) {
        if (dirent.name.startsWith('.')) continue;
        if (statKind(directories.chats, dirent.name) !== 'dir') continue;
        let count = 0;
        try {
            count = fs.readdirSync(path.join(directories.chats, dirent.name)).length;
        } catch { /* 读不动就算 0 */ }
        chatDirs.push({ name: dirent.name, count });
        chatTotal += count;
    }
} catch (error) {
    console.log('读 chats 目录失败：', error.message);
}
console.log(`按 stat 判定：${chatDirs.length} 个角色目录，合计 ${chatTotal} 个聊天文件`);
console.log('前 5 个     :', JSON.stringify(chatDirs.slice(0, 5)));

// 角色卡文件名去扩展名，必须与聊天目录名对得上，否则界面上就是"无聊天记录"
line('角色卡 ↔ 聊天目录 名字对照');
let avatars = [];
try {
    avatars = fs.readdirSync(directories.characters).filter(name => /\.(png|webp|json)$/i.test(name));
} catch { /* 下面按 0 处理 */ }
const stemOf = name => String(name).replace(/\.[^.]+$/, '');
const chatDirNames = new Set(chatDirs.map(d => d.name));
const matched = avatars.filter(a => chatDirNames.has(stemOf(a)));
const orphanDirs = chatDirs.filter(d => !avatars.some(a => stemOf(a) === d.name));
console.log(`角色卡 ${avatars.length} 张，其中 ${matched.length} 张能对上聊天目录`);
console.log(`对不上的聊天目录 ${orphanDirs.length} 个:`, JSON.stringify(orphanDirs.slice(0, 5).map(d => d.name)));
if (avatars.length && !matched.length && chatDirs.length) {
    console.log('  ← 【角色卡名与聊天目录名完全对不上，界面必然显示"无聊天记录"】');
}

// ---- settings.json 里的人设与 API 配置 ----

line('settings.json');
const settingsFile = path.join(directories.root, 'settings.json');
console.log('路径 :', settingsFile);
if (!fs.existsSync(settingsFile)) {
    console.log('【文件不存在】—— 用户人设与 API 配置必然都是空的');
} else {
    const bytes = fs.statSync(settingsFile).size;
    console.log('大小 :', bytes, '字节');
    let settings = null;
    try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        console.log('解析 : 成功');
    } catch (error) {
        console.log('解析 : 【失败】', error.message, ' ← 人设与 API 配置会静默变成空列表');
    }
    if (settings) {
        const personas = settings.power_user?.personas;
        console.log('power_user.personas               :',
            personas && typeof personas === 'object'
                ? `${Object.keys(personas).length} 个`
                : `【没有这个字段】(power_user ${settings.power_user ? '存在' : '也不存在'})`);
        const profiles = settings.extension_settings?.connectionManager?.profiles;
        console.log('connectionManager.profiles        :',
            Array.isArray(profiles)
                ? `${profiles.length} 个`
                : `【没有这个字段】(extension_settings ${settings.extension_settings ? '存在' : '也不存在'})`);
    }
}

// ---- 插件自己的配置 ----

line('插件配置 config.json');
const configFile = path.join(directories.root, '.sillytavern-cloud-backup', 'config.json');
if (!fs.existsSync(configFile)) {
    console.log('还没保存过配置：', configFile);
} else {
    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));

        // 连接信息按方案分组存。老配置还摊在顶层，当成一条无名方案照样列出来
        const profiles = Array.isArray(config.profiles) && config.profiles.length
            ? config.profiles
            : [{ id: '(旧格式)', name: '(顶层)', ...config }];
        console.log(`方案        : ${profiles.length} 个，当前 ${config.activeProfileId || '(未记录)'}`);
        for (const profile of profiles) {
            const active = profile.id === config.activeProfileId ? ' ←当前' : '';
            console.log(`  [${profile.id}] ${profile.name || '(无名)'}${active}`);
            console.log('    地址    :', profile.url || '(空)');
            console.log('    用户名  :', profile.username ? mask(profile.username) : '(空)');
            console.log('    密码    :', profile.password ? mask(profile.password) : '(空)');
            console.log('    远端目录:', profile.remotePath || '(空)');
            console.log('    加密    :', describeEncryption(profile.encryption));
            console.log('    上次备份:', profile.lastBackupAt || '(无)');
        }

        console.log('自动上传间隔:', config.auto?.intervalMinutes !== undefined
            ? `${config.auto.intervalMinutes} 分钟`
            : (config.auto?.intervalHours !== undefined
                ? `${config.auto.intervalHours} 小时【旧字段，后端会折算成分钟】`
                : '(未记录)'));
        console.log('scope 各类键:', Object.keys(config.scope || {}).join(', '));
        const shape = key => JSON.stringify(config.scope?.[key]);
        console.log('  chats     :', shape('chats'));
        console.log('  personas  :', shape('personas'));
        console.log('  apiProfiles:', shape('apiProfiles'));
        if (config.scope && !('personas' in config.scope)) {
            console.log('  ← 【这是旧版格式的配置，说明保存它的那个后端是旧版】');
        }
    } catch (error) {
        console.log('读取失败：', error.message);
    }
}

// ---- 直接调插件自己的函数 ----

line('直接调用插件的服务端函数');
try {
    const synthetic = require(path.join(serverDir, 'server', 'synthetic.js'));
    const backup = require(path.join(serverDir, 'server', 'backup.js'));

    const personas = synthetic.listPersonas(directories);
    console.log(`listPersonas()    → ${personas.length} 个`, JSON.stringify(personas.slice(0, 3)));

    const profiles = synthetic.listApiProfiles(directories);
    console.log(`listApiProfiles() → ${profiles.length} 个`,
        JSON.stringify(profiles.slice(0, 3).map(p => ({ label: p.label, hasSecret: p.hasSecret }))));

    const counts = backup.chatCounts(directories);
    const keys = Object.keys(counts);
    const total = keys.reduce((sum, key) => sum + counts[key].files, 0);
    console.log(`chatCounts()      → ${keys.length} 个角色目录，合计 ${total} 个聊天文件`);
    console.log('  前 3 个:', JSON.stringify(keys.slice(0, 3).map(k => `${k}:${counts[k].files}`)));
    if (chatDirs.length && !keys.length) {
        console.log('  ← 【磁盘上明明有聊天目录，chatCounts 却一个都没数到】');
    }

    const dirs = backup.scopeDirStats(directories);
    console.log('scopeDirStats()   → 预设',
        JSON.stringify(dirs.presets.map(d => `${d.key}:${d.files}`)),
        '美化', JSON.stringify(dirs.themes.map(d => `${d.key}:${d.files}`)));
} catch (error) {
    console.log('【调用失败】', error.message);
    console.log(error.stack);
}

line('完');
console.log('把以上全部输出贴回来即可。密码与密钥已打码。');
