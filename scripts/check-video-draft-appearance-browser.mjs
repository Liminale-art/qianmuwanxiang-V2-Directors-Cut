// Exercise the real draft owner, picker and confirmation with local pure modules.
// Storage/services are in-memory doubles. No LLM, provider call, save or submission.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const source = ['storyboardVideoMetaLabel', 'storyboardVideoDraftModeLabel', 'storyboardEnsureVideoDraftRuntime',
    'storyboardCloseVideoDraftEditor', 'storyboardVideoDraftSourceRecord', 'storyboardDirectorWorkOrderForRecord',
    'storyboardVideoDraftSourceShot', 'storyboardVideoDraftCandidateRecords', 'storyboardVideoDraftEditorMarkup',
    'storyboardOpenVideoDraftEditor', 'storyboardSafeUrl', 'storyboardRecordChatKey'].map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], ok = (label, result) => { assert.ok(result, label); checks.push(label); };
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const qa = new URL('../dist/local-qa/video-draft-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;background:#ddd}*,*::before,*::after{box-sizing:border-box}</style>` });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({
        contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, storyboard, draft, session, preferences, icons] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-storyboard.js'), import('/qianmu-video-draft.js'),
            import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        Object.assign(window, utils, storyboard, icons, { settings: { theme: 'dark' }, fixtureChat: 'fixture-chat', fixtureRegion: 'global',
            storyboardVideoDraftStore: null, storyboardVideoDraftEditorEl: null, storyboardVideoDraftEditor: null, blobStore: {},
            optionalServiceState: { status: 'ready', services: ['minimax-h3'] }, fixtureCredential: true,
            calls: { list: 0, load: 0, services: 0, credential: 0, forbidden: 0 }, notices: [],
            getChatKey: () => fixtureChat, storyboardState: () => ({ shotPlans: [] }),
            storyboardVideoRegion: () => fixtureRegion, toast: (text, tone) => notices.push({ text, tone }),
            storyboardVideoOperationIssueLabel: text => String(text),
        });
        const forbidden = () => { calls.forbidden++; throw Error('Production mutation or generation forbidden'); };
        for (const key of ['storyboardCallCompiler', 'storyboardEnsureVideoCoordinator', 'saveMetadata', 'renderModal', 'storyboardRefreshVideoGallery']) window[key] = forbidden;
        const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#3d5961'; ctx.fillRect(0, 0, 600, 400);
        ctx.fillStyle = '#8fa69b'; ctx.fillRect(300, 20, 190, 380); ctx.fillStyle = '#ede4cd'; ctx.fillRect(345, 60, 95, 195);
        const url = canvas.toDataURL('image/png');
        window.records = Array.from({ length: 36 }, (_, i) => ({ id: `frame-${i}`, chatKey: fixtureChat, floor: 7 + i,
            messageId: `message-${i}`, shotId: `shot-${i}`, url, shotSpec: { id: `shot-${i}`, scene: 'A quiet kitchen with a sunlit doorway.',
                intent: { summary: 'A quiet kitchen holds steady as the camera moves toward the sunlit doorway.' },
                characters: [{ id: 'a', name: 'A <img src=x>', identity: ['red hair'], action: ['stands at the doorway'] }] } }));
        records.push({ ...records[0], id: 'foreign', chatKey: 'another-chat' });
        window.storyboardGalleryRecords = () => records;
        window.draftStore = { list: async () => { calls.list++; return []; }, load: async () => { calls.load++; return window.savedDraft || null; }, save: forbidden };
        window.refreshOptionalServiceState = async () => { calls.services++; if (window.serviceGate) await serviceGate; return { ...optionalServiceState }; };
        window.storyboardVideoCredentialConfigured = async () => { calls.credential++; return fixtureCredential; };
        window.featureRuntime = { load: async name => {
            if (window.failFeature === name) throw Error('Isolated module load failure');
            if (name === 'videoDraft') return draft;
            if (name === 'videoDraftStore') return { createVideoDraftStoreAdapter: () => draftStore };
            const paths = { videoPrompt: 'qianmu-video-prompt', videoReadiness: 'qianmu-video-readiness', videoPricing: 'qianmu-video-pricing', videoConfirmation: 'qianmu-video-confirmation' };
            if (!paths[name]) return forbidden();
            return import(`/${paths[name]}.js`);
        } };
        (0, eval)(source);
        window.appearanceSession = session.createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        window.setAppearance = async (family, mode) => { settings.appearance = preferences.updateAppearancePreferences(settings, { family, mode }); await appearanceSession.sync(); };
        window.click = selector => document.querySelector(selector).click();
        window.setField = (selector, value, type = 'change') => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event(type, { bubbles: true })); };
        window.inspect = () => {
            const root = storyboardVideoDraftEditorEl, editor = root.querySelector('.sd-storyboard-video-draft-editor'), rect = editor.getBoundingClientRect();
            const hidden = [...root.querySelectorAll('[hidden]')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.className);
            return { hidden, icons: root.querySelectorAll('.qm-glyph-svg').length, overflow: editor.scrollWidth - editor.clientWidth,
                fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight + 1,
                frameBottom: root.querySelector('.sd-storyboard-video-draft-body > figure').getBoundingClientRect().bottom,
                fieldsTop: root.querySelector('.sd-storyboard-video-draft-fields').getBoundingClientRect().top,
                foreign: root.querySelector('[data-video-draft-record="foreign"]') !== null,
                mode: root.getAttribute('data-qm-mode'), radius: getComputedStyle(editor).borderTopLeftRadius };
        };
        window.contrast = node => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d'), chain = [];
            for (let item = node; item; item = item.parentElement) chain.unshift(item);
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
            for (const item of chain) { ctx.fillStyle = getComputedStyle(item).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
            const bg = [...ctx.getImageData(0, 0, 1, 1).data];
            ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1);
            const fg = [...ctx.getImageData(0, 0, 1, 1).data], luminance = c => c.slice(0, 3).reduce((sum, v, i) => {
                v /= 255; return sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
            }, 0);
            return (Math.max(luminance(bg), luminance(fg)) + .05) / (Math.min(luminance(bg), luminance(fg)) + .05);
        };
        window.switchPreserving = async (selector, family, mode) => {
            const root = storyboardVideoDraftEditorEl, scroll = root.querySelector(selector), field = root.querySelector('.sd-storyboard-video-draft-direction textarea');
            field.focus({ preventScroll: true }); field.setSelectionRange(3, 8); scroll.scrollTop = 143;
            const before = { html: root.innerHTML, scroll: scroll.scrollTop, calls: JSON.stringify(calls), value: field.value };
            await setAppearance(family, mode);
            return { same: root === storyboardVideoDraftEditorEl && root.innerHTML === before.html,
                focus: document.activeElement === field && field.selectionStart === 3 && field.selectionEnd === 8,
                scroll: scroll.scrollTop === before.scroll, scrollUsed: before.scroll > 0, calls: JSON.stringify(calls) === before.calls, value: field.value === before.value };
        };
    }, source);
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) {
            const label = `${family}/${mode}/${width}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ([family, mode]) => { await setAppearance(family, mode); await storyboardOpenVideoDraftEditor(records[0]); }, [family, mode]);
            ok(`${label} opens actual owner`, await page.locator('.sd-storyboard-video-draft-layer').count() === 1);
            await page.waitForFunction(() => storyboardVideoDraftEditorEl && !document.querySelector('.sd-video-readiness-refresh').disabled && document.querySelector('.sd-video-estimate-total').textContent !== '计算中');
            const initial = await page.evaluate(() => inspect());
            ok(`${label} viewport ${JSON.stringify(initial)}`, initial.fits && initial.overflow <= 1 && !initial.foreign);
            ok(`${label} mobile frame never overlaps controls ${initial.frameBottom}/${initial.fieldsTop}`, width > 640 || initial.fieldsTop >= initial.frameBottom + 12);
            ok(`${label} owned icons`, initial.icons >= 12);
            ok(`${label} native hidden semantics ${JSON.stringify(initial.hidden)}`, initial.hidden.length === 0);
            ok(`${label} neutral media`, family === 'classic' || initial.mode === 'dark');
            if (family !== 'classic') {
                const ratios = await page.locator('.sd-video-prompt-status,.sd-video-readiness-summary,.sd-storyboard-video-estimate > small,.sd-storyboard-video-draft-editor > footer > small').evaluateAll(nodes => nodes.map(contrast));
                ok(`${label} readable local/cost notices ${JSON.stringify(ratios)}`, ratios.every(ratio => ratio >= 4.5));
                ok(`${label} family shell shape`, initial.radius === (family === 'glass' ? '22px' : '5px'));
            }
            await page.evaluate(() => setField('.sd-storyboard-video-draft-direction textarea', 'A slow camera move toward the doorway.', 'input'));
            const retained = await page.evaluate(([family, mode]) => switchPreserving('.sd-storyboard-video-draft-body', family, mode === 'dark' ? 'light' : 'dark'), [family, mode]);
            for (const [key, value] of Object.entries(retained)) ok(`${label} draft ${key}`, value);
            await page.evaluate(([family, mode]) => setAppearance(family, mode), [family, mode]);
            if (width === 393 && family !== 'classic' && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                await page.evaluate(() => { document.querySelector('.sd-storyboard-video-draft-body').scrollTop = 0; document.activeElement.blur(); });
                await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-draft.png`, qa)), animations: 'disabled', caret: 'initial' });
            }
            await page.evaluate(() => click('[data-video-draft-picker="references"]'));
            ok(`${label} picker hides draft`, await page.evaluate(() => getComputedStyle(document.querySelector('.sd-storyboard-video-draft-body')).display === 'none'));
            ok(`${label} picker remains within viewport`, await page.evaluate(() => {
                const editor = document.querySelector('.sd-storyboard-video-draft-editor'), grid = document.querySelector('.sd-storyboard-video-draft-picker-grid');
                const r = editor.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && grid.scrollWidth <= grid.clientWidth + 1;
            }));
            await page.evaluate(() => { click('[data-video-draft-record="frame-1"] > button'); setField('[data-video-draft-record="frame-1"] .sd-video-draft-subject-binding', 'a'); });
            const pickerRetained = await page.evaluate(async ([family, mode]) => {
                const picker = document.querySelector('.sd-storyboard-video-draft-picker-grid'); picker.scrollTop = 211;
                const before = picker.scrollTop, node = picker, html = picker.innerHTML;
                await setAppearance(family, mode === 'dark' ? 'light' : 'dark');
                return before > 0 && picker === node && picker.innerHTML === html && picker.scrollTop === before
                    && picker.querySelector('[data-video-draft-record="frame-1"] .sd-video-draft-subject-binding').value === 'a';
            }, [family, mode]);
            ok(`${label} reference choice and scroll survive palette`, pickerRetained);
            ok(`${label} escaped character name`, await page.locator('.sd-video-draft-subject-binding img').count() === 0);
            await page.evaluate(() => { click('.sd-video-draft-picker-clear'); click('.sd-video-draft-picker-done'); setField('.sd-video-draft-mode', 'auto'); click('.sd-video-prompt-prepare'); });
            await page.waitForFunction(() => !document.querySelector('.sd-video-prompt-prepare').disabled);
            ok(`${label} local prompt preview`, await page.evaluate(() => !document.querySelector('.sd-video-prompt-text').hidden && document.querySelector('.sd-video-prompt-text').value.includes('integrated_multimodal_description:')));
            await page.evaluate(() => { setField('.sd-video-prompt-text', document.querySelector('.sd-video-prompt-text').value + '\n', 'input'); click('.sd-video-confirmation-open'); });
            await page.waitForFunction(() => !document.querySelector('.sd-video-confirmation-open').disabled && document.querySelector('.sd-video-confirmation-summary').children.length > 0);
            ok(`${label} local prompt passes real confirmation`, await page.locator('.sd-video-confirmation-cost-check').isEnabled());
            ok(`${label} no implicit paid approval`, await page.locator('.sd-video-confirmation-accept').isDisabled());
            ok(`${label} no 2K row for 768p`, await page.locator('.sd-video-confirmation-2k-check').isHidden());
            ok(`${label} confirmation actions visible without horizontal overflow`, await page.evaluate(() => {
                const body = document.querySelector('.sd-video-confirmation-body'), footer = document.querySelector('.sd-storyboard-video-confirmation > footer').getBoundingClientRect();
                return body.scrollWidth <= body.clientWidth + 1 && footer.left >= 0 && footer.right <= innerWidth + 1 && footer.bottom <= innerHeight + 1;
            }));
            if (family !== 'classic') {
                const ratios = await page.locator('.sd-video-confirmation-summary dt,.sd-video-confirmation-cost > small,.sd-video-confirmation-provider,.sd-storyboard-video-confirmation > footer small').evaluateAll(nodes => nodes.map(contrast));
                ok(`${label} readable confirmation terms ${JSON.stringify(ratios)}`, ratios.every(ratio => ratio >= 4.5));
            }
            await page.evaluate(() => { click('.sd-video-confirmation-cost-check'); click('.sd-video-confirmation-rights-check'); });
            ok(`${label} license still required`, await page.locator('.sd-video-confirmation-accept').isDisabled());
            await page.evaluate(() => click('.sd-video-confirmation-license-check'));
            ok(`${label} three acknowledgements enable confirmation only`, await page.locator('.sd-video-confirmation-accept').isEnabled());
            const confirmRetained = await page.evaluate(async ([family, mode]) => {
                const body = document.querySelector('.sd-video-confirmation-body'); body.scrollTop = 109;
                const before = body.scrollTop, html = body.innerHTML;
                await setAppearance(family, mode);
                return body.innerHTML === html && body.scrollTop === before && !document.querySelector('.sd-video-confirmation-accept').disabled;
            }, [family, mode]);
            ok(`${label} confirmation does not reset`, confirmRetained);
            if (width === 393 && family !== 'classic' && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-confirmation.png`, qa)), animations: 'disabled', caret: 'initial' });
            }
            await page.evaluate(() => { click('.sd-video-confirmation-close'); setField('.sd-video-draft-resolution', '2k'); click('.sd-video-prompt-prepare'); });
            await page.waitForFunction(() => !document.querySelector('.sd-video-prompt-prepare').disabled);
            await page.evaluate(() => click('.sd-video-confirmation-open'));
            await page.waitForFunction(() => !document.querySelector('.sd-video-confirmation-open').disabled);
            ok(`${label} 2K row visible`, await page.locator('.sd-video-confirmation-2k-check').isVisible());
            await page.evaluate(() => { click('.sd-video-confirmation-cost-check'); click('.sd-video-confirmation-rights-check'); click('.sd-video-confirmation-license-check'); });
            ok(`${label} 2K separately acknowledged`, await page.locator('.sd-video-confirmation-accept').isDisabled());
            await page.evaluate(() => click('.sd-video-confirmation-2k-check input'));
            ok(`${label} 2K acknowledgement enables but never submits`, await page.locator('.sd-video-confirmation-accept').isEnabled());
            await page.evaluate(() => storyboardVideoDraftEditorEl.focus()); await page.keyboard.press('Escape');
            ok(`${label} Escape leaves draft intact`, await page.locator('.sd-storyboard-video-confirmation').isHidden() && await page.locator('.sd-storyboard-video-draft-editor').count() === 1);
            await page.keyboard.press('Escape');
            ok(`${label} second Escape closes`, await page.locator('.sd-storyboard-video-draft-layer').count() === 0);
        }
    }
    await page.setViewportSize({ width: 393, height: 700 });
    await page.evaluate(async () => { await setAppearance('glass', 'light'); fixtureCredential = false; optionalServiceState = { status: 'missing', services: [] }; await storyboardOpenVideoDraftEditor(records[0]); });
    await page.waitForFunction(() => !document.querySelector('.sd-video-readiness-refresh').disabled);
    ok('missing infrastructure remains visibly blocked', await page.locator('[data-video-readiness="gateway"][data-status="blocked"],[data-video-readiness="credential"][data-status="blocked"]').count() === 2);
    await page.evaluate(() => click('.sd-video-confirmation-open'));
    await page.waitForFunction(() => !document.querySelector('.sd-video-confirmation-open').disabled);
    ok('missing gateway/credential cannot approve', await page.locator('.sd-video-confirmation-cost-check').isDisabled() && await page.locator('.sd-video-confirmation-accept').isDisabled());
    await page.evaluate(async () => { storyboardCloseVideoDraftEditor(); fixtureCredential = true; optionalServiceState = { status: 'ready', services: ['minimax-h3'] }; fixtureRegion = 'cn'; await storyboardOpenVideoDraftEditor(records[0]); });
    await page.waitForFunction(() => !document.querySelector('.sd-video-readiness-refresh').disabled && document.querySelector('.sd-video-estimate-total').textContent !== '计算中');
    ok('unknown regional cost is not presented as free', await page.locator('.sd-video-estimate-breakdown').innerText().then(text => text.includes('暂无已核实公开价')));
    await page.evaluate(async () => { storyboardCloseVideoDraftEditor(); fixtureRegion = 'global'; failFeature = 'videoConfirmation'; await storyboardOpenVideoDraftEditor(records[0]); });
    await page.waitForFunction(() => !document.querySelector('.sd-video-readiness-refresh').disabled);
    await page.evaluate(() => { setField('.sd-storyboard-video-draft-direction textarea', 'Keep this draft when the module fails.', 'input'); click('.sd-video-confirmation-open'); });
    await page.waitForFunction(() => !document.querySelector('.sd-video-confirmation-open').disabled);
    ok('module failure keeps confirmation closed to spending', await page.locator('.sd-video-confirmation-blockers').innerText().then(text => text.includes('暂时无法打开')) && await page.locator('.sd-video-confirmation-accept').isDisabled());
    await page.evaluate(() => { click('.sd-video-confirmation-close'); failFeature = ''; click('.sd-video-prompt-prepare'); });
    await page.waitForFunction(() => !document.querySelector('.sd-video-prompt-prepare').disabled);
    ok('failed module leaves editable draft untouched', await page.locator('.sd-storyboard-video-draft-direction textarea').inputValue() === 'Keep this draft when the module fails.');
    await page.evaluate(() => click('.sd-video-confirmation-open'));
    await page.waitForFunction(() => !document.querySelector('.sd-video-confirmation-open').disabled);
    ok('module can retry without reopening draft', await page.locator('.sd-video-confirmation-cost-check').isEnabled());
    await page.evaluate(() => { click('.sd-video-confirmation-close'); click('[data-video-draft-picker="references"]'); for (let i = 0; i < 10; i++) click(`[data-video-draft-record="frame-${i}"] > button`); });
    ok('reference picker still enforces nine item ceiling', await page.locator('.sd-storyboard-video-draft-pick-card.is-reference').count() === 9);
    await page.evaluate(() => { storyboardVideoDraftEditorEl.focus(); }); await page.keyboard.press('Escape');
    ok('picker Escape returns to draft', await page.locator('.sd-storyboard-video-draft-picker').isHidden() && await page.locator('.sd-storyboard-video-draft-body').isVisible());
    await page.evaluate(async () => {
        storyboardCloseVideoDraftEditor();
        savedDraft = (await import('/qianmu-video-draft.js')).createVideoDraftFromStoryboardFrame(records.at(-1));
        await storyboardOpenVideoDraftEditor('foreign-draft');
    });
    ok('foreign owner does not open', await page.locator('.sd-storyboard-video-draft-layer').count() === 0 && await page.evaluate(() => notices.at(-1).text.includes('不属于当前聊天')));
    await page.evaluate(async () => { serviceGate = new Promise(resolve => { window.releaseService = resolve; }); await storyboardOpenVideoDraftEditor(records[0]); });
    await page.waitForFunction(() => document.querySelector('.sd-video-readiness-refresh').disabled);
    await page.evaluate(async () => { storyboardCloseVideoDraftEditor(); releaseService(); serviceGate = null; await new Promise(resolve => requestAnimationFrame(resolve)); await appearanceSession.sync(); });
    ok('late readiness response never reopens a closed draft', await page.locator('.sd-storyboard-video-draft-layer').count() === 0 && await page.evaluate(() => appearanceSession.size === 0));
    ok('no page errors ' + JSON.stringify(errors), errors.length === 0);
    ok('no storage writes or paid entrypoints', await page.evaluate(() => calls.forbidden === 0));
    ok('no unlisted network', external === 0);
    console.log(JSON.stringify({ passed: checks.length, errors, external, checks }));
} catch (error) {
    console.error(JSON.stringify(await page.evaluate(() => ({ notices: window.notices, calls: window.calls,
        inspection: window.storyboardVideoDraftEditorEl ? inspect() : null, body: document.body.innerText.slice(-3500) }))));
    throw error;
} finally { clearTimeout(deadline); await browser.close(); }
