// Isolated DOM + real client checks. API responses are synthetic, never a live ST account.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], allowed = new Set(['qianmu-text-collection.js', 'qianmu-text-collection-view.js', 'qianmu-notes-sync-contract.js', 'qianmu-text-collection-backup.js', 'qianmu-json-input.js']);
for(const file of ['floor','capture','session','client','sync-contract','bulk-contract'])allowed.add(`qianmu-text-collection-${file}.js`);
const writes=[];let apiMode='ok',held;
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if(url.origin==='https://qianmu.test'&&url.pathname==='/api/plugins/qianmu-tts/text-collections/write'&&route.request().method()==='POST'){
        const request=route.request().postDataJSON();writes.push(request);
        assert.equal(route.request().headers()['x-csrf-token'],'fixture-only');
        if(apiMode==='missing')return route.fulfill({status:404,contentType:'application/json',body:'{}'});
        if(apiMode==='fail')return route.abort('failed');
        const body=JSON.stringify({ok:true,version:1,expectedAccount:request.expectedAccount,libraryRevision:1,mutationId:request.mutationId,id:apiMode==='wrong'?'wrong-id':request.id,revision:1,updatedAt:request.record.updatedAt});
        const release=()=>route.fulfill({contentType:'application/json',body}).catch(()=>{});
        if(apiMode==='hold'){held=release;return;}return release();
    }
    if (url.origin === 'https://qianmu.test' && route.request().method() === 'GET') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><button id="floor-bookmark">收藏</button><main id="fixture"></main></body></html>' });
        const file = url.pathname.slice(1);
        if(file==='qianmu-text-collection.css')return route.fulfill({contentType:'text/css',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
        if (allowed.has(file)) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
    }
    external++; return route.abort();
});
const action = name => page.locator(`[data-collection-action="${name}"]`);
try {
    await page.goto('https://qianmu.test/');
    await page.addStyleTag({ content: await readFile(new URL('../style.css', import.meta.url), 'utf8') });
    await page.addStyleTag({ content: await readFile(new URL('../qianmu-text-collection.css', import.meta.url), 'utf8') });
    await page.evaluate(async () => {
        const contract = await import('./qianmu-text-collection.js');
        const ui = await import('./qianmu-text-collection-view.js');
        const fixture = window.fixture = { ...contract, ...ui, writes: [], mode: 'ok', current: true, selectionEvents: 0 };
        // Stand-in for another excerpt plugin: it remains uninhibited even while our dialog is open.
        document.addEventListener('selectionchange', () => { fixture.selectionEvents++; });
        fixture.raw = '未选前文\r\n记住这一刻😀，还有你。\r未选后文 <img src=x onerror="window.injected=true">';
        fixture.source = contract.captureTextCollectionSource({ account: 'st-user:' + 'a'.repeat(64), chatId: 'chat-1', messageId: 4, replyId: 'reply-a', charName: '<CHAR>', userName: 'USER', text: fixture.raw });
        fixture.open = () => {
            fixture.current = true; fixture.completed = 'pending'; fixture.writes = [];
            fixture.host = document.createElement('section'); fixture.host.className = 'sd-theme-dark';
            document.getElementById('fixture').append(fixture.host);
            fixture.session = ui.openTextCollectionCapture({ parent: fixture.host, source: fixture.source, isCurrent: () => fixture.current,
                onSave: async (record, { signal }) => {
                    fixture.writes.push(record); fixture.signal = signal;
                    if (fixture.mode === 'fail') throw Error('隔离保存失败，保留草稿');
                    if (fixture.mode === 'wrong') return { id: 'wrong', revision: 1 };
                    if (fixture.mode === 'wait') return new Promise(resolve => { fixture.release = () => resolve({ id: record.id, revision: record.revision }); });
                    return { id: record.id, revision: record.revision };
                } });
            fixture.session.finished.then(result => { fixture.completed = result; });
        };
        document.getElementById('floor-bookmark').onclick = () => fixture.open();
    });
    assert.equal(await page.locator('dialog').count(), 0);
    await page.evaluate(() => { document.dispatchEvent(new Event('selectionchange')); });
    assert.equal(await page.locator('dialog').count(), 0);
    checks.push('import and global selection events never open a collector or capture outside text');

    await page.locator('#floor-bookmark').click();
    assert.equal(await page.locator('[data-collection-text]').isVisible(), false);
    await action('full').click();
    assert.equal(await page.locator('[data-collection-text]').inputValue(), await page.evaluate(() => fixture.raw.replace(/\r\n?/g, '\n')));
    await action('save').click();
    await page.waitForFunction(() => fixture.completed !== 'pending');
    let result = await page.evaluate(() => ({ saved: fixture.writes[0], completed: fixture.completed, injected: !!window.injected }));
    assert.equal(result.saved.text, await page.evaluate(() => fixture.raw));
    assert.equal(result.completed.id, result.saved.id); assert.equal(result.injected, false);
    assert.equal(Object.hasOwn(result.saved.source, 'text'), false);
    checks.push('explicit full mode preserves exact text, not HTML, and requires matching save acknowledgement');

    await page.evaluate(() => { fixture.mode = 'fail'; fixture.open(); });
    await action('selection').click();
    assert.equal(await action('save').isDisabled(), true);
    const beforeSelection = await page.evaluate(() => fixture.selectionEvents);
    await page.locator('[data-collection-text]').evaluate(input => {
        input.focus(); const start = input.value.indexOf('记住');
        input.setSelectionRange(start, start + '记住这一刻😀，还有你。'.length);
        input.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await page.waitForFunction(before => fixture.selectionEvents > before, beforeSelection);
    await action('save').click();
    await page.waitForFunction(() => document.querySelector('[data-collection-status]').textContent.includes('未确认保存成功'));
    const failedId = await page.evaluate(() => fixture.writes[0].id);
    assert.equal(await page.evaluate(() => fixture.writes[0].text), '记住这一刻😀，还有你。');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fixture.writes[0])), /未选前文|未选后文/);
    await page.evaluate(() => { fixture.mode = 'ok'; });
    await action('save').click(); await page.waitForFunction(() => fixture.completed !== 'pending');
    assert.equal(await page.evaluate(() => fixture.writes[1].id), failedId);
    checks.push('selection maps normalized textarea offsets to CRLF/CR originals, survives button focus, excludes unselected text and retries the same identity');

    await page.evaluate(() => { fixture.mode = 'wrong'; fixture.open(); });
    await action('full').click(); await action('save').click();
    await page.waitForFunction(() => document.querySelector('[data-collection-action="save"]')?.disabled === false);
    assert.equal(await page.evaluate(() => fixture.completed), 'pending');
    await action('cancel').click();
    checks.push('mismatched acknowledgement never claims a successful save');

    await page.evaluate(() => { fixture.mode = 'wait'; fixture.open(); });
    await action('full').click(); await action('save').click();
    await page.waitForFunction(() => typeof fixture.release === 'function');
    await page.evaluate(() => document.querySelector('[data-collection-action="save"]').click());
    assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    await action('cancel').click();
    assert.equal(await page.evaluate(() => fixture.signal.aborted), true);
    await page.evaluate(async () => { fixture.release(); await fixture.session.finished; });
    assert.equal(await page.evaluate(() => fixture.completed), null);
    assert.equal(await page.locator('dialog').count(), 0);
    checks.push('pending saves are single-flight; cancel aborts and late success cannot reopen or claim completion');

    for (const reason of ['account', 'parent']) {
        await page.evaluate(() => { fixture.mode = 'wait'; fixture.release = null; fixture.open(); });
        await action('full').click(); await action('save').click();
        await page.waitForFunction(() => typeof fixture.release === 'function');
        await page.evaluate(reason => { if (reason === 'parent') fixture.host.remove(); else fixture.current = false; fixture.release(); }, reason);
        await page.waitForFunction(() => fixture.completed !== 'pending');
        assert.equal(await page.evaluate(() => fixture.completed), null);
        checks.push(`${reason} changes reject late save results without adopting another chat/account`);
    }

    await page.evaluate(() => {
        fixture.uuidDescriptor = Object.getOwnPropertyDescriptor(window.crypto, 'randomUUID');
        Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: undefined });
        fixture.mode = 'ok'; fixture.open();
    });
    await action('full').click(); await action('save').click();
    await page.waitForFunction(() => fixture.completed !== 'pending');
    assert.equal(await page.evaluate(() => fixture.completed.id), await page.evaluate(() => fixture.writes[0].id));
    await page.evaluate(() => {
        if (fixture.uuidDescriptor) Object.defineProperty(window.crypto, 'randomUUID', fixture.uuidDescriptor);
        else delete window.crypto.randomUUID;
    });
    checks.push('secure getRandomValues fallback creates an identity when randomUUID is unavailable');

    await page.evaluate(() => {
        fixture.originalSource = fixture.source;
        fixture.source = fixture.captureTextCollectionSource({ ...fixture.source, text: 'AAA\r\nB😀\r\nC\rD\r\nEND' });
        fixture.open();
    });
    await action('selection').click();
    await page.locator('[data-collection-text]').evaluate(input => {
        input.focus(); input.setSelectionRange(input.value.indexOf('B'), input.value.indexOf('END'));
        input.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await action('save').click(); await page.waitForFunction(() => fixture.completed !== 'pending');
    assert.equal(await page.evaluate(() => fixture.writes[0].text), 'B😀\r\nC\rD\r\n');
    await page.evaluate(() => { fixture.source = fixture.originalSource; });
    checks.push('a selection crossing multiple CRLFs and a lone CR preserves exact original line breaks');

    for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(() => { fixture.mode = 'ok'; fixture.open(); });
        await action('selection').click();
        const layout = await page.locator('dialog').evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth }));
        assert.ok(layout.width <= width && layout.scroll <= layout.client + 1, JSON.stringify(layout));
        await action('cancel').click();
        await page.evaluate(() => {
            document.getElementById('fixture').replaceChildren();
            fixture.rows = document.createElement('div'); document.getElementById('fixture').append(fixture.rows);
            const source = fixture.captureTextCollectionSource({ ...fixture.source, charName: '很长的角色名字'.repeat(15), userName: '<script>window.injected=true</script>', text: fixture.raw.repeat(4) });
            fixture.record = fixture.createTextCollection({ id: 'saved-row', source, mode: 'full', createdAt: Date.UTC(2026, 8, 19, 5) });
            fixture.renderTextCollectionRows({ container: fixture.rows, records: [fixture.record], onOpen: record => { fixture.opened = record.id; } });
        });
        const row = page.locator('[data-collection-id]');
        const rendered = await row.evaluate(node => {
            const preview = node.querySelector('[data-collection-preview]');
            return { label: node.querySelector('[data-collection-label]').textContent, preview: preview.textContent, style: getComputedStyle(preview).textOverflow,
                wrap: getComputedStyle(preview).whiteSpace, width: node.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth, injected: !!window.injected };
        });
        assert.match(rendered.label, / & .*2026-09-19/); assert.doesNotMatch(rendered.preview, /[\r\n]/);
        assert.equal(rendered.style, 'ellipsis'); assert.equal(rendered.wrap, 'nowrap');
        assert.ok(rendered.width <= width && rendered.scroll <= width + 1, JSON.stringify(rendered));
        assert.equal(rendered.injected, false);
        await row.click(); assert.equal(await page.evaluate(() => fixture.opened), 'saved-row');
        checks.push(`${width}px: bounded dialog and two-line name/date plus ellipsis rows render without overflow or markup execution`);
    }
    result = await page.evaluate(() => {
        const mutable = JSON.parse(JSON.stringify(fixture.record)), original = mutable.text;
        const opened = [], calls = [];
        const dispose = fixture.renderTextCollectionRows({ container: fixture.rows, records: [mutable], onOpen: row => { opened.push(row.text); calls.push(row.id); } });
        const old = fixture.rows.firstElementChild;
        mutable.text = 'a later chat must not replace the captured record';
        old.click();
        fixture.renderTextCollectionRows({ container: fixture.rows, records: [], onOpen: row => calls.push(row.id) });
        old.click(); dispose(); old.click();
        const stop = fixture.renderTextCollectionRows({ container: fixture.rows, records: [fixture.record], onOpen: row => calls.push(row.id) });
        stop(); fixture.rows.firstElementChild.click();
        let rejected = false;
        try { fixture.renderTextCollectionRows({ container: fixture.rows, records: Array(51).fill(fixture.record), onOpen() {} }); } catch (_) { rejected = true; }
        return { original, opened, calls, rejected };
    });
    assert.deepEqual(result.opened, [result.original]); assert.equal(result.calls.length, 1); assert.equal(result.rejected, true);
    checks.push('rows freeze input records, suppress detached/disposed click handlers and reject oversized pages without silent truncation');
    await page.evaluate(async()=>{
        const {openPersistentTextCollectionCapture}=await import('./qianmu-text-collection-capture.js');
        fixture.openPersistent=async()=>{
            fixture.namespace='st-user:alice';fixture.current=true;fixture.completed='pending';
            fixture.host=document.createElement('section');document.getElementById('fixture').append(fixture.host);
            fixture.session=await openPersistentTextCollectionCapture({parent:fixture.host,source:fixture.source,resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'})});
            fixture.session.finished.then(result=>{fixture.completed=result;});
        };
    });
    await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('save').click();
    await page.waitForFunction(()=>fixture.completed!=='pending');
    assert.equal(writes.at(-1).record.text,await page.evaluate(()=>fixture.raw));assert.match(writes.at(-1).expectedAccount,/^st-user:[a-f0-9]{64}$/);
    assert.equal(await page.evaluate(()=>fixture.completed.id),writes.at(-1).id);
    checks.push('persistent chooser uses the real same-origin client and closes only after a matching account/operation acknowledgement');
    apiMode='fail';await page.evaluate(()=>fixture.openPersistent());await action('selection').click();
    await page.locator('[data-collection-text]').evaluate(input=>{input.focus();const start=input.value.indexOf('记住');input.setSelectionRange(start,start+'记住这一刻😀'.length);input.dispatchEvent(new Event('select'));});
    await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-collection-status]').textContent.includes('未确认保存成功'));
    const retryRequest=structuredClone(writes.at(-1));assert.doesNotMatch(JSON.stringify(retryRequest),/未选前文|未选后文/);
    apiMode='ok';await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');assert.deepEqual(writes.at(-1),retryRequest);
    checks.push('failed selected-text save keeps the same mutation and collection IDs through an explicit UI retry without hidden full text');
    for(const mode of ['missing','wrong']){
        apiMode=mode;await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('save').click();
        await page.waitForFunction(()=>document.querySelector('[data-collection-status]').textContent.includes('未确认保存成功'));
        if(mode==='missing')assert.match(await page.locator('[data-collection-status]').textContent(),/安装或更新千幕后端/);
        assert.equal(await page.evaluate(()=>fixture.completed),'pending');await action('cancel').click();
    }
    checks.push('missing backend gives an actionable message and wrong confirmation leaves the draft unsaved');
    apiMode='hold';held=null;await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('save').click();
    await page.waitForFunction(()=>document.querySelector('dialog').getAttribute('aria-busy')==='true');
    for(let attempt=0;!held&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(typeof held,'function');
    await page.evaluate(()=>{fixture.namespace='st-user:bob';});await held();await page.waitForFunction(()=>fixture.completed!=='pending');
    assert.equal(await page.evaluate(()=>fixture.completed),null);assert.equal(await page.locator('dialog').count(),0);
    checks.push('account change while a persistent save is pending closes the old chooser and discards its late acknowledgement');
    apiMode='ok';
    await page.evaluate(async()=>{
        const {createTextCollectionFloorTools,injectStoryboardMessageButtons}=await import('./qianmu-text-collection-floor.js');
        fixture.current=true;fixture.chatKey='chat-floor';fixture.namespace='st-user:alice';fixture.notice=[];fixture.detached=0;
        fixture.messages=[{mes:'第一段\n\n第二段',name:'当时角色',swipe_id:1},{mes:'system',is_system:true},{mes:'用户内容',name:'当时用户',is_user:true}];
        fixture.chat=document.createElement('div');fixture.chat.id='chat';
        fixture.chat.innerHTML='<div class="mes" mesid="0"><div class="mes_text"><p>第一段</p><p>第二段</p><div data-qianmu-transient="storyboard">不收录的图注<button>重绘</button></div><script type="text/plain">不收录的脚本</script><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div><div class="mes_buttons"><div class="extraMesButtons"></div></div></div><div class="mes" mesid="1"><div class="mes_buttons"></div></div><div class="mes" mesid="2"><div class="mes_text">用户内容</div><div class="mes_buttons"></div></div>';
        document.body.append(fixture.chat);
        const hidden=document.createElement('p');hidden.style.display='none';hidden.textContent='主题隐藏的推理不收录';fixture.chat.querySelector('.mes_text').append(hidden);
        fixture.floorTools=createTextCollectionFloorTools({getContext:()=>({chat:fixture.messages}),getChatKey:()=>fixture.chatKey,names:()=>({charName:'当前角色',userName:'当前用户'}),resolveNamespace:async()=>fixture.namespace,
            isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'}),applyIcons:()=>{},mountPortal:()=>()=>{fixture.detached++;},notify:(...args)=>fixture.notice.push(args)});
        fixture.floorTools.refresh(fixture.chat);fixture.floorTools.refresh(fixture.chat);
        injectStoryboardMessageButtons(fixture.chat,{floorOf:node=>Number(node.getAttribute('mesid')),getContext:()=>({chat:fixture.messages}),getState:()=>({}),planForMessage:()=>null,applyIcons:()=>{}});
    });
    assert.equal(await page.locator('[data-qm-collect-floor]').count(),2);assert.equal(await page.locator('.sd-storyboard-message-action').count(),2);
    await page.locator('.mes[mesid="0"] [data-qm-collect-floor]').click();await action('full').click();await action('save').click();
    await page.waitForFunction(()=>fixture.notice.length===1);
    assert.equal(writes.at(-1).record.text,'第一段\n\n第二段');assert.equal(writes.at(-1).record.source.charName,'当时角色');assert.equal(writes.at(-1).record.source.userName,'当前用户');
    assert.equal(writes.at(-1).record.source.replyId,'swipe:1');assert.equal(await page.evaluate(()=>fixture.detached),1);
    checks.push('ST-shaped toolbar entries are idempotent, exclude system rows, coexist with storyboard and capture rendered prose without media or controls');
    apiMode='hold';held=null;await page.locator('.mes[mesid="0"] [data-qm-collect-floor]').click();await action('full').click();await action('save').click();
    for(let attempt=0;!held&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(typeof held,'function');
    await page.evaluate(()=>{fixture.messages[0].mes='另一条回复';fixture.messages[0].swipe_id=2;});await held();await page.waitForFunction(()=>!document.querySelector('dialog'));
    assert.equal(await page.evaluate(()=>fixture.notice.length),1);
    checks.push('edited or swiped floor never adopts a late save notification as a new source');
    await page.evaluate(()=>fixture.floorTools.dispose());assert.equal(await page.locator('[data-qm-collect-floor]').count(),0);assert.equal(await page.locator('.sd-storyboard-message-action').count(),2);
    await page.evaluate(()=>fixture.floorTools.refresh(fixture.chat));assert.equal(await page.locator('[data-qm-collect-floor]').count(),2);
    await page.locator('.mes[mesid="2"] [data-qm-collect-floor]').click();await action('full').click();await page.evaluate(()=>fixture.floorTools.dispose());await page.waitForFunction(()=>!document.querySelector('dialog'));
    assert.equal(await page.locator('[data-qm-text-collection-portal]').count(),0);
    checks.push('disable/hot cleanup removes only collection entries and portals; reinitialization works without duplicated handlers');
    assert.ok(await page.evaluate(() => fixture.selectionEvents) > 0);
    assert.equal(external, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, count: checks.length, externalRequests: external, productionWrites: false, persistence: 'capture adapter uses real client with intercepted synthetic API acknowledgements; no ST account or production disk', pageErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); }
