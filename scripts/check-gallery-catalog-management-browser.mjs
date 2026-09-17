// Isolated native IndexedDB and production dialog. Synthetic references only;
// never opens a real ST page/database, media file or external endpoint.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), errors = []; let external = 0;
const timer = setTimeout(() => void browser.close(), 180000);
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://qianmu.test') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/qianmu-theme-skins.css"><div id="story-director-modal" class="open"><button id="anchor">管理目录</button></div>' });
        if (/^\/(?:qianmu-[a-z0-9-]+\.js|style\.css|qianmu-theme-skins\.css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url)) });
    }
    external++; return route.abort();
});
try {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__setFixtureViewport', width => page.setViewportSize({ width, height: 800 })); await page.goto('https://qianmu.test/');
    const result = await page.evaluate(async () => {
        const { createGalleryCatalogStore: create } = await import('/qianmu-gallery-catalog-store.js');
        const { createGalleryCatalogManagement: manage } = await import('/qianmu-gallery-catalog-management.js');
        const { openGalleryCatalogManagement: open } = await import('/qianmu-gallery-catalog-management-view.js');
        const checks = [], check = (name, ok) => { if (!ok) throw Error(name); checks.push(name); };
        const rejects = async (name, fn) => { let error; try { await fn(); } catch (e) { error = e; } check(name, Boolean(error)); return error; };
        const ns = 'st-user:alice', other = 'st-user:bob', a = { ownerKey: 'char:A.png', chatKey: 'same' }, b = { ownerKey: 'char:B.png', chatKey: 'same' };
        const row = (id, kind = 'still') => ({ id, kind, createdAt: 100, tags: ['海岸'] });
        const store = create(), peer = create();
        async function seed(namespace, source, amount, prefix = 'row') {
            let head = await store.usage(namespace);
            for (let i = 0; i < amount; i += 200) head = await store.upsert(namespace, source, Array.from({ length: Math.min(200, amount - i) }, (_, j) => row(`${prefix}-${String(i + j).padStart(5,'0')}`, j % 2 ? 'motion' : 'still')), { expectedRevision: head.revision });
            return head;
        }
        await seed(ns, a, 425); await seed(ns, b, 3); await seed(ns, { ...a, chatKey: 'second' }, 2); await seed(other, a, 7);
        const start = await store.usage(ns), inspected = await store.inspectPage(ns, a);
        check('inspection reads at most 200 rows and returns a revision-bound cursor', inspected.count === 200 && inspected.nextCursor.revision === start.revision);
        await rejects('scope cursor cannot cross same-named roles', () => store.inspectPage(ns, { ...b, cursor: inspected.nextCursor }));
        await rejects('scope cursor cannot cross accounts', () => store.inspectPage(other, { ...a, cursor: inspected.nextCursor }));
        await rejects('unconfirmed scope removal cannot write', () => store.clearScopeBatch(ns, a, { expectedRevision: start.revision }));
        let checksToAbort = 0;
        await rejects('in-transaction invalidation aborts all deletes in that batch', () => store.clearScopeBatch(ns, a, { expectedRevision: start.revision, confirmed: true, isCurrent: () => ++checksToAbort < 9 }));
        check('aborted batch retains exact count bytes and revision', JSON.stringify(await store.usage(ns)) === JSON.stringify(start));
        let account = ns, valid = true;
        const options = { resolveNamespace: async () => account, isCurrent: () => valid };
        const session = await manage(options), plan = await session.inspect(a);
        check('exact chat plan counts still and motion references but excludes siblings', plan.count === 425);
        const stale = await session.inspect(b); await seed(ns, b, 1, 'new');
        await rejects('concurrent writer invalidates preview before any delete', () => session.clear(stale, { confirmed: true }));
        check('concurrent change preserves the selected chat references', (await session.inspect(b)).count === 4);
        const clearPlan = await session.inspect(a), progress = [];
        const result = await session.clear(clearPlan, { confirmed: true, onProgress: value => progress.push(value.removed) });
        check('complete scope clear uses 200 item batches with honest progress', result.removed === 425 && progress.join() === '200,400,425');
        check('same-named role and other chat remain', (await session.inspect(b)).count === 4 && (await session.inspect({ ...a, chatKey: 'second' })).count === 2);
        check('other account count and bytes remain', (await store.usage(other)).count === 7);
        await seed(ns, a, 425);
        let switchOnYield = false;
        const controlled = await manage({ ...options, yieldTask: async () => { if (switchOnYield) account = other; } });
        const controlledPlan = await controlled.inspect(a); switchOnYield = true;
        const interruption = await rejects('account change between batches stops subsequent writes', () => controlled.clear(controlledPlan, { confirmed: true }));
        check('partial result reports only committed batch', interruption.removed === 200); account = ns;
        check('unprocessed references remain after interruption', (await session.inspect(a)).count === 225);
        const ownerPlan = await session.inspect({ ownerKey: a.ownerKey });
        await session.clear(ownerPlan, { confirmed: true });
        check('owner scope clears its two chats and not a same-named sibling role', (await session.inspect({ ownerKey: a.ownerKey })).count === 0 && (await session.inspect(b)).count === 4);
        await seed(ns, a, 225); await seed(ns, { ...a, chatKey: 'second' }, 2);
        session.close(); controlled.close();

        // Larger synthetic scan: no retained key/row list and event-loop yields.
        const largeNs = 'st-user:large'; await seed(largeNs, a, 10000); let yields = 0, maxProgress = 0;
        const large = await manage({ resolveNamespace: async () => largeNs, yieldTask: async () => { yields++; await new Promise(resolve => setTimeout(resolve, 0)); } });
        const largePlan = await large.inspect({}, value => { maxProgress = value.count; });
        check('10k scope scan is paged and yields between batches', largePlan.count === 10000 && maxProgress === 10000 && yields === 49);
        large.close();

        const longOwner = 'char:Long-' + 'x'.repeat(800) + '.png', longChat = 'zz-' + 'y'.repeat(800);
        for (let i = 0; i < 28; i++) await seed(ns, { ownerKey: longOwner, chatKey: `chat-${String(i).padStart(2,'0')}` }, 1);
        await seed(ns, { ownerKey: longOwner, chatKey: longChat }, 1);
        for (let i = 0; i < 27; i++) await seed(ns, { ownerKey: `char:P${String(i).padStart(2,'0')}.png`, chatKey: 'same' }, 1);

        const anchor = document.getElementById('anchor'), parent = anchor.parentElement;
        const wait = async predicate => { for (let i = 0; i < 600; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('view did not settle'); };
        const dialog = () => parent.querySelector('dialog'), ready = () => dialog()?.querySelector('fieldset')?.disabled === false;
        const click = action => dialog().querySelector(`[data-catalog-action="${action}"]`).click();
        let active = open({ anchor, ...options, getContext: () => ({ characters: [{ avatar: 'A.png', name: 'Alice' }, { avatar: 'B.png', name: 'Bob' }] }) });
        await wait(ready);
        check('manager opens in existing host and requires an explicit second confirmation', dialog().textContent.includes('图库目录管理') && !dialog().querySelector('[data-catalog-action="confirm"]'));
        const choose = text => [...dialog().querySelectorAll('[data-catalog-scope]')].find(node => node.textContent.includes(text)).click();
        choose('Bob'); await wait(ready); choose('same'); await wait(ready);
        check('role then chat selection displays only four matching references', /4 条目录引用/.test(dialog().textContent) && dialog().textContent.includes('char:B.png'));
        click('clear'); await wait(ready);
        check('confirmation labels exact scope and original preservation', dialog().textContent.includes('原件保留') && Boolean(dialog().querySelector('[data-catalog-action="confirm"]')));
        click('cancel'); await wait(ready); check('back from confirmation is not deletion', (await store.inspectPage(ns, b)).count === 4);
        click('clear'); await wait(ready); click('confirm'); await wait(ready);
        check('confirmed native dialog action clears only chosen chat', (await store.inspectPage(ns, b)).count === 0 && /已清除 4 条/.test(dialog().textContent) && (await store.inspectPage(ns, a)).count === 200);
        click('all'); await wait(ready); check('owner chooser shows a bounded 24 row page', dialog().querySelectorAll('[data-catalog-scope]').length === 24);
        click('next'); await wait(ready); check('owner chooser next page does not repeat first page', dialog().querySelectorAll('[data-catalog-scope]').length === 5 && !dialog().textContent.includes('char:A.png'));
        click('previous'); await wait(ready); choose('char:Long-'); await wait(ready); check('chat chooser has bounded pagination', dialog().querySelectorAll('[data-catalog-scope]').length === 24);
        click('next'); await wait(ready); choose('zz-'); await wait(ready);
        check('long chat identity remains exact rather than truncated or merged', dialog().textContent.includes(longChat));
        const { createQianmuThemeSurfaceController } = await import('/qianmu-theme-surfaces.js');
        const themeController = createQianmuThemeSurfaceController(); themeController.register(parent);
        for (const [theme, mode] of [['classic','light'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']]) {
            themeController.setTheme(theme === 'classic' ? null : { theme, mode });
            for (const width of [320,1280]) {
                await window.__setFixtureViewport(width);
                await new Promise(resolve => requestAnimationFrame(resolve));
                const rect = dialog().getBoundingClientRect();
                const main = dialog().querySelector('main');
                check(`${theme}/${mode}/${width} manager has no horizontal clipping`, dialog().scrollWidth <= dialog().clientWidth + 1 && main.scrollWidth <= main.clientWidth + 1 && rect.left >= 0 && rect.right <= width);
            }
        }
        click('close'); await active.finished; check('closing restores focus and removes dialog', !dialog() && document.activeElement === anchor);
        active = open({ anchor, ...options }); await wait(ready); parent.classList.remove('open'); parent.classList.add('open'); await active.finished;
        check('brief parent close/reopen cancels rather than retaining authorization', !dialog());
        active = open({ anchor, ...options }); await wait(ready); account = other; click('refresh'); await active.finished; account = ns;
        check('account change closes the old directory without showing its labels as the new account', !dialog());
        let lateClosed = false, release;
        active = open({ anchor, ...options, timeoutMs: 100, connect: () => new Promise(resolve => release = resolve) });
        await wait(() => dialog()?.textContent.includes('连接超时')); release({ close() { lateClosed = true; } }); await new Promise(resolve => setTimeout(resolve, 0));
        check('timed-out opening explains failure and closes a late session without touching catalog', lateClosed && dialog().querySelector('fieldset').disabled);
        click('close'); await active.finished;
        let closeOnYield = false;
        active = open({ anchor, resolveNamespace: async () => largeNs, connect: options => manage({ ...options, yieldTask: async () => { if (closeOnYield) active.close(); } }) });
        await wait(ready); click('clear'); await wait(ready); closeOnYield = true; click('confirm'); await active.finished;
        await new Promise(resolve => setTimeout(resolve, 30));
        check('closing real manager mid-clean stops after its committed 200 item batch', (await store.usage(largeNs)).count === 9800 && !dialog());
        const all = await manage({ resolveNamespace: async () => ns }), allPlan = await all.inspect();
        await all.clear(allPlan, { confirmed: true });
        check('all-account reset leaves a revisioned empty index and preserves other accounts', (await store.usage(ns)).count === 0 && (await store.usage(ns)).revision > 0 && (await store.usage(other)).count === 7 && (await store.usage(largeNs)).count === 9800);
        all.close();
        store.close(); peer.close(); return { checks, productionWrites: false, originalMediaAccess: false };
    });
    assert.deepEqual(errors, []); assert.equal(external, 0); console.log(JSON.stringify({ ...result, pageErrors: errors, externalRequests: external }));
} finally { clearTimeout(timer); await context.close(); await browser.close(); }
