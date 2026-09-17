// Real gallery renderer + narrative binder with synthetic records only.
// No storage, ST account, remote images, metadata mutation or generation.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const names = ['renderStoryboardGallery', 'renderStoryboardGalleryKindSwitch', 'storyboardFilteredGalleryRecords',
    'storyboardUpdateGalleryNarrative', 'storyboardBindGalleryNarrative', 'storyboardGalleryGroups', 'storyboardGalleryGroupId',
    'storyboardItemCollectionIds', 'storyboardMediaSidebarMarkup', 'storyboardMediaTagEditorMarkup', 'storyboardMediaTagChipMarkup',
    'storyboardRecordStatus', 'storyboardLinkReviewParagraphs', 'storyboardCleanMessageText'];
const source = names.map(storyboardFunctionSource).join('\n');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const errors = [], checks = [], ok = (name, passed) => { assert.ok(passed, name); checks.push(name); };
const timer = setTimeout(() => { void browser.close(); }, 120000);
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;background:#dedbd5}*,*::before,*::after{box-sizing:border-box}#story-director-modal{position:fixed;inset:0;display:block;padding:0}#story-director-modal .sd-window{width:100%;height:100%;max-height:100%;max-width:100%;margin:0;padding:12px;overflow:auto;border:0;border-radius:0}</style><div id="story-director-modal" class="open sd-theme-dark"><div class="sd-window"></div></div>` });
    if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    external++; return route.abort();
});
try {
    await page.goto('https://qianmu.test/');
    await page.evaluate(async source => {
        const [utils, storyboard, model, view, session, preferences, icons, chatSource] = await Promise.all([
            import('/qianmu-storyboard-utils.js'), import('/qianmu-storyboard.js'), import('/qianmu-gallery-narrative.js'),
            import('/qianmu-gallery-narrative-view.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'), import('/qianmu-icon-renderer.js'), import('/qianmu-current-chat-source.js'),
        ]);
        const f = window.fixture = { context: { chatMetadata: {}, chat: [] }, chatKey: 'chat', writes: 0, renders: 0, records: [],
            state: { view: 'gallery', gallerySource: 'novel', gallerySearch: '', galleryTrack: 'all' } };
        f.buses = [];
        f.makeBus = () => {
            const events = new Map(), bus = {
                on(type, handler) { const rows = events.get(type) || []; rows.push(handler); events.set(type, rows); },
                removeListener(type, handler) { events.set(type, (events.get(type) || []).filter(row => row !== handler)); },
                emit(type, value) { for (const handler of [...(events.get(type) || [])]) handler(value); },
                count() { return [...events.values()].reduce((sum, rows) => sum + rows.length, 0); },
            }; f.buses.push(bus); return bus;
        };
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
        const paint = canvas.getContext('2d'); paint.fillStyle = '#627d87'; paint.fillRect(0, 0, 160, 120);
        const url = canvas.toDataURL('image/png');
        f.reset = () => {
            f.context = { chatId: 'chat', characterId: 0, characters: [{ name: '角色', avatar: 'A.png', chat: 'chat' }],
                eventSource: f.makeBus(), chatMetadata: { integrity: 'fixture-integrity' }, chat: Array.from({ length: 32 }, (_, i) => ({ mes: `开场 ${i}\n海岸 ${i}\n归途 ${i}`, name: '角色 <b>', send_date: 'date-' + i, swipe_id: 0 })) };
            f.records = []; f.chatKey = 'chat'; f.state = { view: 'gallery', gallerySource: 'novel', gallerySearch: '', galleryTrack: 'all' };
            f.context.chat.forEach((message, floor) => {
                for (let p = 0; p < 3; p++) for (let variant = 0; variant < 2; variant++) f.records.push({
                    id: `${floor}-${p}-${variant}`, groupId: `${floor}-${p}`, chatKey: 'chat', floor, swipeId: 0, createdAt: 1000 + floor * 10 + variant,
                    source: variant ? 'comfy' : 'novel', prompt: `画面 ${floor} ${p}`, url, collectionIds: variant ? [] : ['c'], tags: ['海岸'],
                    messageHash: utils.hashText(message.mes), messageRef: storyboard.createStoryboardMessageReference({ message, chatKey: 'chat', floor, now: 1 }),
                    paragraphAnchor: storyboard.createStoryboardParagraphAnchor({ chatKey: 'chat', floor, messageText: message.mes, paragraphIndex: p, paragraphText: message.mes.split('\n')[p], createdAt: 1 }),
                });
            });
            f.records.push({ id: 'unplaced', url, prompt: '仍保留', floor: 0, source: 'novel', createdAt: 1 });
            f.original = JSON.stringify(f.records);
        };
        f.reset();
        Object.assign(window, utils, view, chatSource, { storyboardProductionDeliveryPolicy: storyboard.storyboardProductionDeliveryPolicy,
            storyboardGalleryNarrative: model.createGalleryNarrativeSession(), storyboardGallerySelection: new Set(), storyboardGallerySelectMode: false,
            storyboardGalleryVisibleCount: 40, storyboardGalleryOpenCollectionId: '', storyboardGalleryInspectorRecordId: '', storyboardGalleryKind: 'stills',
            storyboardAdmissionEpoch: 1, settings: { theme: 'dark' }, STORYBOARD_SOURCES: { novel: { label: 'NAI' }, comfy: { label: 'Comfy' } },
            storyboardState: () => f.state, ctx: () => f.context, getChatKey: () => f.chatKey, storyboardGalleryRecords: () => f.records,
            storyboardGalleryCollections: () => [{ id: 'c', name: '合集' }], storyboardSafeUrl: value => value || '', formatDateTime: value => String(value),
            saveSettings: () => { f.writes++; }, saveMetadata: () => { f.writes++; }, renderStoryboardVideoGallery: () => '', renderStoryboardFilmGallery: () => '',
        });
        (0, eval)(source);
        window.renderModal = () => {
            f.renders++; const root = document.getElementById('story-director-modal'); root.querySelector('.sd-window').innerHTML = renderStoryboardGallery(f.state);
            icons.applyQianmuIcons(root); storyboardBindGalleryNarrative(root);
        };
        window.appearance = session.createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(document.getElementById('story-director-modal'));
        window.setAppearance = async (family, mode) => { settings.appearance = preferences.updateAppearancePreferences(settings, { family, mode }); await appearance.sync(); };
        renderModal();
    }, source);
    ok('saved model filter no longer hides Comfy records; new directory starts collapsed', await page.evaluate(() =>
        storyboardFilteredGalleryRecords(fixture.state).length === 193 && !document.querySelector('.sd-storyboard-gallery-source') && !document.querySelector('.sd-gallery-narrative details').open));
    await page.locator('.sd-gallery-narrative summary').click();
    ok('directory has bounded first page', await page.locator('.sd-gallery-narrative-rows>button').count() === 12);
    await page.locator('[data-gallery-narrative-action="next"]').click();
    ok('pagination uses stable source rows', await page.locator('.sd-gallery-narrative-rows>button').first().textContent().then(text => text.includes('第 20 层')));
    await page.locator('[data-gallery-narrative-search]').fill('开场 31');
    ok('search resets paging without rerendering or writing the media gallery', await page.evaluate(() => fixture.renders === 1 && fixture.writes === 0)
        && await page.locator('.sd-gallery-narrative-rows>button').count() === 1);
    await page.locator('.sd-gallery-narrative-rows>button').click();
    ok('floor selection shows its three paragraph rows and six images', await page.evaluate(() => storyboardFilteredGalleryRecords(fixture.state).length === 6)
        && await page.locator('.sd-gallery-narrative-rows>button').count() === 3);
    await page.locator('.sd-gallery-narrative-rows>button').nth(1).click();
    ok('paragraph selection includes both models and preserves grouped variants', await page.evaluate(() =>
        storyboardFilteredGalleryRecords(fixture.state).length === 2 && document.querySelector('.sd-storyboard-stack-count')?.textContent === '2'));
    await page.evaluate(() => { fixture.state.gallerySearch = 'not-found'; fixture.state.galleryTrack = 'second_camera'; storyboardGalleryOpenCollectionId = 'c'; storyboardGallerySelection.add('unplaced'); storyboardGallerySelectMode = true; renderModal(); });
    ok('normal filters still intersect source selection', await page.evaluate(() => storyboardFilteredGalleryRecords(fixture.state).length === 0));
    await page.locator('[data-gallery-narrative-action="all"]').click();
    ok('all-in-paragraph clears unrelated filters and stale bulk selection', await page.evaluate(() =>
        storyboardFilteredGalleryRecords(fixture.state).length === 2 && !fixture.state.gallerySearch && fixture.state.galleryTrack === 'all'
        && !storyboardGalleryOpenCollectionId && !storyboardGallerySelection.size && !storyboardGallerySelectMode));
    await page.evaluate(() => { storyboardGalleryInspectorRecordId = '31-1-0'; renderModal(); });
    await page.locator('[data-gallery-paragraph-record]').click();
    ok('detail shortcut opens the same verified paragraph without changing source data', await page.evaluate(() =>
        storyboardGalleryNarrative.selected.label.includes('第 2 段') && JSON.stringify(fixture.records) === fixture.original));

    ok('paragraph choice collapses the directory and restores keyboard focus', await page.evaluate(() =>
        !document.querySelector('.sd-gallery-narrative details').open && document.activeElement?.dataset.galleryNarrativeAction === 'clear'));
    await page.locator('.sd-gallery-narrative summary').click();

    for (const [family, mode] of [['classic', 'dark'], ['editorial', 'light'], ['editorial', 'dark'], ['glass', 'light'], ['glass', 'dark']]) {
        for (const width of [320, 393, 1100]) {
            await page.setViewportSize({ width, height: 898 }); await page.evaluate(async ({ family, mode }) => { await setAppearance(family, mode); }, { family, mode });
            ok(`${family}/${mode} actual appearance is mounted`, await page.evaluate(({ family, mode }) => {
                const root = document.getElementById('story-director-modal');
                return family === 'classic' ? !root.dataset.qmTheme : root.dataset.qmTheme === family && root.dataset.qmMode === mode;
            }, { family, mode }));
            const geometry = await page.locator('.sd-gallery-narrative').evaluate(area => {
                const r = area.getBoundingClientRect(); return { bounds: r.left >= 0 && r.right <= innerWidth + 1, overflow: area.scrollWidth <= area.clientWidth + 1,
                    rows: [...area.querySelectorAll('.sd-gallery-narrative-rows>button')].every(button => button.getBoundingClientRect().width > 100) };
            });
            ok(`${family}/${mode}/${width} directory remains inside the panel: ${JSON.stringify(geometry)}`, Object.values(geometry).every(Boolean));
            const tools = await page.locator('.sd-storyboard-gallery-tools').evaluate(node => ({ display: getComputedStyle(node).display,
                width: node.clientWidth, search: node.querySelector('input').getBoundingClientRect().width, columns: getComputedStyle(node).gridTemplateColumns }));
            ok(`${family}/${mode}/${width} gallery search remains usable: ${JSON.stringify(tools)}`, width > 640 || tools.search >= tools.width - 2);
        }
    }
    await page.setViewportSize({ width: 393, height: 898 }); await page.evaluate(async () => { await setAppearance('glass', 'light'); });
    const qa = new URL('../dist/local-qa/gallery-narrative/', import.meta.url); await mkdir(qa, { recursive: true });
    await page.locator('.sd-gallery-narrative').evaluate(area => { area.closest('.sd-window').scrollTop = 0; });
    await page.screenshot({ path: fileURLToPath(new URL('glass-light-393.png', qa)), animations: 'disabled' });

    await page.evaluate(() => { fixture.context.chat[31].mes += ' changed'; renderModal(); });
    ok('edited reply leaves an explicit stale selection and no accidental replacement images', await page.evaluate(() =>
        storyboardGalleryNarrative.selected.stale && storyboardFilteredGalleryRecords(fixture.state).length === 0)
        && await page.locator('.sd-gallery-narrative-selection').textContent().then(text => text.includes('原位置已变化')));
    await page.locator('.sd-gallery-narrative-selection [data-gallery-narrative-action="clear"]').click();
    ok('clearing stale selection preserves original images', await page.evaluate(() => storyboardFilteredGalleryRecords(fixture.state).length === 193));
    await page.locator('[data-gallery-narrative-key="unplaced"]').click();
    ok('unlocated shelf contains old and edited-source images', await page.evaluate(() => storyboardFilteredGalleryRecords(fixture.state).length === 7));
    await page.locator('.sd-gallery-narrative-selection [data-gallery-narrative-action="clear"]').click();
    const ime = await page.evaluate(() => {
        const input = document.querySelector('[data-gallery-narrative-search]'); input.focus();
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.value = '开场 30';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); const same = input === document.activeElement && input.isConnected;
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); return same;
    });
    ok('Chinese composition stays attached until committed', ime && await page.locator('.sd-gallery-narrative-rows>button').count() === 1);

    ok('directory-only repaint releases old source listeners rather than accumulating them', await page.evaluate(() => fixture.buses.reduce((sum,bus) => sum + bus.count(), 0) === 5));
    for (const change of ['integrity', 'rename', 'deletion', 'same-name-character', 'unrelated-rename', 'unrelated-deletion', 'unrelated-trailing-load']) {
        const result = await page.evaluate(async change => {
            fixture.reset(); const root = document.getElementById('story-director-modal'); root.classList.add('open'); renderModal();
            const button = document.querySelector('.sd-gallery-narrative-rows>button'), count = fixture.renders;
            if (change === 'integrity') fixture.context.chatMetadata.integrity = 'new-incarnation';
            if (change === 'rename') fixture.context.eventSource.emit('chat_renamed', { avatarId: 'A.png', oldFileName: 'chat.jsonl', newFileName: 'untrusted?.jsonl' });
            if (change === 'deletion') fixture.context.eventSource.emit('chat_deleted', 'chat');
            if (change === 'same-name-character') { fixture.context.characters.push({ name: '角色', avatar: 'B.png', chat: 'chat' }); fixture.context.characterId = 1; }
            if (change === 'unrelated-rename') fixture.context.eventSource.emit('chat_renamed', { avatarId: 'Other.png', oldFileName: 'chat.jsonl', newFileName: 'elsewhere.jsonl' });
            if (change === 'unrelated-deletion') fixture.context.eventSource.emit('chat_deleted', 'other');
            if (change === 'unrelated-trailing-load') fixture.context.eventSource.emit('chat_loaded', { detail: { id: 0 } });
            button.click(); await new Promise(resolve => setTimeout(resolve, 0));
            return { unchanged: fixture.renders === count, disabled: button.disabled, listeners: fixture.context.eventSource.count(),
                dataUnchanged: JSON.stringify(fixture.records) === fixture.original };
        }, change);
        const unrelated = change.startsWith('unrelated');
        ok(`${change} keeps source guards read-only and owner-specific`, result.dataUnchanged && (unrelated ? !result.unchanged && result.listeners === 5 : result.unchanged && result.disabled && result.listeners === 0));
    }
    for (const change of ['close-root', 'remove-root', 'remove-ancestor', 'replace-directory', 'rebind']) {
        const result = await page.evaluate(async change => {
            fixture.reset(); const root = document.getElementById('story-director-modal'); root.classList.add('open');
            let wrapper; if (change === 'remove-ancestor') { wrapper = document.createElement('div'); document.body.append(wrapper); wrapper.append(root); }
            renderModal(); const bus = fixture.context.eventSource;
            if (change === 'close-root') root.classList.remove('open');
            if (change === 'remove-root') root.remove();
            if (change === 'remove-ancestor') wrapper.remove();
            if (change === 'replace-directory') root.querySelector('.sd-gallery-narrative').remove();
            if (change === 'rebind') { storyboardBindGalleryNarrative(root); storyboardBindGalleryNarrative(root); }
            await new Promise(resolve => setTimeout(resolve, 0)); const count = bus.count();
            if (change === 'remove-root' || change === 'remove-ancestor') document.body.append(root); root.classList.add('open'); return count;
        }, change);
        ok(`${change} releases exactly the ended scope's event subscriptions`, result === (change === 'rebind' ? 5 : 0));
    }
    ok('unresolved host source disables directory actions without hiding images or making writes', await page.evaluate(() => {
        fixture.reset(); fixture.context.characterId = undefined; renderModal();
        return [...document.querySelectorAll('.sd-gallery-narrative button, .sd-gallery-narrative input')].every(node => node.disabled)
            && document.querySelector('.sd-gallery-narrative-note').textContent.includes('来源尚未就绪') && document.querySelectorAll('.sd-storyboard-gallery-card').length > 0
            && fixture.context.eventSource.count() === 0 && fixture.writes === 0;
    }));

    for (const change of ['chat', 'account', 'closed', 'detached', 'reply-before-click']) {
        const result = await page.evaluate(change => {
            fixture.reset(); document.getElementById('story-director-modal').classList.add('open'); renderModal();
            const button = document.querySelector('.sd-gallery-narrative-rows>button'), count = fixture.renders;
            if (change === 'chat') fixture.chatKey = 'other';
            if (change === 'account') storyboardAdmissionEpoch++;
            if (change === 'closed') document.getElementById('story-director-modal').classList.remove('open');
            if (change === 'detached') document.querySelector('.sd-gallery-narrative').remove();
            if (change === 'reply-before-click') fixture.context.chat[31].mes += ' changed';
            button.click();
            return change === 'reply-before-click' ? storyboardGalleryNarrative.selected === null : fixture.renders === count;
        }, change);
        ok(`${change} rejects stale directory actions`, result);
    }
    ok('no production writes, page errors or external requests', await page.evaluate(() => fixture.writes === 0) && errors.length === 0 && external === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors, externalRequests: external, screenshots: fileURLToPath(qa) }, null, 2));
} finally { clearTimeout(timer); await browser.close(); }
