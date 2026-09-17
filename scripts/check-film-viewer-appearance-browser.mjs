// Real sequential-film owner/player, local synthetic media and in-memory stores.
// No user media, generation, save, delete, export, provider or network operations.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const source = ['storyboardFilmDurationLabel', 'storyboardFilmStillRecords', 'storyboardSafeUrl', 'storyboardRecordChatKey',
    'storyboardEnsureFilmRuntime', 'storyboardEnsureFilmPostproductionRuntime', 'storyboardCloseFilmViewer', 'storyboardFilmResolveStill',
    'storyboardFilmViewerTimelineOffsetMs', 'storyboardFilmViewerAbsoluteMs', 'storyboardSetFilmNativeAudioDuck',
    'storyboardReleaseFilmVoicePlayback', 'storyboardSyncFilmVoiceAudio', 'storyboardUpdateFilmViewerVoice',
    'storyboardUpdateFilmViewerSubtitle', 'storyboardSyncFilmViewerSubtitleClock', 'storyboardFilmViewerTransition',
    'storyboardSyncFilmViewerControls', 'storyboardPaintFilmViewer', 'storyboardOpenFilmViewer'].map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], ok = (label, value) => { assert.ok(value, label); checks.push(label); };
const deadline = setTimeout(() => { void browser.close(); }, 120000);
const qa = new URL('../dist/local-qa/film-viewer-appearance/', import.meta.url); await mkdir(qa, { recursive: true });
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
        const [utils, timelines, postproduction, gallery, session, preferences, icons] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-video-timeline.js'), import('/qianmu-video-postproduction.js'),
            import('/qianmu-video-gallery.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'),
        ]);
        Object.assign(window, utils, icons, { settings: { theme: 'dark' }, fixtureChat: 'film-chat', notices: [],
            storyboardVideoTimelineStore: null, storyboardVideoPostproductionStore: null, storyboardVideoGallerySession: null,
            storyboardFilmViewerPaintSeq: 0, storyboardFilmViewerEl: null, storyboardFilmPlaybackSession: null, storyboardFilmPlaybackState: null,
            storyboardFilmViewerPostproduction: null, storyboardFilmViewerLastReadyIndex: -1, storyboardFilmSubtitleTimer: null,
            storyboardFilmVoicePlayback: null, storyboardFilmVoiceFailures: new Set(), storyboardFilmVoiceLoadSeq: 0, storyboardFilmVoiceAutoplayWarned: false,
            calls: { timeline: 0, post: 0, media: 0, audio: 0, urls: 0, releases: 0, forbidden: 0 },
            getChatKey: () => fixtureChat, toast: (text, tone) => notices.push({ text, tone }),
        });
        const forbidden = () => { calls.forbidden++; throw Error('Production access forbidden'); };
        const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL), activeUrls = new Set();
        URL.createObjectURL = blob => { const url = createUrl(blob); calls.urls++; activeUrls.add(url); return url; };
        URL.revokeObjectURL = url => { if (!activeUrls.delete(url)) throw Error('Duplicate or unowned release'); calls.releases++; revokeUrl(url); };
        window.activeUrls = activeUrls;
        const image = (width, height, color) => {
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
            ctx.strokeStyle = '#faf4e3'; ctx.lineWidth = 6; ctx.strokeRect(4, 4, width - 8, height - 8);
            ctx.fillStyle = '#faf4e3'; ctx.font = '30px sans-serif'; ctx.fillText(`${width} × ${height}`, 24, 48); return canvas.toDataURL('image/png');
        };
        window.records = [[1200, 600], [600, 1200], [900, 900]].map(([w, h], i) => ({ id: `still-${i}`, chatKey: fixtureChat, floor: i + 4, url: image(w, h, ['#334d59', '#62594e', '#4c635c'][i]) }));
        window.storyboardGalleryRecords = () => records;
        // Paint before recording, then let the capture stream run at a real rate.
        // This records only this mounted test canvas, never screen/camera media.
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px'; document.body.append(canvas);
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4c635c'; ctx.fillRect(0, 0, 640, 360);
        await new Promise(resolve => requestAnimationFrame(resolve));
        const stream = canvas.captureStream(12), chunks = [], recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        const stopped = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = resolve; });
        recorder.start(100);
        for (let i = 0; i < 18; i++) {
            ctx.fillStyle = i % 2 ? '#445a6a' : '#607b74'; ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = '#eee5d0'; ctx.fillRect(i * 20, 80, 100, 160);
            await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 80)));
        }
        recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); canvas.remove();
        const blob = new Blob(chunks, { type: 'video/webm' }); window.clipBytes = blob.size;
        const wav = new ArrayBuffer(44 + 16000 * 2 * 10), data = new DataView(wav);
        const str = (offset, text) => [...text].forEach((char, i) => data.setUint8(offset + i, char.charCodeAt(0)));
        str(0, 'RIFF'); data.setUint32(4, wav.byteLength - 8, true); str(8, 'WAVEfmt '); data.setUint32(16, 16, true);
        data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 16000, true); data.setUint32(28, 32000, true);
        data.setUint16(32, 2, true); data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, wav.byteLength - 44, true);
        window.blobStore = { getVideoMedia: async assetId => { calls.media++; if (window.mediaGate) await mediaGate; if (window.missingMedia) return null;
                return { assetId, recordId: 'motion-record', blob, meta: { chatKey: 'film-chat', floor: 4, durationSeconds: 1.5, mimeType: 'video/webm' } }; },
            getAudio: async () => { calls.audio++; if (window.audioGate) await audioGate; if (window.missingAudio) return null; return { blob: new Blob([wav], { type: 'audio/wav' }) }; },
            listVideoMedia: forbidden, deleteVideoMedia: forbidden, putVideoMedia: forbidden, putAudio: forbidden };
        window.film = timelines.normalizeVideoTimeline({ timelineId: 'film', title: '隔离影片 <img src=x> · ' + '长片名'.repeat(16), owner: { chatKey: fixtureChat },
            clips: Array.from({ length: 120 }, (_, i) => ({ clipId: `clip-${i}`, kind: i === 1 ? 'motion' : 'still', title: `画面 ${i + 1}`,
                owner: { chatKey: fixtureChat }, source: { recordId: i === 1 ? 'motion-record' : `still-${i === 0 ? 0 : i === 2 ? 1 : 2}`, assetId: i === 1 ? 'motion' : '' },
                playback: { durationSeconds: i === 1 ? 1.5 : 10, audio: 'mute' } })) });
        window.project = postproduction.normalizeVideoPostproduction({ mode: 'layered', subtitles: [
            { cueId: 'cue', text: '<img src=x> 只呈现原台词。', startMs: 0, endMs: 20000, kind: 'dialogue' },
        ], transitions: [{ fromClipId: 'clip-0', toClipId: 'clip-1', type: 'crossfade', durationMs: 300 }, { fromClipId: 'clip-1', toClipId: 'clip-2', type: 'dip_black', durationMs: 300 }],
        audio: { dialogue: [{ audioId: 'voice', source: { assetId: 'silent-wav' }, startMs: 0, endMs: 10000 }] } }, film);
        window.storyboardFilmRuntime = { timelines: [film] };
        window.timelineStore = { load: async () => { calls.timeline++; return film; }, save: forbidden };
        window.postStore = { load: async () => { calls.post++; const value = structuredClone(project); if (window.postGate) await postGate; if (window.postFailure) throw Error('isolated postproduction read failed'); return value; }, save: forbidden };
        window.featureRuntime = { load: async name => {
            if (name === 'videoTimeline') return timelines;
            if (name === 'videoPostproduction') return postproduction;
            if (name === 'videoGallery') return gallery;
            if (name === 'videoTimelinePlayer') return import('/qianmu-video-timeline-player.js');
            if (name === 'videoTimelineStore') return { createVideoTimelineStoreAdapter: () => timelineStore };
            if (name === 'videoPostproductionStore') return { createVideoPostproductionStoreAdapter: () => postStore };
            return forbidden();
        } };
        (0, eval)(source);
        window.appearanceSession = session.createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        window.setAppearance = async (family, mode) => { settings.appearance = preferences.updateAppearancePreferences(settings, { family, mode }); await appearanceSession.sync(); };
        window.geometry = () => {
            const layer = storyboardFilmViewerEl, stage = layer.querySelector('main'), aside = layer.querySelector('aside'), media = stage.querySelector('img, video');
            const s = stage.getBoundingClientRect(), a = aside.getBoundingClientRect(), m = media?.getBoundingClientRect();
            return { fits: s.top >= 0 && a.top >= 0 && s.right <= innerWidth + 1 && a.right <= innerWidth + 1 && s.bottom <= innerHeight + 1 && a.bottom <= innerHeight + 1,
                noOverflow: aside.scrollWidth <= aside.clientWidth + 1,
                stageRect: { x: s.x, y: s.y, w: s.width, h: s.height }, mediaRect: m && { x: m.x, y: m.y, w: m.width, h: m.height },
                media: m && m.left >= s.left && m.top >= s.top && m.right <= s.right + 1 && m.bottom <= s.bottom + 1 && getComputedStyle(media).objectFit === 'contain',
                icons: layer.querySelectorAll('.qm-glyph-svg').length, mode: layer.getAttribute('data-qm-mode') };
        };
    }, source);
    ok('synthetic video contains encoded frames', await page.evaluate(() => clipBytes > 300));
    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) {
            const label = `${family}/${mode}/${width}`;
            await page.setViewportSize({ width, height: width === 320 ? 568 : 898 });
            await page.evaluate(async ([family, mode]) => { await setAppearance(family, mode); await storyboardOpenFilmViewer('film'); }, [family, mode]);
            ok(`${label} owner opens`, await page.locator('.sd-storyboard-film-viewer').count() === 1);
            await page.waitForFunction(() => storyboardFilmPlaybackState?.status === 'ready' && document.querySelector('main img')?.complete);
            const layout = await page.evaluate(() => geometry());
            ok(`${label} full stage and controls ${JSON.stringify(layout)}`, layout.fits && layout.noOverflow && layout.media);
            ok(`${label} local controls and segment icons`, layout.icons === 124);
            ok(`${label} neutral inspection mode`, family === 'classic' || layout.mode === 'dark');
            ok(`${label} themed shape and hidden scrollbars`, await page.evaluate(family => {
                const stage = getComputedStyle(document.querySelector('.sd-storyboard-film-viewer-stage'));
                const scroller = getComputedStyle(document.querySelector('.sd-storyboard-film-viewer-segments'));
                return family === 'classic' ? stage.borderRadius === '14px' && scroller.scrollbarWidth === 'thin'
                    : stage.borderRadius === (family === 'glass' ? '22px' : '0px') && scroller.scrollbarWidth === 'none';
            }, family));
            ok(`${label} title/subtitle remain text`, await page.locator('aside img,.sd-storyboard-film-viewer-subtitles img').count() === 0
                && await page.locator('.sd-storyboard-film-viewer-subtitles').innerText().then(text => text.includes('<img src=x>')));
            ok(`${label} no autoplay`, await page.evaluate(() => !storyboardFilmPlaybackState.playing && storyboardFilmVoicePlayback === null));
            const retained = await page.evaluate(async ([family, mode]) => {
                const root = storyboardFilmViewerEl, player = storyboardFilmPlaybackSession, media = root.querySelector('main img');
                const scroller = root.querySelector('.sd-storyboard-film-viewer-segments'), button = root.querySelector('.sd-storyboard-film-viewer-toggle');
                button.focus(); scroller.scrollTop = 121; scroller.scrollLeft = 153;
                const before = { x: scroller.scrollLeft, y: scroller.scrollTop, calls: JSON.stringify(calls), html: root.innerHTML, url: media.src };
                await setAppearance(family, mode === 'dark' ? 'light' : 'dark');
                return { root: root === storyboardFilmViewerEl && root.innerHTML === before.html, player: player === storyboardFilmPlaybackSession,
                    media: media === root.querySelector('main img') && media.src === before.url, calls: JSON.stringify(calls) === before.calls,
                    focus: document.activeElement === button, scroll: scroller.scrollTop === before.y && scroller.scrollLeft === before.x,
                    scrollUsed: before.x > 0 || before.y > 0 };
            }, [family, mode]);
            for (const [key, value] of Object.entries(retained)) ok(`${label} preserves ${key}`, value);
            await page.evaluate(([family, mode]) => setAppearance(family, mode), [family, mode]);
            await page.locator('.sd-storyboard-film-viewer-toggle').click();
            await page.waitForFunction(() => storyboardFilmVoicePlayback?.audio?.currentTime > .01);
            ok(`${label} local silent dialogue decodes and plays`, await page.evaluate(() => !storyboardFilmVoicePlayback.audio.paused && storyboardFilmPlaybackState.playing));
            const voiceRetained = await page.evaluate(async ([family, mode]) => {
                const voice = storyboardFilmVoicePlayback, callsBefore = calls.audio, elapsed = voice.audio.currentTime;
                await setAppearance(family, mode === 'dark' ? 'light' : 'dark');
                return voice === storyboardFilmVoicePlayback && calls.audio === callsBefore && voice.audio.currentTime >= elapsed && !voice.audio.paused;
            }, [family, mode]);
            ok(`${label} appearance does not restart dialogue`, voiceRetained);
            await page.locator('.sd-storyboard-film-viewer-toggle').click();
            ok(`${label} native pause updates control`, await page.locator('.sd-storyboard-film-viewer-toggle').getAttribute('aria-label') === '播放');
            await page.evaluate(() => storyboardFilmPlaybackSession.seek(1));
            await page.waitForFunction(() => document.querySelector('main video')?.readyState >= 2);
            ok(`${label} motion decodes with prior voice released`, await page.evaluate(() => storyboardFilmVoicePlayback === null && activeUrls.size === 1));
            const motionRetained = await page.evaluate(async ([family, mode]) => {
                const video = document.querySelector('main video'), before = calls.media; video.currentTime = .1;
                await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
                const time = video.currentTime, url = video.src;
                await setAppearance(family, mode);
                return video === document.querySelector('main video') && video.src === url && video.currentTime === time && video.paused && video.muted && calls.media === before;
            }, [family, mode]);
            ok(`${label} paused movie frame survives palette`, motionRetained);
            await page.locator('.sd-storyboard-film-viewer-toggle').click();
            await page.waitForFunction(() => document.querySelector('main video')?.currentTime > .12);
            await page.locator('.sd-storyboard-film-viewer-toggle').click();
            ok(`${label} native movie playback advances`, await page.evaluate(() => document.querySelector('main video').paused && !storyboardFilmPlaybackState.playing));
            await page.waitForFunction(() => document.querySelector('main video')?.getAnimations().every(animation => animation.playState === 'finished'));
            ok(`${label} motion remains fully contained`, await page.evaluate(() => geometry().media));
            for (const index of [2, 3]) {
                await page.evaluate(index => storyboardFilmPlaybackSession.seek(index), index);
                await page.waitForFunction(() => document.querySelector('main img')?.complete);
                ok(`${label} alternate still ${index} fits`, await page.evaluate(() => geometry().media && activeUrls.size === 0));
            }
            if (width === 393 && ((family === 'glass' && mode === 'light') || (family === 'editorial' && mode === 'dark'))) {
                await page.screenshot({ path: fileURLToPath(new URL(`${family}-${mode}.png`, qa)), animations: 'disabled', caret: 'initial' });
            }
            await page.evaluate(() => storyboardFilmViewerEl.focus()); await page.keyboard.press('Escape');
            ok(`${label} closes all media owners`, await page.evaluate(() => !storyboardFilmViewerEl && !storyboardFilmPlaybackSession && !storyboardFilmVoicePlayback && activeUrls.size === 0));
        }
    }
    // A slow postproduction read must not reopen a closed/old-chat viewer.
    for (const action of ['close', 'change-chat']) {
        await page.evaluate(() => { window.postsBefore = calls.post; postGate = new Promise(resolve => { window.releasePost = resolve; }); window.openingFilm = storyboardOpenFilmViewer('film'); });
        await page.waitForFunction(() => calls.post > postsBefore && !storyboardFilmViewerEl);
        await page.evaluate(async action => { if (action === 'close') storyboardCloseFilmViewer(); else fixtureChat = 'other-chat'; releasePost(); postGate = null; await openingFilm; }, action);
        ok(`late postproduction after ${action} cannot mount`, await page.locator('.sd-storyboard-film-viewer').count() === 0);
        await page.evaluate(() => { storyboardCloseFilmViewer(); fixtureChat = 'film-chat'; });
    }
    // Pending media/voice reads belong to one open viewer, even when a newer
    // viewer opens before those reads finish. Resources cannot leak or revive it.
    for (const kind of ['motion', 'voice']) {
        await page.evaluate(async () => { await setAppearance('glass', 'light'); await storyboardOpenFilmViewer('film'); });
        await page.evaluate(kind => {
            window.resourcesBefore = { urls: calls.urls, releases: calls.releases, reads: calls[kind === 'motion' ? 'media' : 'audio'] };
            if (kind === 'motion') { window.mediaGate = new Promise(resolve => { window.releaseMedia = resolve; }); window.pendingMedia = storyboardFilmPlaybackSession.seek(1); }
            else { window.audioGate = new Promise(resolve => { window.releaseAudio = resolve; }); void storyboardFilmPlaybackSession.play(); }
        }, kind);
        await page.waitForFunction(kind => calls[kind === 'motion' ? 'media' : 'audio'] > resourcesBefore.reads, kind);
        await page.evaluate(async () => { storyboardCloseFilmViewer(); await storyboardOpenFilmViewer('film'); window.newOwner = storyboardFilmViewerEl; });
        await page.evaluate(async kind => {
            if (kind === 'motion') { releaseMedia(); mediaGate = null; await pendingMedia; }
            else { releaseAudio(); audioGate = null; }
        }, kind);
        await page.waitForFunction(kind => kind === 'motion' ? calls.releases > resourcesBefore.releases : storyboardFilmVoicePlayback === null, kind);
        ok(`late ${kind} cannot replace current preview`, await page.evaluate(() => storyboardFilmViewerEl === newOwner
            && document.querySelectorAll('.sd-storyboard-film-viewer').length === 1 && storyboardFilmPlaybackState.index === 0
            && !storyboardFilmPlaybackState.playing && !storyboardFilmVoicePlayback && activeUrls.size === 0));
        ok(`late ${kind} leaves no playback timers`, await page.evaluate(() => storyboardFilmSubtitleTimer === null));
        await page.evaluate(() => storyboardCloseFilmViewer());
    }
    // A missing motion can be skipped; missing speech warns once but doesn't
    // prevent images. These paths never regenerate, save or charge anything.
    await page.evaluate(async () => { window.missingMedia = true; await storyboardOpenFilmViewer('film'); await storyboardFilmPlaybackSession.seek(1); });
    ok('missing clip has a readable recoverable state', await page.evaluate(() => storyboardFilmPlaybackState.status === 'error'
        && !!document.querySelector('.sd-storyboard-film-viewer-message.is-error') && activeUrls.size === 0));
    await page.locator('.sd-storyboard-film-viewer-next').click();
    ok('next bypasses missing clip without regeneration', await page.evaluate(() => storyboardFilmPlaybackState.index === 2 && storyboardFilmPlaybackState.status === 'ready'));
    await page.evaluate(async () => { storyboardCloseFilmViewer(); missingMedia = false; window.missingAudio = true; window.noticesBefore = notices.length;
        await storyboardOpenFilmViewer('film'); void storyboardFilmPlaybackSession.play(); });
    await page.waitForFunction(() => notices.length > noticesBefore);
    ok('missing dialogue does not block the image', await page.evaluate(() => storyboardFilmPlaybackState.status === 'ready' && storyboardFilmPlaybackState.playing
        && storyboardFilmVoicePlayback === null && activeUrls.size === 0));
    await page.evaluate(async () => { await storyboardUpdateFilmViewerVoice(storyboardFilmPlaybackSession.snapshot()); await storyboardUpdateFilmViewerVoice(storyboardFilmPlaybackSession.snapshot()); });
    ok('missing dialogue warns once per preview', await page.evaluate(() => notices.length === noticesBefore + 1));
    await page.evaluate(async () => { storyboardCloseFilmViewer(); missingAudio = false; window.postFailure = true; await storyboardOpenFilmViewer('film'); });
    ok('unavailable postproduction falls back to native preview', await page.evaluate(() => storyboardFilmPlaybackState.status === 'ready'
        && storyboardFilmViewerPostproduction.mode === 'native_only' && document.querySelector('.sd-storyboard-film-viewer-subtitles').hidden));
    await page.evaluate(async () => { storyboardCloseFilmViewer(); postFailure = false; await storyboardOpenFilmViewer('film'); await storyboardFilmPlaybackSession.seek(1); });
    await page.locator('.sd-storyboard-film-viewer-toggle').click();
    await page.waitForFunction(() => storyboardFilmPlaybackState.index === 2 && storyboardFilmPlaybackState.playing);
    ok('native movie end advances to the next still', await page.evaluate(() => storyboardFilmPlaybackState.status === 'ready' && activeUrls.size === 0
        && document.querySelector('.sd-storyboard-film-viewer-stage').classList.contains('is-transition-dip_black')));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    ok('reduced motion disables transition animation', await page.evaluate(() => getComputedStyle(document.querySelector('.sd-storyboard-film-viewer-stage'), '::after').animationName === 'none'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => { storyboardCloseFilmViewer(); await appearanceSession.sync(); });
    ok('all appearance owners released', await page.evaluate(() => appearanceSession.size === 0));
    ok('all URLs released once', await page.evaluate(() => calls.urls === calls.releases && activeUrls.size === 0));
    ok('no production access', await page.evaluate(() => calls.forbidden === 0));
    ok('no page errors ' + JSON.stringify(errors), errors.length === 0); ok('no unlisted network', external === 0);
    console.log(JSON.stringify({ passed: checks.length, errors, external, counts: await page.evaluate(() => calls), checks }));
} catch (error) {
    console.error(JSON.stringify(await page.evaluate(() => ({ notices: window.notices, calls: window.calls, state: window.storyboardFilmPlaybackState?.status,
        bytes: window.clipBytes, geometry: window.storyboardFilmViewerEl ? geometry() : null, body: document.body.innerText.slice(-500) })))); throw error;
} finally { clearTimeout(deadline); await browser.close(); }
