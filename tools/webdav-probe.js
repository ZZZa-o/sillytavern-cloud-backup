/**
 * 逐步检查 WebDAV 端点、目录创建、上传、回读和清理。
 * 运行：node plugins/sillytavern-cloud-backup/tools/webdav-probe.js
 * 使用插件连接配置，在测试目录创建并删除临时文件；输出中的凭据已打码。
 */
const path = require('node:path');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const config = require(path.join(PLUGIN_DIR, 'server', 'config.js'));
const webdav = require(path.join(PLUGIN_DIR, 'server', 'webdav.js'));


function findUserRoot() {
    const fs = require('node:fs');
    const guesses = [process.argv[2], path.resolve(PLUGIN_DIR, '..', '..')];
    for (const guess of guesses) {
        if (!guess) continue;
        const dataRoot = path.join(guess, 'data');
        if (!fs.existsSync(dataRoot)) continue;
        const handles = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
            .map(d => d.name);
        const handle = handles.includes('default-user') ? 'default-user' : handles[0];
        if (handle) return path.join(dataRoot, handle);
    }
    return '';
}

function line(title) {
    console.log(`\n===== ${title} =====`);
}

function mask(value) {
    const text = String(value ?? '');
    if (!text) return '(空)';
    return `${text.slice(0, 1)}***（长度 ${text.length}）`;
}

function authHeaders(cfg) {
    if (!cfg.username && !cfg.password) return {};
    const raw = `${cfg.username}:${cfg.password}`;
    return { Authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
}

/** 发送请求并返回状态码、响应头和响应体片段，异常转换为结果。 */
async function probe(url, method, { headers = {}, body } = {}) {
    try {
        const response = await fetch(url, { method, headers, body });
        let text = '';
        try {
            text = (await response.text()).replace(/\s+/g, ' ').trim();
        } catch { /* 有些响应没有体 */ }
        return {
            ok: true,
            status: response.status,
            allow: response.headers.get('allow') || '',
            dav: response.headers.get('dav') || '',
            server: response.headers.get('server') || '',
            authenticate: response.headers.get('www-authenticate') || '',
            body: text,
        };
    } catch (error) {
        return { ok: false, error: `${error.message}${error.cause ? ` / ${error.cause.message}` : ''}` };
    }
}

/** 一行结论：状态码 + 判词。 */
function verdict(result, good) {
    if (!result.ok) return `连不上 —— ${result.error}`;
    const flag = good.includes(result.status) ? '' : '  ← 【异常】';
    return `${result.status}${flag}`;
}


(async () => {
    const root = findUserRoot();
    if (!root) {
        console.error('没找到酒馆用户目录。把酒馆根目录当参数传进来：');
        console.error('  node plugins/sillytavern-cloud-backup/tools/webdav-probe.js F:/SillyTavern-Launcher/SillyTavern');
        process.exit(1);
    }

    const cfg = config.readConfig({ root });
    if (!cfg.url) {
        console.error('当前方案没有填 WebDAV 地址。先在面板里保存配置。');
        process.exit(1);
    }

    const target = new URL(cfg.url);
    const auth = authHeaders(cfg);

    line('配置');
    console.log('用户目录   :', root);
    console.log('协议主机   :', `${target.protocol}//${target.hostname}${target.port ? ':' + target.port : ''}`);
    console.log('URL 路径   :', JSON.stringify(target.pathname));
    console.log('remotePath :', JSON.stringify(cfg.remotePath));
    console.log('用户名     :', mask(cfg.username));
    console.log('密码       :', mask(cfg.password));
    console.log('完整目标   :', webdav.buildRemoteUrl(cfg).replace(/\/\/[^@/]*@/, '//***@'));

    // 检查端点支持的 WebDAV 方法。
    line('1. OPTIONS —— 服务器自报支持哪些方法');
    for (const [label, url] of [
        ['URL 根       ', `${target.protocol}//${target.host}/`],
        ['配置的 URL   ', target.toString()],
        ['备份目录     ', webdav.buildRemoteUrl(cfg)],
    ]) {
        const r = await probe(url, 'OPTIONS', { headers: auth });
        console.log(`  ${label} ${verdict(r, [200, 204])}`);
        if (r.ok) {
            console.log(`      DAV    : ${r.dav || '【无 DAV 头 —— 这里不是 WebDAV 端点】'}`);
            console.log(`      Allow  : ${r.allow || '(无)'}`);
            if (r.allow && !/PUT/i.test(r.allow)) console.log('      ← 【Allow 里没有 PUT，服务器就是不让写】');
            if (r.server) console.log(`      Server : ${r.server}`);
            if (r.authenticate) console.log(`      认证   : ${r.authenticate}`);
        }
    }

    // 逐层检查远端路径。
    line('2. PROPFIND 逐层下探 —— 找出哪一层还是 WebDAV');
    const urlParts = target.pathname.split('/').filter(Boolean);
    const remoteParts = webdav.splitRemotePath(cfg.remotePath);
    const chain = [[], ...urlParts.map((_, i) => urlParts.slice(0, i + 1))];
    for (const parts of chain) {
        const url = `${target.protocol}//${target.host}/${parts.map(encodeURIComponent).join('/')}`;
        const r = await probe(url, 'PROPFIND', {
            headers: { ...auth, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
            body: '<?xml version="1.0" encoding="utf-8" ?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
        });
        const shown = `/${parts.join('/')}` || '/';
        console.log(`  ${shown.padEnd(40)} ${verdict(r, [207, 200])}`);
        if (r.ok && r.status !== 207 && r.body) console.log(`      ${r.body.slice(0, 160)}`);
    }

    // 检查 MKCOL 状态，并通过 PROPFIND 验证目录是否存在。
    line('3. MKCOL 建备份目录 —— 405 到底是"已存在"还是"不支持"');
    for (let i = 1; i <= remoteParts.length; i++) {
        const slice = remoteParts.slice(0, i);
        const url = webdav.buildRemoteUrl(cfg, slice, false);
        const mk = await probe(url, 'MKCOL', { headers: auth });
        const pf = await probe(url, 'PROPFIND', { headers: { ...auth, Depth: '0' } });
        console.log(`  ${('/' + slice.join('/')).padEnd(40)} MKCOL ${verdict(mk, [200, 201, 204, 405])}`);
        console.log(`      同一路径 PROPFIND → ${verdict(pf, [207, 200])}`);
        if (mk.ok && mk.status === 405) {
            console.log(pf.ok && pf.status === 207
                ? '      判定：目录确实已存在，405 无害'
                : '      ← 【405 但目录并不存在 —— 服务器根本不支持 MKCOL，插件被骗过去了】');
        }
        if (mk.ok && mk.body) console.log(`      ${mk.body.slice(0, 160)}`);
    }

    // 4. 真正的 PUT
    line('4. PUT 一个临时探测文件 —— 复现那个 405');
    const name = `.probe-${Date.now()}.txt`;
    const payload = Buffer.from('sillytavern-cloud-backup probe\n', 'utf8');
    const fileUrl = webdav.buildRemoteUrl(cfg, [name]);
    const put = await probe(fileUrl, 'PUT', {
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: payload,
    });
    console.log(`  PUT ${name}  → ${verdict(put, [200, 201, 204])}`);
    if (put.ok) {
        if (put.allow) console.log(`      Allow  : ${put.allow}`);
        if (put.body) console.log(`      响应体 : ${put.body.slice(0, 300)}`);
        if (put.status === 405) {
            console.log('      ← 405 常见成因：');
            console.log('        a) 该路径已存在同名【目录】，对目录 PUT 必然 405');
            console.log('        b) 服务端未开写权限，或该共享是只读挂载');
            console.log('        c) URL 指向的不是 WebDAV 端点（看第 1 步有没有 DAV 头）');
        }
        if (put.status === 409) console.log('      ← 409：父目录不存在，说明第 3 步的 MKCOL 其实没建成');
    }

    // 5. 回读并清理
    if (put.ok && [200, 201, 204].includes(put.status)) {
        line('5. GET 回读并删除临时文件');
        const get = await probe(fileUrl, 'GET', { headers: auth });
        console.log(`  GET    → ${verdict(get, [200])}`);
        console.log(`  内容对得上 : ${get.ok && get.body.includes('probe') ? '是' : '【否】'}`);
        const del = await probe(fileUrl, 'DELETE', { headers: auth });
        console.log(`  DELETE → ${verdict(del, [200, 202, 204, 404])}（清理临时文件）`);
    } else {
        line('5. 跳过回读');
        console.log('  PUT 没成功，不需要清理。');
    }

    line('完');
    console.log('把以上输出贴回来即可。用户名与密码已打码。');
})();
