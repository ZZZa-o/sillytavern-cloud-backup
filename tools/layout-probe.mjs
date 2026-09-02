/**
 * 只读探针：量一量云端文件区各元素的真实渲染宽度。
 *
 *   node "C:/Users/JOE/Documents/酒馆webdav插件/tools/layout-probe.mjs"
 *
 * 只读取几何信息，不点任何按钮、不触发任何备份动作。
 */
import { chromium } from 'file:///C:/Users/JOE/Documents/novel-injector/node_modules/playwright-core/index.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', error => console.log('[页面报错]', error.message));
page.on('console', msg => {
    const text = msg.text();
    if (/cloud-backup|stcb|flush-guard|module|import|SyntaxError/i.test(text)) {
        console.log(`[控制台:${msg.type()}]`, text);
    }
});
page.on('requestfailed', request => {
    if (/cloud-backup/.test(request.url())) {
        console.log('[请求失败]', request.url(), request.failure()?.errorText);
    }
});
page.on('response', response => {
    if (/cloud-backup/.test(response.url()) && response.status() >= 400) {
        console.log('[响应异常]', response.status(), response.url());
    }
});
await page.goto('http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' });

// 扩展是异步加载的，等面板挂进 DOM。抽屉默认收起，所以只能等 attached 不能等 visible
try {
    await page.waitForSelector('#stcb-root', { state: 'attached', timeout: 45000 });
} catch {
    const diag = await page.evaluate(async () => {
        const base = '/scripts/extensions/third-party/sillytavern-cloud-backup/client/';
        const tryImport = async name => {
            try {
                await import(base + name);
                return 'ok';
            } catch (error) {
                return String(error);
            }
        };
        return {
            标题: document.title,
            有扩展容器: !!document.querySelector('#extensions_settings2'),
            第三方扩展数: document.querySelectorAll('#extensions_settings2 > *').length,
            'flush-guard.js': await tryImport('flush-guard.js'),
            'settings.js': await tryImport('settings.js'),
            'panel.js': await tryImport('panel.js'),
            'index.js': await tryImport('index.js'),
        };
    });
    console.log(JSON.stringify(diag, null, 2));
    await browser.close();
    process.exit(1);
}

const report = await page.evaluate(() => {
    const root = document.querySelector('#stcb-root');
    if (!root) return { error: '面板未渲染（插件没加载？）' };

    // 只为测量把祖先链摊开：抽屉收起时宽度全是 0。纯视觉改动，不写任何用户数据
    for (let el = root; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).display === 'none') el.style.display = 'block';
    }
    const drawer = root.querySelector('.inline-drawer-content');
    if (drawer) drawer.style.display = 'block';

    const box = el => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
    };

    const section = [...root.querySelectorAll('.stcb-section')]
        .find(s => s.querySelector('.stcb-section-title')?.textContent.includes('云端文件'));
    if (!section) return { error: '找不到云端文件区' };

    const title = section.querySelector('.stcb-section-title');
    const toolbar = section.querySelector('.stcb-cloud-toolbar');
    const groups = [...section.querySelectorAll('.stcb-cloud-actions')];
    const buttons = [...section.querySelectorAll('.stcb-cloud-actions .menu_button')];

    return {
        面板可用宽度: box(section)?.w,
        标题: box(title),
        工具条: box(toolbar),
        第一组: box(groups[0]),
        第二组: box(groups[1]),
        按钮宽度合计: buttons.reduce((sum, b) => sum + b.getBoundingClientRect().width, 0),
        按钮明细: buttons.map(b => ({
            文字: b.textContent.trim(),
            宽: Math.round(b.getBoundingClientRect().width),
            top: Math.round(b.getBoundingClientRect().top),
        })),
        标题与第一组同行: title && groups[0]
            ? Math.abs(title.getBoundingClientRect().top - groups[0].getBoundingClientRect().top) < 8
            : null,
    };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
