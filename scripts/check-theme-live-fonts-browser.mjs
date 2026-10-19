// Opt-in real-font visual QA. Synthetic UI only: never opens ST or reads user data.
// Usage: node scripts/check-theme-live-fonts-browser.mjs --live-fonts [--dark]
// The only outbound requests allowed are GET CSS/fonts within the two approved
// ZeoSeven directories. Redirects are not followed. No fonts are saved to disk.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--live-fonts')) {
    console.log('Skipped: pass --live-fonts to allow the two approved font directories in an isolated QA browser.');
    process.exit(0);
}

const TOTAL_MS = 90000, FONT_MS = 20000;
const mode = process.argv.includes('--dark') ? 'dark' : 'light';
const qa = new URL('../dist/local-qa/theme-live-fonts-476/', import.meta.url);
const families = ['classic', 'editorial', 'glass'];
const names = { classic: '经典', editorial: '纸间', glass: '极简' };
const expectedFonts = { editorial: 'KingHwaOldSong', glass: 'Sarasa Gothic SC' };
const ids = ['heading', 'card-title', 'prose', 'label', 'button', 'input', 'chinese-probe'];
const checks = [], errors = [], blocked = [], network = [], samples = [], warnings = [], screenshots = [];
const report = { scope: 'isolated synthetic theme fixture; no ST, accounts or user data', mode,
    limits: { totalMs: TOTAL_MS, perFontMs: FONT_MS }, baseline: 'installed Microsoft YaHei / system sans',
    visualReviewRequired: true, checks, errors, blocked, network, samples, warnings, screenshots };
let browser, context, page, timedOut = false, closing = false;
const started = Date.now();
const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), ...(detail === null ? {} : { detail }) });
const normalized = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const approvedFont = url => url.origin === 'https://fontsapi.zeoseven.com'
    && /^\/(?:161|309)\/main\/[^?#]+\.(?:css|woff2?|ttf|otf)$/i.test(url.pathname);
const deadline = setTimeout(() => {
    timedOut = true; closing = true;
    errors.push('Total 90-second QA deadline exceeded.');
    void browser?.close();
}, TOTAL_MS);

const html = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--mainFontFamily:"Microsoft YaHei",system-ui,sans-serif;--qm-interface-font:var(--mainFontFamily)}
  body{margin:0;font-family:var(--mainFontFamily);background:#e8e8e8}
  button,input,textarea,select{font-family:var(--mainFontFamily)}
</style><link rel="stylesheet" href="/style.css">
<style>
  /* Fixture geometry only; typography, controls, card material and colors are production CSS. */
  #story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}
  #story-director-modal>.sd-window{position:relative!important;inset:auto!important;transform:none!important;margin:0 auto!important;width:100%!important;max-width:1024px!important;height:100dvh!important;max-height:none!important}
  .fixture-form{display:grid;gap:10px;margin-top:18px}
  .fixture-form input{width:100%;box-sizing:border-box}
  .fixture-form button{justify-self:start}
  .fixture-footer{margin-top:22px}
</style></head><body>
<main id="story-director-modal" class="open sd-theme-${mode}">
  <section class="sd-window">
    <header class="sd-header"><div class="sd-titlebox"><h2 id="heading">千幕</h2></div></header>
    <div class="sd-body"><div class="sd-tab-content">
      <section class="sd-card">
        <div class="sd-card-title-row"><h3 id="card-title">一瞬灵光，万象入幕</h3></div>
        <div class="sd-director-paragraph"><p id="prose">沿着海岸向前，远处的灯塔在薄雾中显出轮廓。风翻过书页，留下一个尚未讲完的故事。此刻，选择继续探索，或停下来听一听海的声音。</p></div>
        <div class="fixture-form">
          <label id="label" for="input">画面标题</label>
          <input id="input" value="风经过的地方" aria-label="画面标题" readonly>
          <button class="sd-btn" id="button" type="button">继续取景</button>
        </div>
      </section>
      <section class="sd-card">
        <div class="sd-director-paragraph"><p id="chinese-probe">春江潮水连海平海上明月共潮生</p></div>
        <p class="sd-help">Aa Bb Cc · 0123456789 · Omniscene</p>
      </section>
      <p class="sd-help fixture-footer" id="fixture-caption">仅供字体与字号比对，所有内容均为合成样张。</p>
    </div></div>
  </section>
</main></body></html>`;

async function waitForFont(family) {
    if (family === 'classic') return { status: 'local-baseline', elapsedMs: 0 };
    return page.evaluate(async ({ expected, waitMs }) => {
        const started = performance.now(), end = started + waitMs;
        const normalize = value => value.replace(/["']/g, '').trim();
        const elapsed = () => Math.round(performance.now() - started);
        while (![...document.fonts].some(face => normalize(face.family) === expected)) {
            if (performance.now() >= end) return { status: 'stylesheet-or-face-timeout', elapsedMs: elapsed() };
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const surface = document.getElementById('story-director-modal');
        // Include the help/caption text and input values, not just the measured
        // nodes. The canvas ink probe below also needs its own Chinese glyphs.
        const visible = [...surface.querySelectorAll('*')].filter(node => node.getClientRects().length);
        const text = surface.innerText + visible.filter(node => node.matches('input,textarea')).map(node => node.value).join('') + '千幕天地玄黄';
        const weights = [...new Set(visible.map(node => getComputedStyle(node).fontWeight))];
        let timer;
        try {
            return await Promise.race([
                Promise.all(weights.map(weight => document.fonts.load(`${weight} 16px "${expected}"`, text))).then(groups => ({ status: groups.some(faces => faces.length) ? 'loaded' : 'no-matching-faces', faces: new Set(groups.flat()).size, elapsedMs: elapsed() }),
                    error => ({ status: 'font-load-error', error: String(error.message || error), elapsedMs: elapsed() })),
                new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'font-timeout', elapsedMs: elapsed() }), Math.max(0, end - performance.now())); }),
            ]);
        } finally { clearTimeout(timer); }
    }, { expected: expectedFonts[family], waitMs: FONT_MS });
}

async function waitForFontsReady() {
    return page.evaluate(async waitMs => {
        let timer;
        try {
            const ready = await Promise.race([document.fonts.ready.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), waitMs); })]);
            return { ready, status: document.fonts.status, loadingFaces: [...document.fonts].filter(face => face.status === 'loading').map(face => ({ family: face.family, weight: face.weight })) };
        } finally { clearTimeout(timer); }
    }, Math.max(1, Math.min(6000, TOTAL_MS - (Date.now() - started) - 1000)));
}

async function metrics() {
    return page.evaluate(ids => {
        const canvas = document.createElement('canvas'), pen = canvas.getContext('2d');
        const rect = box => ({ x: box.x, y: box.y, width: box.width, height: box.height });
        const result = {};
        for (const id of ids) {
            const node = document.getElementById(id), css = getComputedStyle(node), range = document.createRange();
            range.selectNodeContents(node);
            pen.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
            const ink = pen.measureText('千幕天地玄黄');
            result[id] = { fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight,
                fontWeight: css.fontWeight, letterSpacing: css.letterSpacing, box: rect(node.getBoundingClientRect()),
                textBox: rect(range.getBoundingClientRect()), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
                ink: { width: ink.width, ascent: ink.actualBoundingBoxAscent, descent: ink.actualBoundingBoxDescent } };
        }
        return { nodes: result, scale: Object.fromEntries(['page-title', 'feature-title', 'card-title', 'body', 'label', 'caption', 'micro']
            .map(key => [key, getComputedStyle(document.getElementById('story-director-modal')).getPropertyValue(`--qm-type-${key}`).trim()])),
            documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            theme: document.getElementById('story-director-modal').dataset.qmTheme || 'classic' };
    }, ids);
}

try {
    await mkdir(qa, { recursive: true });
    const require = createRequire(import.meta.url);
    const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true, timeout: 20000 });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(6000); page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === 'GET' && url.origin === 'https://qianmu.test') {
            if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
            if (/^\/(?:style\.css|qianmu-[a-z0-9-]+\.(?:js|css))$/.test(url.pathname)) {
                try { return await route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) }); }
                catch (error) { errors.push(`Local fixture ${url.pathname}: ${String(error.message || error).split('\n')[0]}`); if (!closing) await route.abort().catch(() => {}); return; }
            }
        }
        if (request.method() === 'GET' && approvedFont(url) && ['stylesheet', 'font'].includes(request.resourceType())) {
            const row = { url: url.href, type: request.resourceType(), status: null, elapsedMs: null };
            network.push(row); const requestStart = Date.now();
            try {
                // maxRedirects:0 prevents even a permitted URL from escaping the
                // allowlist by redirecting APIRequestContext to another host.
                const response = await route.fetch({ maxRedirects: 0, timeout: FONT_MS });
                row.status = response.status(); row.elapsedMs = Date.now() - requestStart;
                if (row.status >= 300 && row.status < 400) { row.error = 'Redirect refused'; return route.abort(); }
                return route.fulfill({ response });
            } catch (error) {
                row.elapsedMs = Date.now() - requestStart; row.error = String(error.message || error).split('\n')[0];
                if (!closing) await route.abort().catch(() => {});
                return;
            }
        }
        blocked.push({ url: url.href, method: request.method(), type: request.resourceType() });
        return route.abort();
    });
    await page.goto('https://qianmu.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async mode => {
        const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
        const { updateAppearancePreferences } = await import('/qianmu-appearance-settings.js');
        window.settings = { theme: mode };
        window.session = createQianmuAppearanceSession({ readSettings: () => settings, document, styleUrl: '/qianmu-theme-skins.css' });
        session.mount(document.getElementById('story-director-modal')); await session.sync();
        window.setFamily = async family => {
            settings.appearance = updateAppearancePreferences(settings, { family, mode, accent: '#527c69', source: 'manual' });
            await session.sync();
            document.getElementById('fixture-caption').textContent = `${({ classic: '经典', editorial: '纸间', glass: '极简' })[family]} · 合成样张，仅核对实际字体、字号与行高。`;
        };
    }, mode);
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const baselines = new Map();
    for (const family of families) {
        await page.evaluate(family => setFamily(family), family);
        const load = await waitForFont(family);
        for (const width of [393, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const fontsReady = await waitForFontsReady();
            const result = await metrics(), platform = {};
            const { root } = await cdp.send('DOM.getDocument');
            for (const id of ids) {
                const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#' + id });
                platform[id] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
            }
            const sample = { family, name: names[family], width, load, fontsReady, ...result, platform };
            samples.push(sample);
            const label = `${width}/${family}/${mode}`;
            check(label + ' visible fonts settled before measurement and screenshot', fontsReady.ready, fontsReady);
            check(label + ' has no document overflow and all six UI samples are visible', !result.documentOverflow && ids.every(id => result.nodes[id].box.width > 0 && result.nodes[id].box.height > 0));
            check(label + ' uses the selected production theme', result.theme === family);
            const glyphs = platform['chinese-probe'].filter(font => font.glyphCount > 0);
            if (family === 'classic') {
                baselines.set(width, result);
                check(label + ' Chinese baseline uses installed platform glyphs', glyphs.length > 0 && glyphs.every(font => !font.isCustomFont));
            } else {
                const wanted = normalized(expectedFonts[family]);
                // Dedicated Han-only node prevents a Latin glyph or merely the
                // declared CSS family from masquerading as Chinese-font proof.
                check(label + ' actual Chinese glyphs use ' + expectedFonts[family], glyphs.length > 0
                    && glyphs.every(font => normalized(font.familyName + font.postScriptName).includes(wanted))
                    && (family !== 'editorial' || (load.status === 'loaded' && glyphs.every(font => font.isCustomFont))), glyphs);
                const baseline = baselines.get(width);
                check(label + ' preserves the classic font-size scale', ids.every(id => result.nodes[id].fontSize === baseline.nodes[id].fontSize),
                    Object.fromEntries(ids.map(id => [id, [baseline.nodes[id].fontSize, result.nodes[id].fontSize]])));
                check(label + ' preserves shared line heights', ids.every(id => result.nodes[id].lineHeight === baseline.nodes[id].lineHeight));
                for (const id of ids) {
                    const current = result.nodes[id].ink, prior = baseline.nodes[id].ink;
                    const heightRatio = (current.ascent + current.descent) / (prior.ascent + prior.descent || 1);
                    const widthRatio = current.width / (prior.width || 1);
                    if (heightRatio < 0.65 || heightRatio > 1.5 || widthRatio < 0.75 || widthRatio > 1.35) warnings.push({ label, id, heightRatio, widthRatio, note: 'Review apparent glyph-size difference in the screenshot; not a CSS font-size conclusion.' });
                }
            }
            const filename = `${family}_${mode}_${width}.png`;
            try { await page.screenshot({ path: fileURLToPath(new URL(filename, qa)), fullPage: true, animations: 'disabled', timeout: Math.max(1, Math.min(12000, TOTAL_MS - (Date.now() - started) - 1000)) }); screenshots.push(filename); }
            catch (error) { errors.push(`${label} screenshot: ${String(error.message || error).split('\n')[0]}`); }
        }
    }
    check('all outbound requests stayed inside the two approved GET font directories', blocked.length === 0, blocked);
    check('no page script errors or total timeout', errors.length === 0 && !timedOut);
    check('both supplied font CSS resources were actually requested', ['/161/main/result.css', '/309/main/result.css'].every(path => network.some(row => new URL(row.url).pathname === path && row.status === 200)));
} catch (error) {
    errors.push(String(error.stack || error));
} finally {
    clearTimeout(deadline); closing = true;
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
    report.networkFailures = network.filter(row => row.error || row.status === null || row.status >= 400);
    check('approved font requests completed without network failures', report.networkFailures.length === 0, report.networkFailures);
    report.elapsedMs = Date.now() - started;
    report.passed = checks.filter(row => row.pass).length;
    report.failed = checks.filter(row => !row.pass).length;
    report.timedOut = timedOut;
    await mkdir(qa, { recursive: true });
    await writeFile(new URL(`report_${mode}.json`, qa), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors, blocked: blocked.length,
        approvedRequests: network.length, networkFailures: report.networkFailures, screenshots, visualWarnings: warnings.length, visualReviewRequired: true,
        report: fileURLToPath(new URL(`report_${mode}.json`, qa)), elapsedMs: report.elapsedMs }, null, 2));
    if (report.failed || errors.length || timedOut) process.exitCode = 1;
}
