// Synthetic host + real receipt client, native IndexedDB and production dialog.
// No real ST, original media, account credentials or external requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), errors = [], checks = []; let external = 0;
const timer = setTimeout(() => void browser.close(), 120000);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/qianmu-theme-skins.css"><div id="story-director-modal" class="open"></div>' });
        if (/^\/(?:qianmu-[a-z0-9-]+\.js|style\.css|qianmu-theme-skins\.css)$/.test(url.pathname))
            return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    }
    external++; return route.abort();
});
try {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto('https://qianmu.test/');
    const result = await page.evaluate(async () => {
        const { createGalleryCatalogStore: create } = await import('/qianmu-gallery-catalog-store.js');
        const { createGalleryDirectorySession } = await import('/qianmu-gallery-directory.js');
        const { openGalleryDirectory } = await import('/qianmu-gallery-directory-view.js');
        const { createCurrentChatGalleryReceiptClient, createChatGalleryReceiptClient, createChatGalleryRecordClient } = await import('/qianmu-chat-character-receipt-client.js');
        const { loadGalleryPreviewImage } = await import('/qianmu-gallery-preview-media.js');
        const { chatGalleryReceiptText } = await import('/qianmu-chat-gallery-receipt.js');
        const checks = [], check = (label, ok) => { if (!ok) throw Error(label); checks.push(label); };
        const ns = 'st-user:fixture', source = { ownerKey: 'char:A.png', chatKey: '同名聊天' };
        const entry = id => ({ id, kind: 'still', createdAt: 100, tags: ['海岸'] });
        const store = create(); let revision = 0;
        for (let i = 0; i < 53; i++) {
            const ownerKey = `char:Role${String(i).padStart(2, '0')}.png`;
            revision = (await store.upsert(ns, { ownerKey, chatKey: 'same' }, [entry('one')], { expectedRevision: revision })).revision;
        }
        for (let i = 0; i < 29; i++) revision = (await store.upsert(ns, { ownerKey: 'char:Role00.png', chatKey: `c${i}` }, [entry('one')], { expectedRevision: revision })).revision;
        let cursor = null, owners = [], visited = 0;
        do { const part = await store.scopes(ns, { limit: 24, cursor }); owners.push(...part.rows); visited += part.visited; cursor = part.nextCursor; } while (cursor);
        check('owner pagination has no duplicate, omission or full-record scan', owners.length === 53 && new Set(owners.map(row => row.ownerKey)).size === 53 && visited === 55);
        const p1 = await store.scopes(ns, { ownerKey: 'char:Role00.png', limit: 24 }), p2 = await store.scopes(ns, { ownerKey: 'char:Role00.png', cursor: p1.nextCursor });
        check('chat pagination jumps exact source prefixes', p1.rows.length === 24 && p1.visited === 25 && p2.rows.length === 6 && p2.visited === 6 && !p2.nextCursor);
        check('another account has no roles or leaked labels', (await store.scopes('st-user:other')).rows.length === 0);
        const before = await store.scopes(ns, { limit: 1 });
        revision = (await store.upsert(ns, source, [entry('old-missing')], { expectedRevision: revision })).revision;
        let stale = false; try { await store.scopes(ns, { cursor: before.nextCursor }); } catch (error) { stale = error.code === 'gallery_catalog_stale'; }
        check('revision changes reject stale scope pages', stale);
        for (const name of ['char:B.png', 'char:C.png', 'group:9']) revision = (await store.upsert(ns, { ownerKey: name, chatKey: source.chatKey }, [entry('same-id')], { expectedRevision: revision })).revision;
        store.close();
        const frames = Array.from({ length: 51 }, (_, i) => ({ id: `shot${i}`, createdAt: 200 + i, tags: [i % 2 ? '旅人' : '海岸'], url: '/private.png', prompt: 'PRIVATE_PROMPT' }));
        frames[50].tags.push('<img src=x onerror=alert(1)>');
        const listeners = new Map();
        window.host = { chatId: source.chatKey, characterId: 0, chat: [], chatMetadata: { story_director_liminale: { storyboardImages: frames } },
            characters: [{ avatar: 'A.png', chat: source.chatKey, name: '同名角色' }, { avatar: 'B.png', chat: source.chatKey, name: '同名角色' }], groups: [{ id: 9, chat_id: source.chatKey, name: '<img src=x>' }],
            eventSource: { on(type, handler) { const set = listeners.get(type) || new Set(); set.add(handler); listeners.set(type, set); }, removeListener(type, handler) { listeners.get(type)?.delete(handler); } } };
        window.generation = 1; window.account = ns; window.opened = null; window.receipts = []; window.readGate = null;
        window.mediaCalls=0;window.imageFail=false;window.imageGate=null;window.createdUrls=[];window.revokedUrls=[];
        const createUrl=URL.createObjectURL.bind(URL),revokeUrl=URL.revokeObjectURL.bind(URL);
        URL.createObjectURL=blob=>{const url=createUrl(blob);window.createdUrls.push(url);return url;};URL.revokeObjectURL=url=>{window.revokedUrls.push(url);revokeUrl(url);};
        const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=1800;canvas.getContext('2d').fillRect(0,0,1000,1800);
        window.previewBlob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
        async function fetchImpl(url, options) {
            const request = JSON.parse(options.body); window.receipts.push(request);
            check('metadata request never uploads source contents or generates images', !options.body.includes('PRIVATE') && /\/chat-gallery\/(receipt|record)$/.test(url));
            if (window.readGate) await window.readGate;
            if (request.target.avatar === 'B.png') return new Response(JSON.stringify({ ok: false, code: 'chat_character_receipt_missing', message: 'PRIVATE_PATH' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            const selectedFrames=request.target.avatar==='C.png'?[{id:'same-id',createdAt:100,url:'/user/images/fixture.png',tags:['历史画面']}]:frames;
            const value = chatGalleryReceiptText(selectedFrames);
            if(url.endsWith('/record'))return new Response(JSON.stringify({ok:true,version:1,expectedAccount:'st-user:'+await digest('fixture'),target:request.target,
                gallerySha256:await digest(value.text),record:selectedFrames[0],proof:'read-only-record'}),{headers:{'Content-Type':'application/json'}});
            return new Response(JSON.stringify({ ok: true, version: 1, expectedAccount: 'st-user:' + await digest('fixture'), target: request.target,
                state: 'present', gallery: { count: value.count, bytes: value.bytes, sha256: await digest(value.text) }, proof: 'read-only-snapshot' }), { headers: { 'Content-Type': 'application/json' } });
        }
        window.openFixture = (extra = {}) => {
            const root = document.getElementById('story-director-modal'); root.classList.add('open');
            window.controller = openGalleryDirectory({ parent: root, getContext: () => window.host, epoch: () => window.generation,
                locate: record => { window.opened = record.id; },
                connect: options => createGalleryDirectorySession({ ...options,
                    createClient: opts => createCurrentChatGalleryReceiptClient({ ...opts, account: async () => window.account, fetchImpl }),
                    createHistoricalClient: opts => createChatGalleryReceiptClient({ ...opts, fetchImpl }),
                    createRecordClient:opts=>createChatGalleryRecordClient({...opts,fetchImpl}),
                    loadImage:(url,opts)=>loadGalleryPreviewImage(url,{...opts,fetchImpl:async(path,options)=>{
                        if(path!=='/user/images/fixture.png'||options.redirect!=='error'||options.credentials!=='same-origin')throw Error('unexpected media access');
                        window.mediaCalls++;if(window.imageGate)await window.imageGate;
                        return window.imageFail?new Response('missing',{status:404}):new Response(window.previewBlob,{headers:{'Content-Type':'image/png'}});
                    }}),
                }), ...extra });
        };
        window.listenerCount = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
        const { createQianmuThemeSurfaceController } = await import('/qianmu-theme-surfaces.js');
        window.themeController = createQianmuThemeSurfaceController(); window.themeController.register(document.getElementById('story-director-modal'));
        window.testChecks = checks; window.openFixture(); return checks;
    });
    const dialog = page.locator('.sd-gallery-directory');
    const idle = () => page.waitForFunction(() => { const node = document.querySelector('.sd-gallery-directory fieldset'); return node && !node.disabled; });
    const click = async action => { await dialog.locator(`[data-directory-action="${action}"]`).click(); await idle(); };
    await idle();
    assert.match(await dialog.locator('footer').innerText(), /51 条静帧已收录/); checks.push('opens and indexes a verified current snapshot in the real dialog');
    await dialog.locator('[data-directory-scope]').filter({ hasText: 'char:A.png' }).click(); await idle();
    await dialog.locator('[data-directory-scope]').filter({ hasText: '同名聊天' }).click(); await idle();
    assert.equal(await dialog.locator('[data-directory-record]').count(), 24); assert.equal(await dialog.locator('img').count(), 0); checks.push('current chat page bounded to 24, tags escaped and no original media loaded');
    await dialog.locator('input[name="tag"]').fill('海岸');
    assert.equal(await dialog.locator('input[name="tag"]').inputValue(), '海岸');
    await dialog.locator('input[name="tag"]').press('Enter'); await idle();
    assert.equal(await dialog.locator('[data-directory-record]').count(), 24); await click('next');
    assert.equal(await dialog.locator('[data-directory-record]').count(), 3); checks.push('tag search and next/previous use real compound index, not a full DOM filter');
    await dialog.locator('[data-directory-record]').last().click(); await idle();
    assert.match(await dialog.locator('footer').innerText(), /原画面记录已变化或不存在/); checks.push('removed original is retained as an explicit unresolved directory reference');
    await click('previous'); await dialog.locator('[data-directory-record]').first().click(); await page.waitForFunction(() => !document.querySelector('.sd-gallery-directory'));
    assert.equal(await page.evaluate(() => window.opened), 'shot50'); assert.equal(await page.evaluate(() => window.listenerCount()), 0); checks.push('exact current record opens and closes all borrowed listeners');
    await page.evaluate(() => window.openFixture()); await idle();
    await dialog.locator('[data-directory-scope]').filter({ hasText: 'char:B.png' }).click(); await idle();
    await dialog.locator('[data-directory-scope]').first().click(); await idle();
    assert.match(await dialog.locator('.sd-directory-source').innerText(), /不存在或已移动/); assert.doesNotMatch(await dialog.innerText(), /PRIVATE_PATH/);
    assert.equal(await dialog.locator('[data-directory-record]').count(), 0); checks.push('same-named other role has separate source; missing original cannot be opened or auto-deleted');
    const hostBefore=await page.evaluate(()=>JSON.stringify(window.host.chatMetadata));
    assert.equal(await page.evaluate(()=>window.mediaCalls),0);checks.push('browsing history does not prefetch any image');
    await click('owners');await dialog.locator('[data-directory-scope]').filter({hasText:'char:C.png'}).click();await idle();
    await dialog.locator('[data-directory-scope]').first().click();await idle();
    await dialog.locator('[data-directory-history]').first().click();
    await page.waitForFunction(()=>document.querySelector('.sd-directory-image-stage img')?.naturalWidth===1000);
    assert.equal(await dialog.locator('details[open]').count(),0);assert.equal(await dialog.locator('[data-directory-record],.sd-storyboard-lightbox-delete,.sd-storyboard-lightbox-edit').count(),0);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.host.chatMetadata)),hostBefore);checks.push('historical original decodes read-only without changing current chat, closed details and no mutation controls');
    const stage=dialog.locator('.sd-directory-image-stage');await stage.hover();await page.mouse.wheel(0,-200);
    await page.waitForFunction(()=>Number(document.querySelector('.sd-directory-image-stage').dataset.scale)>1);
    await dialog.locator('[data-preview-zoom="reset"]').click();assert.equal(await stage.getAttribute('data-scale'),'1');
    await stage.evaluate(node=>{
        const send=(type,id,x)=>node.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:id,pointerType:'touch',clientX:x,clientY:150}));
        send('pointerdown',1,100);send('pointerdown',2,200);send('pointermove',2,260);send('pointerup',1,100);send('pointerup',2,260);
    });
    assert.ok(Number(await stage.getAttribute('data-scale'))>1);await dialog.locator('[data-preview-zoom="reset"]').click();checks.push('real wheel and synthetic two-pointer zoom work with one-click reset');
    for(const theme of [null,{theme:'editorial',mode:'light'},{theme:'editorial',mode:'dark'},{theme:'glass',mode:'light'},{theme:'glass',mode:'dark'}])for(const width of [320,1280]){
        await page.evaluate(theme=>window.themeController.setTheme(theme),theme);
        await page.setViewportSize({width,height:720});await dialog.locator('[data-preview-zoom="reset"]').click();
        const fits=await stage.evaluate(node=>{const img=node.querySelector('img').getBoundingClientRect();return img.width<=node.clientWidth+1&&img.height<=node.clientHeight+1;});
        assert.equal(fits,true);checks.push(`${theme?.theme||'classic'}/${theme?.mode||'default'}/${width}px portrait preview initially contains the complete image`);
    }
    await dialog.locator('[data-directory-action="preview-back"]').click();await idle();
    assert.equal(await dialog.locator('[data-directory-history]').count(),1);assert.match(await dialog.locator('h3').innerText(),/同名聊天/);
    assert.deepEqual(await page.evaluate(()=>window.createdUrls),await page.evaluate(()=>window.revokedUrls));checks.push('back keeps the selected role/chat/page and releases its blob URL');
    for(const shape of [[1800,1000],[1000,1000]]){
        await page.evaluate(async([width,height])=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').fillRect(0,0,width,height);window.previewBlob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));},shape);
        await dialog.locator('[data-directory-history]').click();await page.waitForFunction(width=>document.querySelector('.sd-directory-image-stage img')?.naturalWidth===width,shape[0]);
        for(const width of [320,1280]){
            await page.setViewportSize({width,height:720});await dialog.locator('[data-preview-zoom="reset"]').click();
            assert.equal(await stage.evaluate(node=>{const rect=node.querySelector('img').getBoundingClientRect();return rect.width<=node.clientWidth+1&&rect.height<=node.clientHeight+1;}),true);
            checks.push(`${shape.join('x')} at ${width}px keeps all image edges visible`);
        }
        await dialog.locator('[data-directory-action="preview-back"]').click();await idle();
    }
    await page.evaluate(()=>{window.imageFail=true;});await dialog.locator('[data-directory-history]').click();await idle();
    assert.match(await dialog.locator('footer').innerText(),/原图不存在/);assert.equal(await dialog.locator('img').count(),0);checks.push('missing image reports failure while keeping the directory and original reference');
    await page.evaluate(()=>{window.imageFail=false;});
    await click('owners'); await dialog.locator('[data-directory-scope]').filter({ hasText: 'char:A.png' }).click(); await idle();
    await dialog.locator('[data-directory-scope]').first().click(); await idle();
    for (const theme of [null, { theme: 'editorial', mode: 'light' }, { theme: 'editorial', mode: 'dark' }, { theme: 'glass', mode: 'light' }, { theme: 'glass', mode: 'dark' }]) for (const width of [320, 393, 1280]) {
        await page.evaluate(theme => window.themeController.setTheme(theme), theme);
        await page.setViewportSize({ width, height: width === 1280 ? 800 : 720 });
        const layout = await dialog.evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(), scroll: node.scrollWidth, client: node.clientWidth,
            overflowing: [...node.querySelectorAll('button,input')].filter(el => el.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).length }));
        assert.ok(layout.rect.left >= 0 && layout.rect.right <= width && layout.scroll <= layout.client + 1 && !layout.overflowing); checks.push(`${theme?.theme || 'classic'}/${theme?.mode || 'default'}/${width}px native dialog has no horizontal clipping`);
    }
    await page.evaluate(() => { const root = document.getElementById('story-director-modal'); root.classList.remove('open'); root.classList.add('open'); });
    await page.waitForFunction(() => !document.querySelector('.sd-gallery-directory')); checks.push('brief parent close/reopen invalidates and releases directory');
    await page.evaluate(() => window.openFixture()); await idle();
    await page.evaluate(() => { window.account = 'st-user:other'; });
    await dialog.locator('[data-directory-action="owners"]').click(); await page.waitForFunction(() => !document.querySelector('.sd-gallery-directory'));
    assert.equal(await page.evaluate(() => window.listenerCount()), 0); checks.push('account change closes rather than exposing old directory as current account');
    await page.evaluate(() => { window.account = 'st-user:fixture'; window.openFixture({ timeoutMs: 100, connect: async () => { await new Promise(resolve => setTimeout(resolve, 250)); return { close() { window.lateClosed = true; } }; } }); });
    await page.waitForFunction(() => document.querySelector('.sd-gallery-directory footer')?.textContent.includes('连接超时'));
    await page.waitForFunction(() => window.lateClosed === true); checks.push('late connection after timeout is closed and never indexes');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.sd-gallery-directory'));
    await page.evaluate(()=>window.openFixture());await idle();await dialog.locator('[data-directory-scope]').filter({hasText:'char:C.png'}).click();await idle();await dialog.locator('[data-directory-scope]').first().click();await idle();
    const beforeCalls=await page.evaluate(()=>window.mediaCalls);
    await page.evaluate(()=>{window.imageGate=new Promise(resolve=>window.releaseImage=resolve);});
    await dialog.locator('[data-directory-history]').click();await page.waitForFunction(n=>window.mediaCalls>n,beforeCalls);
    await page.keyboard.press('Escape');await page.evaluate(()=>{window.releaseImage();window.imageGate=null;});
    await page.waitForFunction(()=>window.listenerCount()===0);
    assert.deepEqual(await page.evaluate(()=>window.createdUrls),await page.evaluate(()=>window.revokedUrls));checks.push('closing during original fetch prevents late preview and releases source listeners');
    await page.evaluate(() => { window.readGate = new Promise(resolve => window.releaseGate = resolve); window.openFixture(); });
    await page.waitForFunction(() => document.querySelector('.sd-gallery-directory'));
    await page.keyboard.press('Escape'); await page.evaluate(() => { window.releaseGate(); window.readGate = null; });
    await page.waitForFunction(() => window.listenerCount() === 0); checks.push('cancel during receipt releases listeners and suppresses late repaint');
    assert.equal(external, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks: [...result, ...checks], externalRequests: external, pageErrors: errors }));
} finally { clearTimeout(timer); await browser.close(); }
