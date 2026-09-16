// Existing film gallery/editor renderers and event bindings with synthetic data.
// No real persistence, file access, TTS, video generation, deletion or export.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const start = index.indexOf("  root.querySelector('.sd-storyboard-film-new')"), end = index.indexOf("  root.querySelectorAll('.sd-storyboard-video-refresh')", start);
assert.ok(start > 0 && end > start);
const bindings = index.slice(start, end);
const source = ['storyboardFilmDurationLabel', 'storyboardFilmMotionItems', 'storyboardFilmStillRecords', 'storyboardFilmSourceRecordForSelection',
    'storyboardFilmClipTimings', 'storyboardFilmDirectorSubtitleCount', 'storyboardFilmDirectorVoiceCount', 'storyboardFilmEditorFromTimeline',
    'storyboardFilmDurationMs', 'storyboardEnsureFilmClipIds', 'storyboardFilmPostproductionDraft', 'storyboardReconcileFilmPostproduction',
    'storyboardCaptureFilmPostproduction', 'storyboardCaptureFilmEditor', 'renderStoryboardFilmPostproduction', 'renderStoryboardFilmEditor',
    'renderStoryboardFilmGallery', 'storyboardOpenFilmEditor', 'renderStoryboardGalleryKindSwitch', 'storyboardVideoMetaLabel',
    'storyboardSafeUrl', 'storyboardRecordChatKey'].map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
const ok = (label, result) => { assert.ok(result, label); checks.push(label); };
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const qa = new URL('../dist/local-qa/film-editor-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body sd-storyboard-root"></main></section></div>` });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async ({ source, bindings }) => {
        const [utils, timelines, postproduction, sessions, preferences, icons] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-video-timeline.js'), import('/qianmu-video-postproduction.js'),
            import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        Object.assign(window, utils, icons, { MODAL_ID: 'story-director-modal', settings: { theme: 'dark' }, activeTab: 'imagegen',
            storyboardFilmEditor: null, storyboardFilmEditorOpenSeq: 0, storyboardGalleryKind: 'film', fixtureChat: 'film-chat',
            routeState: { view: 'gallery' }, storyboardState: () => routeState, getChatKey: () => fixtureChat,
            storyboardProductionContext: () => ({}), storyboardDirectorDecisionSnapshot: () => null, formatDateTime: () => '2026-09-17 07:00',
            calls: { post: 0, auth: 0, render: 0, forbidden: 0 }, notices: [], toast: (text, tone) => notices.push({ text, tone }),
        });
        const forbidden = () => { calls.forbidden++; throw Error('Production mutation forbidden'); };
        window.storyboardSaveFilmEditor = window.storyboardDeleteFilmTimeline = window.storyboardOpenFilmViewer = window.storyboardGenerateDirectorVoice
            = window.storyboardImportDirectorSubtitles = window.ttsPlayBlob = forbidden;
        window.blobStore = { getAudio: forbidden };
        window.storyboardDirectorWorkOrderForRecord = async () => { calls.auth++; return null; };
        const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 320;
        const paint = canvas.getContext('2d'); paint.fillStyle = '#658777'; paint.fillRect(0, 0, 240, 320);
        paint.fillStyle = '#d9dbd0'; paint.fillRect(12, 18, 216, 180); const url = canvas.toDataURL('image/png');
        window.stills = Array.from({ length: 48 }, (_, i) => ({ id: `still-${i}`, chatKey: fixtureChat, floor: i + 3, url }));
        window.storyboardGalleryRecords = () => [...stills, { id: 'foreign', chatKey: 'foreign-chat', floor: 99, url }];
        const motion = Array.from({ length: 12 }, (_, i) => ({ assetId: `motion-${i}`, recordId: `still-${i}`, sourceRecordId: `still-${i}`,
            owner: { chatKey: fixtureChat, floor: i + 3 }, technical: { durationSeconds: 6, resolution: '768P', audioMode: 'native' } }));
        window.film = timelines.normalizeVideoTimeline({ timelineId: 'film', title: '隔离编排 <img src=x> ' + '长标题'.repeat(8), owner: { chatKey: fixtureChat },
            clips: Array.from({ length: 8 }, (_, i) => ({ clipId: `clip-${i}`, kind: i === 1 ? 'motion' : 'still', title: `片段${i + 1}`,
                owner: { chatKey: fixtureChat }, source: { recordId: `still-${i}`, assetId: i === 1 ? 'motion-1' : '' }, playback: { durationSeconds: i === 1 ? 6 : 3, audio: i === 1 ? 'native' : 'mute' } })) });
        window.project = postproduction.normalizeVideoPostproduction({ mode: 'layered', subtitles: Array.from({ length: 4 }, (_, i) => ({
            cueId: `cue-${i}`, startMs: i * 3000, endMs: i * 3000 + 2500, text: `原文 <img src=x> ${i + 1}`, source: { kind: 'manual' }, kind: 'dialogue',
        })), transitions: [{ fromClipId: 'clip-0', toClipId: 'clip-1', type: 'crossfade', durationMs: 400 }] }, film);
        window.storyboardFilmRuntime = { chatKey: fixtureChat, status: 'ready', timelines: [film], motionChains: [{ items: motion }], error: '', timelineError: '', mediaError: '' };
        window.storyboardEnsureFilmRuntime = async () => ({ timelineModule: timelines, store: { load: async () => null } });
        window.storyboardEnsureFilmPostproductionRuntime = async () => ({ postproductionModule: postproduction, store: {
            load: async () => { calls.post++; const result = structuredClone(project); if (window.postGate) await postGate; return result; },
        } });
        (0, eval)(source);
        window.bindFilm = new Function('root', bindings);
        window.renderModal = () => { calls.render++; const root = document.querySelector('.sd-body'); root.innerHTML = renderStoryboardFilmGallery(); applyQianmuIcons(root); bindFilm(root); };
        window.appearance = sessions.createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(document.getElementById(MODAL_ID));
        window.setAppearance = async (family, mode) => { settings.appearance = preferences.updateAppearancePreferences(settings, { family, mode }); await appearance.sync(); };
        renderModal();
        window.layout = () => {
            const root = document.querySelector('.sd-body'), bounds = root.getBoundingClientRect();
            const overflow = [...root.querySelectorAll('input,textarea,select,button,article,section')].filter(node => {
                if (!node.getClientRects().length || node.closest('.sd-storyboard-film-source-grid')) return false;
                const r = node.getBoundingClientRect(); return r.width > 0 && (r.left < bounds.left - 1 || r.right > bounds.right + 1);
            }).map(node => ({ class: node.className, width: node.getBoundingClientRect().width }));
            return { overflow, rootOverflow: root.scrollWidth - root.clientWidth };
        };
    }, { source, bindings });
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) {
            const label = `${family}/${mode}/${width}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ([family, mode]) => { storyboardFilmEditor = null; renderModal(); await setAppearance(family, mode); }, [family, mode]);
            ok(`${label} real gallery actions visible`, await page.locator('.sd-storyboard-film-new').isVisible() && await page.locator('.sd-storyboard-film-preview').count() === 1);
            await page.locator('.sd-storyboard-film-edit').click();
            await page.waitForSelector('.sd-storyboard-film-title');
            const geometry = await page.evaluate(() => layout());
            ok(`${label} editor fits ${JSON.stringify(geometry)}`, geometry.overflow.length === 0 && geometry.rootOverflow < 2);
            ok(`${label} theme shape and source scrolling`, await page.evaluate(family => {
                const clip = getComputedStyle(document.querySelector('.sd-storyboard-film-clip'));
                const grid = getComputedStyle(document.querySelector('.sd-storyboard-film-source-grid'));
                return family === 'classic' ? grid.scrollbarWidth === 'thin'
                    : clip.borderRadius === (family === 'glass' ? '22px' : '5px') && grid.scrollbarWidth === 'none';
            }, family));
            const controls = await page.evaluate(() => ({ foreign: document.querySelectorAll('[data-storyboard-film-add-id="foreign"]').length,
                sources: document.querySelectorAll('[data-storyboard-film-add-kind]').length, icons: document.querySelectorAll('.qm-glyph-svg').length,
                missing: [...document.querySelectorAll('i.fa-solid')].filter(node => !node.querySelector('.qm-glyph-svg')).map(node => node.className) }));
            ok(`${label} source filtering and local icons ${JSON.stringify(controls)}`, controls.foreign === 0 && controls.sources === 60 && controls.icons >= 60 && controls.missing.length === 0);
            ok(`${label} title and subtitle are escaped`, await page.locator('.sd-storyboard-film-postproduction img').count() === 0
                && (await page.locator('.sd-storyboard-film-title').inputValue()).includes('<img src=x>'));
            const title = page.locator('.sd-storyboard-film-title'); await title.fill('未保存的编排名称');
            await page.locator('[data-storyboard-film-subtitle-text]').first().fill('未保存的原文字幕');
            const retained = await page.evaluate(async ([family, mode]) => {
                const root = document.querySelector('.sd-body'), field = root.querySelector('[data-storyboard-film-subtitle-text]');
                const grid = root.querySelectorAll('.sd-storyboard-film-source-grid')[1];
                field.focus(); field.setSelectionRange(2, 5); root.scrollTop = 137; grid.scrollTop = 101;
                const before = { html: root.innerHTML, data: JSON.stringify(storyboardFilmEditor), calls: JSON.stringify(calls), y: root.scrollTop, sourceY: grid.scrollTop };
                await setAppearance(family, mode === 'light' ? 'dark' : 'light');
                return { nodes: root.querySelector('[data-storyboard-film-subtitle-text]') === field && root.innerHTML === before.html,
                    focus: document.activeElement === field && field.selectionStart === 2 && field.selectionEnd === 5,
                    draft: field.value === '未保存的原文字幕' && root.querySelector('.sd-storyboard-film-title').value === '未保存的编排名称',
                    data: JSON.stringify(storyboardFilmEditor) === before.data, calls: JSON.stringify(calls) === before.calls,
                    scroll: root.scrollTop === before.y && grid.scrollTop === before.sourceY, usedScroll: before.y > 0 && before.sourceY > 0 };
            }, [family, mode]);
            for (const [key, value] of Object.entries(retained)) ok(`${label} retains ${key}`, value);
            await page.evaluate(([family, mode]) => setAppearance(family, mode), [family, mode]);
            await page.locator('[data-storyboard-film-duration="0"]').fill('5');
            await page.locator('[data-storyboard-film-transition-type]').first().selectOption('dip_black');
            ok(`${label} explicit transition captures current title/subtitle/duration`, await page.evaluate(() => storyboardFilmEditor.title === '未保存的编排名称'
                && storyboardFilmEditor.selections[0].durationSeconds === 5 && storyboardFilmEditor.postproduction.subtitles[0].text === '未保存的原文字幕'
                && storyboardFilmEditor.postproduction.transitions[0].type === 'dip_black'));
            await page.locator('[data-storyboard-film-post-mode="native_only"]').click();
            ok(`${label} native mode hides without deleting sidecar`, await page.locator('[data-storyboard-film-subtitle-text]').count() === 0
                && await page.evaluate(() => storyboardFilmEditor.postproduction.subtitles.length === 4));
            await page.locator('[data-storyboard-film-post-mode="layered"]').click();
            ok(`${label} layered mode restores authored subtitle`, (await page.locator('[data-storyboard-film-subtitle-text]').first().inputValue()) === '未保存的原文字幕');
            await page.locator('[data-storyboard-film-clip="1"] [data-storyboard-film-audio]').click();
            ok(`${label} original audio toggle works`, await page.evaluate(() => storyboardFilmEditor.selections[1].audio === 'mute'));
            await page.locator('[data-storyboard-film-clip="0"] [data-storyboard-film-move="1"]').click();
            ok(`${label} reordering retains ids and drops obsolete transition`, await page.evaluate(() => storyboardFilmEditor.selections[1].clipId === 'clip-0'
                && storyboardFilmEditor.postproduction.transitions.length === 0));
            await page.locator('[data-storyboard-film-subtitle-add]').click();
            ok(`${label} adding subtitle stays local`, await page.evaluate(() => storyboardFilmEditor.postproduction.subtitles.length === 5));
            await page.locator('[data-storyboard-film-subtitle-remove="4"]').click();
            await page.locator('[data-storyboard-film-add-kind="still"]').first().click();
            await page.waitForFunction(() => storyboardFilmEditor.selections.length === 9);
            ok(`${label} adding a still uses the existing approval check`, await page.evaluate(() => storyboardFilmEditor.selections[8].durationSeconds === 3 && calls.auth > 0));
            if (width === 393 && family !== 'classic' && mode === 'light') {
                await page.evaluate(() => { document.querySelector('.sd-body').scrollTop = 0; });
                await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}.png`, qa)), animations: 'disabled', caret: 'initial' });
                await page.evaluate(() => { const root = document.querySelector('.sd-body'); root.scrollTop = root.scrollHeight; });
                await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}-post.png`, qa)), animations: 'disabled', caret: 'initial' });
            }
            await page.locator('.sd-storyboard-film-cancel').click();
            ok(`${label} back returns to original list without save`, await page.evaluate(() => storyboardFilmEditor === null && storyboardFilmRuntime.timelines[0].title === film.title));
        }
    }
    await page.setViewportSize({ width: 393, height: 898 });
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const status of ['loading', 'error', 'empty', 'partial']) {
            await page.evaluate(async ([family, mode, status]) => {
                Object.assign(storyboardFilmRuntime, { status: status === 'empty' || status === 'partial' ? 'ready' : status,
                    timelines: status === 'empty' ? [] : [film], error: '读取失败 <img src=x>', mediaError: status === 'partial' ? 'video_media_unavailable' : '' });
                renderModal(); await setAppearance(family, mode);
            }, [family, mode, status]);
            ok(`${family}/${mode} ${status} gallery remains usable`, await page.evaluate(status => {
                const fit = layout(), body = document.querySelector('.sd-body');
                return fit.rootOverflow < 2 && fit.overflow.length === 0 && !body.querySelector('img')
                    && (status !== 'loading' || body.querySelector('.sd-storyboard-film-refresh').disabled)
                    && (status !== 'error' || body.querySelector('.sd-storyboard-video-empty').textContent.includes('读取失败 <img src=x>'))
                    && (status !== 'empty' || body.textContent.includes('当前聊天还没有影片时间线'))
                    && (status !== 'partial' || body.querySelector('.sd-storyboard-video-warning').textContent.includes('动态素材索引'));
            }, status));
        }
    }
    await page.evaluate(async () => {
        Object.assign(storyboardFilmRuntime, { status: 'ready', timelines: [film], error: '', mediaError: '' }); renderModal();
        await storyboardOpenFilmEditor('film'); storyboardFilmEditor.selections[0].recordId = 'missing-still'; renderModal();
    });
    ok('missing source stays visible without silent removal', await page.locator('.sd-storyboard-film-clip.is-missing').count() === 1
        && await page.evaluate(() => storyboardFilmEditor.selections.length === 8));
    await page.locator('.sd-storyboard-film-clip.is-missing [data-storyboard-film-remove]').click();
    ok('explicit remove only edits the draft', await page.evaluate(() => storyboardFilmEditor.selections.length === 7 && storyboardFilmRuntime.timelines[0].clips.length === 8));
    await page.locator('.sd-storyboard-film-cancel').click();
    for (const action of ['close', 'change-chat', 'replace-page', 'change-kind']) {
        await page.evaluate(() => { window.postsBefore = calls.post; window.postGate = new Promise(resolve => { window.releasePost = resolve; }); window.openingEditor = storyboardOpenFilmEditor('film'); });
        await page.waitForFunction(() => calls.post > postsBefore);
        await page.evaluate(async action => {
            if (action === 'close') document.getElementById(MODAL_ID).classList.remove('open');
            if (action === 'change-chat') fixtureChat = 'other';
            if (action === 'replace-page') renderModal();
            if (action === 'change-kind') storyboardGalleryKind = 'motion';
            releasePost(); postGate = null; await openingEditor;
        }, action);
        ok(`late ${action} cannot replace the gallery`, await page.evaluate(() => !storyboardFilmEditor && !document.querySelector('.sd-storyboard-film-title')));
        await page.evaluate(() => { document.getElementById(MODAL_ID).classList.add('open'); fixtureChat = 'film-chat'; storyboardGalleryKind = 'film'; renderModal(); });
    }
    ok('no persistence or generation', await page.evaluate(() => calls.forbidden === 0));
    ok('no browser errors ' + JSON.stringify(errors), errors.length === 0); ok('no unlisted requests', external === 0);
    console.log(JSON.stringify({ passed: checks.length, errors, external, calls: await page.evaluate(() => calls), checks }));
} catch (error) { console.error(JSON.stringify(await page.evaluate(() => ({ notices: window.notices, layout: window.layout?.(), calls: window.calls })))); throw error; }
finally { clearTimeout(deadline); await browser.close(); }
