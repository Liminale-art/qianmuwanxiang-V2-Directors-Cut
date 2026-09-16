// Actual still/motion viewer owners with synthetic images and a locally recorded
// silent clip. No user files, provider requests, persistence or generation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const names = ['storyboardOpenLightbox', 'storyboardCloseLightbox', 'storyboardRecordParameterLabel', 'storyboardSafeUrl',
    'storyboardOpenVideoViewer', 'storyboardCloseVideoViewer', 'storyboardVideoMetaLabel', 'storyboardVideoExtension', 'formatStorageBytes'];
const source = names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n'
    + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], ok = (label, result) => { assert.ok(result, label); checks.push(label); };
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const qa = new URL('../dist/local-qa/media-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;background:#dedbd5}*,*::before,*::after{box-sizing:border-box}</style><button id="origin">隔离素材入口</button>` });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({
        contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)),
    });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, { storyboardProductionContext }, usage, gallery, session, preferences, icons] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-storyboard.js'), import('/qianmu-runninghub-usage.js'),
            import('/qianmu-video-gallery.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        Object.assign(window, utils, usage, icons, { storyboardProductionContext, settings: { theme: 'dark' }, fixtureChat: 'fixture-chat', fixtureAccount: 'fixture-account',
            storyboardAdmissionEpoch: 0, storyboardLightboxEpoch: 0, storyboardLightboxEl: null, storyboardVideoViewerEl: null, storyboardVideoPlayback: null,
            calls: { loads: 0, reads: 0, urls: 0, releases: 0, forbidden: 0, confirms: 0 }, notices: [], store: {}, viewState: {},
            STORYBOARD_SOURCES: { novel: { label: 'NAI' }, comfy: { label: 'Comfy' } },
            getChatKey: () => fixtureChat, getChatStore: () => store, storyboardState: () => viewState, storyboardGalleryRecords: () => store.storyboardImages,
            confirmDialog: async () => { calls.confirms++; return false; }, toast: (text, tone) => notices.push({ text, tone }),
        });
        const forbidden = () => { calls.forbidden++; throw Error('Production mutation is forbidden'); };
        for (const name of ['saveMetadata', 'storyboardDeleteRecordSnapshots', 'storyboardDownloadRecord', 'storyboardEditPrompt',
            'storyboardRedrawRecord', 'storyboardApplyRecordStyle', 'storyboardChooseArtistForRecord', 'storyboardRefreshVideoGallery']) window[name] = forbidden;
        const image = (width, height, color) => {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.strokeRect(4, 4, width - 8, height - 8);
            ctx.fillStyle = '#fff'; ctx.font = '32px sans-serif'; ctx.fillText(`${width} × ${height}`, 24, 48);
            return canvas.toDataURL('image/png');
        };
        store.storyboardImages = [[1200, 600], [600, 1200], [900, 900]].map(([width, height], i) => ({ id: 'still-' + i,
            url: image(width, height, ['#354f62', '#635a48', '#4c6358'][i]), width, height, floor: 7,
            source: i === 1 ? 'comfy' : 'novel', recipeUnavailable: i === 2, model: 'fixture', seed: 120 + i,
            prompt: '<img src=x>仅隔离画面\n' + '不可改编的原提示词\n'.repeat(50), negative: '隔离负面词', artistString: '隔离画师串',
            cloudUsage: { provider: 'runninghub', taskId: '123456789', usage: { consumeCoins: '1.2', consumeMoney: null, thirdPartyConsumeMoney: null, taskCostTime: '5' } },
        }));
        // Browser-native encoding gives the actual <video> element a decodable,
        // silent source. This records a test canvas, never the screen or camera.
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px'; document.body.append(canvas);
        const ctx = canvas.getContext('2d'), stream = canvas.captureStream(0), chunks = [];
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        const recorded = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = resolve; });
        recorder.start();
        for (let i = 0; i < 8; i++) {
            ctx.fillStyle = i % 2 ? '#4d645b' : '#3c526a'; ctx.fillRect(0, 0, 640, 360);
            stream.getVideoTracks()[0].requestFrame();
            await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 75)));
        }
        recorder.stop(); await recorded; stream.getTracks().forEach(track => track.stop()); canvas.remove();
        const blob = new Blob(chunks, { type: 'video/webm' });
        window.mediaRecords = [1, 2].map(attempt => ({ assetId: 'motion-' + attempt, recordId: 'record-' + attempt, blob,
            meta: { chatKey: 'fixture-chat', floor: 7, versionRootId: 'motion-chain', attempt, durationSeconds: .4, resolution: '640×360', ratio: '16:9',
                aiGenerated: true, generator: '隔离生成器-' + 'g'.repeat(115), createdAt: 1, updatedAt: 1 } }));
        window.blobStore = { listVideoMedia: async () => { throw Error('No list reload expected'); }, deleteVideoMedia: forbidden,
            getVideoMedia: async id => { calls.reads++; if (window.mediaReadGate) await mediaReadGate; return mediaRecords.find(record => record.assetId === id); } };
        window.storyboardVideoGallerySession = gallery.createVideoGallerySession(blobStore, { urlApi: {
            createObjectURL: blob => { calls.urls++; return URL.createObjectURL(blob); },
            revokeObjectURL: url => { calls.releases++; URL.revokeObjectURL(url); },
        } });
        window.storyboardVideoGalleryRuntime = { chains: gallery.buildVideoVersionChains(mediaRecords) };
        window.featureRuntime = { load: async name => {
            calls.loads++; if (name === 'imageAdmission') return { resolveImageAccountNamespace: async () => { if (window.identityGate) await identityGate; return fixtureAccount; } };
            if (name === 'videoGallery') return gallery;
            throw Error('Unexpected feature ' + name);
        } };
        (0, eval)(source);
        window.appearanceSession = session.createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        window.setAppearance = async (family, mode) => { settings.appearance = preferences.updateAppearancePreferences(settings, { family, mode }); await appearanceSession.sync(); };
        window.mediaGeometry = (root, stage, media, detail) => {
            const r = root.getBoundingClientRect(), s = stage.getBoundingClientRect(), m = media.getBoundingClientRect(), d = detail.getBoundingClientRect();
            const naturalRatio = media.tagName === 'IMG' ? media.naturalWidth / media.naturalHeight : media.videoWidth / media.videoHeight;
            return { viewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
                fullImage: m.left >= s.left - 1 && m.top >= s.top - 1 && m.right <= s.right + 1 && m.bottom <= s.bottom + 1,
                ratio: Math.abs(m.width / m.height - naturalRatio) < .015, nonzero: m.width > 20 && m.height > 20,
                detail: d.right <= innerWidth + 1 && d.bottom <= innerHeight + 1 && detail.scrollWidth <= detail.clientWidth + 1 };
        };
    }, source);
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) {
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ({ family, mode }) => { await setAppearance(family, mode); document.querySelector('#origin').focus(); await storyboardOpenLightbox(store.storyboardImages); }, { family, mode });
            for (let index = 0; index < 3; index++) {
                const label = `${family}/${mode}/${width}/still-${index}`;
                await page.locator('.sd-storyboard-lightbox-stage img').evaluate(image => image.decode());
                const geometry = await page.evaluate(() => mediaGeometry(storyboardLightboxEl, storyboardLightboxEl.querySelector('.sd-storyboard-lightbox-stage'), storyboardLightboxEl.querySelector('img'), storyboardLightboxEl.querySelector('aside')));
                ok(label + ' full image and details remain inside viewport: ' + JSON.stringify(geometry), Object.values(geometry).every(Boolean));
                ok(label + ' original editing and task usage remain accurate', await page.evaluate(index => {
                    const layer = storyboardLightboxEl;
                    return layer.querySelectorAll('.sd-storyboard-lightbox-edit,.sd-storyboard-lightbox-redraw').length === (index === 2 ? 0 : 2)
                        && !!layer.querySelector('.sd-storyboard-lightbox-download') && !!layer.querySelector('.sd-storyboard-lightbox-delete')
                        && layer.querySelectorAll('img').length === 1 && layer.textContent.includes('整次任务用量（非单张）');
                }, index));
                const stable = await page.evaluate(async ({ family, mode }) => {
                    const root = storyboardLightboxEl, image = root.querySelector('img'), detail = root.querySelector('aside'), close = root.querySelector('button');
                    detail.scrollTop = 111; close.focus();
                    const top = detail.scrollTop, markup = root.innerHTML, source = image.src, before = JSON.stringify([calls, store]), background = getComputedStyle(root).backgroundColor;
                    await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
                    return { dom: root === storyboardLightboxEl && image === root.querySelector('img') && root.innerHTML === markup,
                        source: source === image.src, scroll: top > 0 && detail.scrollTop === top, focus: document.activeElement === close,
                        calls: before === JSON.stringify([calls, store]), canvas: getComputedStyle(root).backgroundColor === background,
                        mode: family === 'classic' ? !root.dataset.qmTheme : root.dataset.qmMode === 'dark' };
                }, { family, mode });
                ok(label + ' appearance preserves media, focus, scroll and ownership: ' + JSON.stringify(stable), Object.values(stable).every(Boolean));
                if (width === 393 && index === 1 && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                    await page.evaluate(() => { storyboardLightboxEl.querySelector('aside').scrollTop = 0; });
                    await page.screenshot({ caret: 'initial', animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-still-393.png`, qa)) });
                }
                if (index < 2) await page.locator('.sd-storyboard-lightbox-next').click();
            }
            await page.locator('.sd-storyboard-lightbox-delete').click();
            await page.waitForFunction(() => storyboardLightboxEl?.style.visibility === '');
            ok(`${family}/${mode}/${width} cancel deletion does not remove or rewrite images`, await page.evaluate(() => store.storyboardImages.length === 3 && calls.forbidden === 0));
            await page.locator('.sd-storyboard-lightbox-close').click();
            ok(`${family}/${mode}/${width} image close returns focus and releases appearance ownership`, await page.evaluate(async () => {
                await appearanceSession.sync(); return !storyboardLightboxEl && document.activeElement.id === 'origin' && appearanceSession.size === 0;
            }));
            await page.evaluate(() => storyboardOpenVideoViewer('motion-1'));
            ok(`${family}/${mode}/${width} viewer opens without a swallowed fixture error: ` + JSON.stringify(await page.evaluate(() => notices)), await page.locator('.sd-storyboard-video-stage video').count() === 1);
            await page.waitForFunction(() => { const video = document.querySelector('.sd-storyboard-video-stage video'); return video?.readyState >= 2 || video?.error; });
            const decoding = await page.locator('.sd-storyboard-video-stage video').evaluate(video => ({ ready: video.readyState, error: video.error?.message || '', bytes: mediaRecords[0].blob.size }));
            ok('synthetic clip decodes: ' + JSON.stringify(decoding), decoding.ready >= 2 && !decoding.error);
            const label = `${family}/${mode}/${width}/motion`;
            ok(label + ' close/download/delete icons are shipped local glyphs, not empty font placeholders', await page.locator('.sd-storyboard-video-viewer button > .qm-glyph-icon > svg').evaluateAll(nodes =>
                nodes.length === 3 && nodes.every(node => { const rect = node.getBoundingClientRect(); return rect.width >= 10 && rect.height >= 10 && node.childElementCount > 0; })));
            const geometry = await page.evaluate(() => mediaGeometry(storyboardVideoViewerEl, storyboardVideoViewerEl.querySelector('.sd-storyboard-video-stage'), storyboardVideoViewerEl.querySelector('video'), storyboardVideoViewerEl.querySelector('aside')));
            ok(label + ' complete movie fits stage and details: ' + JSON.stringify(geometry), Object.values(geometry).every(Boolean));
            const stable = await page.evaluate(async ({ family, mode }) => {
                const root = storyboardVideoViewerEl, video = root.querySelector('video'), detail = root.querySelector('aside'), close = root.querySelector('button');
                video.pause(); video.volume = .31; video.muted = true; video.loop = true; video.currentTime = .08;
                if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
                detail.scrollTop = 90; close.focus();
                const position = detail.scrollTop, before = JSON.stringify(calls), time = video.currentTime, src = video.currentSrc, markup = root.innerHTML;
                let resets = 0; video.addEventListener('loadstart', () => resets++);
                await setAppearance(family === 'glass' ? 'editorial' : 'glass', mode === 'light' ? 'dark' : 'light'); await setAppearance(family, mode);
                await new Promise(resolve => requestAnimationFrame(resolve));
                return { dom: root === storyboardVideoViewerEl && video === root.querySelector('video') && markup === root.innerHTML,
                    playback: video.paused && video.volume === .31 && video.muted && Math.abs(time - video.currentTime) < .001 && video.currentSrc === src && resets === 0,
                    scroll: detail.scrollTop === position, focus: document.activeElement === close, reads: before === JSON.stringify(calls),
                    refs: storyboardVideoGallerySession.snapshot().length === 1 && storyboardVideoGallerySession.snapshot()[0].refs === 1,
                    mode: family === 'classic' ? !root.dataset.qmTheme : root.dataset.qmMode === 'dark' };
            }, { family, mode });
            ok(label + ' paused frame, volume, object URL and details survive appearance: ' + JSON.stringify(stable), Object.values(stable).every(Boolean));
            await page.locator('.sd-storyboard-video-delete').click();
            ok(label + ' cancelled removal leaves playback and storage alone', await page.evaluate(() => !!storyboardVideoViewerEl && calls.forbidden === 0));
            if (width === 393) {
                const live = await page.evaluate(async ({ family, mode }) => {
                    const video = storyboardVideoViewerEl.querySelector('video'), src = video.currentSrc, count = JSON.stringify(calls);
                    let frames = 0, active = true;
                    const watch = () => video.requestVideoFrameCallback(() => { frames++; if (active) watch(); }); watch();
                    await video.play(); await setAppearance('glass', 'dark'); await new Promise(resolve => setTimeout(resolve, 160)); await setAppearance(family, mode);
                    const playing = !video.paused; active = false; video.pause();
                    return playing && frames > 0 && src === video.currentSrc && count === JSON.stringify(calls);
                }, { family, mode });
                ok(label + ' real silent playback continues without rereading or reopening', live);
                if ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))
                    await page.screenshot({ caret: 'initial', animations: 'disabled', path: fileURLToPath(new URL(`${family}-${mode}-motion-393.png`, qa)) });
            }
            await page.locator('[data-storyboard-video-version="motion-2"]').click();
            await page.waitForFunction(() => storyboardVideoPlayback?.assetId === 'motion-2');
            ok(label + ' version switching releases previous URL and keeps one owner', await page.evaluate(() => storyboardVideoGallerySession.snapshot().length === 1 && storyboardVideoGallerySession.snapshot()[0].assetId === 'motion-2' && calls.urls - calls.releases === 1));
            await page.locator('.sd-storyboard-video-viewer').press('Escape');
            ok(label + ' close releases native playback URL and appearance owner', await page.evaluate(async () => {
                await appearanceSession.sync(); return !storyboardVideoViewerEl && !storyboardVideoPlayback && storyboardVideoGallerySession.snapshot().length === 0 && calls.urls === calls.releases && appearanceSession.size === 0;
            }));
        }
    }
    ok('closing before image identity resolves cannot reopen its old viewer', await page.evaluate(async () => {
        let finish; identityGate = new Promise(resolve => { finish = resolve; });
        const pending = storyboardOpenLightbox(store.storyboardImages); storyboardCloseLightbox(); finish(); await pending; identityGate = null;
        return !storyboardLightboxEl && !document.querySelector('.sd-storyboard-lightbox');
    }));
    ok('account change rejects image removal before confirmation or any mutation', await page.evaluate(async () => {
        await storyboardOpenLightbox(store.storyboardImages); fixtureAccount = 'different-fixture-account';
        const confirms = calls.confirms;
        storyboardLightboxEl.querySelector('.sd-storyboard-lightbox-delete').click();
        for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
        const notice = notices.pop(); fixtureAccount = 'fixture-account';
        return !storyboardLightboxEl && calls.confirms === confirms && calls.forbidden === 0 && store.storyboardImages.length === 3 && notice?.text.includes('账户或画面已变化');
    }));
    ok('motion arriving after a chat change releases its new URL without reopening', await page.evaluate(async () => {
        let finish; mediaReadGate = new Promise(resolve => { finish = resolve; });
        const pending = storyboardOpenVideoViewer('motion-1'); fixtureChat = 'other-fixture-chat'; finish(); await pending;
        mediaReadGate = null; fixtureChat = 'fixture-chat';
        return !storyboardVideoViewerEl && storyboardVideoGallerySession.snapshot().length === 0 && calls.urls === calls.releases;
    }));
    ok('missing motion is reported without an empty player or leaked URL', await page.evaluate(async () => {
        await storyboardOpenVideoViewer('missing-fixture'); const notice = notices.pop();
        return !storyboardVideoViewerEl && storyboardVideoGallerySession.snapshot().length === 0 && calls.urls === calls.releases && notice?.text.includes('暂时无法读取');
    }));
    const final = await page.evaluate(() => { appearanceSession.reset(); storyboardVideoGallerySession.dispose(); return { calls, notices }; });
    assert.equal(final.calls.forbidden, 0); assert.deepEqual(final.notices, []); assert.deepEqual(errors, []); assert.equal(external, 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors, external, ...final, scope: 'actual still/motion viewer functions and object URL session; synthetic image/audio-free clip, no host business writes or full immersive viewer claim' }));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
