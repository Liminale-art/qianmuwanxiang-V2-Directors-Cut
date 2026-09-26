// Isolated DOM + real client checks. API responses are synthetic, never a live ST account.
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const artifactDirectory=process.env.QIANMU_CAPTURE_ARTIFACTS==='1'?await mkdtemp(path.join(os.tmpdir(),'qianmu-collection-picker-')):null;
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = [], allowed = new Set(['qianmu-text-collection.js', 'qianmu-text-collection-view.js', 'qianmu-notes-sync-contract.js', 'qianmu-text-collection-backup.js', 'qianmu-json-input.js']);
for(const file of ['floor','floor-status','capture','session','client','sync-contract','bulk-contract','outbox-store','outbox-runtime','outbox-backup'])allowed.add(`qianmu-text-collection-${file}.js`);
allowed.add('qianmu-account-local-store.js');
allowed.add('qianmu-plain-text-range.js');
allowed.add('qianmu-icon-renderer.js');allowed.add('qianmu-text-collection-paragraphs.js');
allowed.add('qianmu-st-account-storage.js');
allowed.add('qianmu-account-identity.js');
allowed.add('qianmu-feature-runtime.js');
allowed.add('qianmu-text-collection-presentation.js');
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
        if(apiMode==='legacy')return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({ok:false,version:1,code:'text_collection_sync_contract',message:'收藏记录无效',writeState:'not_started'})});
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
            fixture.host = document.createElement('section'); fixture.host.className = 'sd-theme-dark';fixture.host.style.fontSize='19px';
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
    assert.equal(await page.locator('[data-collection-paragraph][aria-pressed="true"]').count(),0,'full text preview does not show a selected paragraph background');
    assert.equal(await page.locator('[data-collection-paragraph]').count(),3);
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
    await page.locator('[data-collection-paragraph="1"]').click();
    await action('save').click();
    await page.waitForFunction(() => document.querySelector('[data-collection-status]').textContent.includes('保存未完成'));
    const failedId = await page.evaluate(() => fixture.writes[0].id);
    assert.equal(await page.evaluate(() => fixture.writes[0].text), '记住这一刻😀，还有你。');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fixture.writes[0])), /未选前文|未选后文/);
    await page.evaluate(() => { fixture.mode = 'ok'; });
    await action('save').click(); await page.waitForFunction(() => fixture.completed !== 'pending');
    assert.equal(await page.evaluate(() => fixture.writes[1].id), failedId);
    checks.push('paragraph tap excludes unselected text, survives button focus and retries the same identity');

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
    for(const index of [1,2,3])await page.locator(`[data-collection-paragraph="${index}"]`).click();
    await action('save').click(); await page.waitForFunction(() => fixture.completed !== 'pending');
    assert.equal(await page.evaluate(() => fixture.writes[0].text), 'B😀\r\nC\rD');
    await page.evaluate(() => { fixture.source = fixture.originalSource; });
    checks.push('a selection crossing multiple CRLFs and a lone CR preserves exact original line breaks');

    await page.evaluate(()=>{fixture.mode='ok';fixture.open();});await action('full').click();await action('edit').click();
    assert.equal(await page.getByLabel('编辑收藏文字').getAttribute('readonly'),null);await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');
    assert.equal(await page.evaluate(()=>fixture.writes[0].schemaVersion),1);assert.equal(await page.evaluate(()=>fixture.writes[0].text),await page.evaluate(()=>fixture.raw));
    checks.push('opening full-text editor without changing content preserves original CRLF and legacy unedited schema');
    await page.evaluate(()=>{fixture.mode='fail';fixture.open();});await action('selection').click();assert.equal(await action('edit').isDisabled(),true);
    await page.locator('[data-collection-paragraph="1"]').click();
    await action('edit').click();assert.equal(await page.getByLabel('编辑收藏文字').inputValue(),'记住这一刻😀，还有你。');await page.getByLabel('编辑收藏文字').fill('  ');assert.equal(await action('save').isDisabled(),true);
    await page.getByLabel('编辑收藏文字').fill('改写后的珍藏\n😀<b>仅文本</b>');await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-collection-status]').textContent.includes('当前内容已保留'));
    const editedDraft=await page.evaluate(()=>fixture.writes[0]);assert.equal(editedDraft.schemaVersion,3);assert.equal(editedDraft.text,'改写后的珍藏\n😀<b>仅文本</b>');assert.deepEqual(editedDraft.range,{start:6,end:18});assert.doesNotMatch(JSON.stringify(editedDraft),/未选前文|未选后文/);
    assert.equal(await page.getByLabel('编辑收藏文字').evaluate(node=>node.readOnly),true);assert.equal(await action('back').isDisabled(),true);assert.equal(await page.locator('dialog b').count(),0);
    await page.evaluate(()=>{fixture.mode='ok';document.querySelector('[data-collection-text]').value='script change must not replace pending draft';});await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');assert.deepEqual(await page.evaluate(()=>fixture.writes[1]),editedDraft);
    checks.push('selection editor saves only edited plaintext with original range, rejects blanks and locks failed submission to the exact same draft and ID');
    await page.evaluate(()=>fixture.open());await action('full').click();await action('edit').click();await page.getByLabel('编辑收藏文字').fill('discard this draft');assert.equal(await action('back').getAttribute('aria-label'),'放弃修改并返回选择');await action('back').click();await action('full').click();await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');assert.equal(await page.evaluate(()=>fixture.writes[0].text),await page.evaluate(()=>fixture.raw));
    checks.push('explicit abandon-and-reselect discards only the unsent edited copy and never changes the captured source');

    await page.evaluate(()=>{fixture.source=fixture.captureTextCollectionSource({...fixture.source,text:'收藏一😀\r\n绝不带入\n收藏三'});fixture.open();});
    await action('selection').click();for(const index of [2,0])await page.locator(`[data-collection-paragraph="${index}"]`).click();
    assert.equal(await page.locator('[data-collection-paragraph="0"]').evaluate(n=>getComputedStyle(n).fontSize),'19px');
    for(const name of ['back','cancel','edit','save']){assert.equal(await action(name).locator('svg').count(),1);assert.ok(await action(name).getAttribute('aria-label'));assert.equal(await action(name).textContent(),'');}
    assert.equal(await action('back').evaluate(n=>n.parentElement.parentElement.tagName),'HEADER');
    const places=await page.evaluate(()=>Object.fromEntries(['edit','save'].map(name=>{const r=document.querySelector(`[data-collection-action="${name}"]`).getBoundingClientRect();return[name,{x:r.x,y:r.y}];})));
    assert.ok(places.edit.x<places.save.x);assert.equal(places.edit.y,places.save.y);
    await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');
    const composed=await page.evaluate(()=>fixture.writes[0]);assert.equal(composed.text,'收藏一😀\n\n收藏三');assert.equal(composed.captureEdited,true);assert.doesNotMatch(JSON.stringify(composed),/绝不带入/);
    await page.evaluate(()=>{fixture.source=fixture.originalSource;});
    checks.push('nonadjacent paragraph taps collect only chosen prose in narrative order; local icon controls occupy the requested corners and source font is inherited');

    for (const width of [320, 393, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(() => { fixture.mode = 'ok'; fixture.open(); });
        const choiceBox=await page.locator('dialog').boundingBox();assert.ok(choiceBox.height<220&&choiceBox.width<=420,JSON.stringify(choiceBox));
        if(width===393&&artifactDirectory)await page.screenshot({path:path.join(artifactDirectory,'collection_choice_compact.png')});
        await action('selection').click();
        if(width===393&&artifactDirectory){await page.locator('[data-collection-paragraph="1"]').click();await page.screenshot({path:path.join(artifactDirectory,'collection_picker_narrow.png')});}
        const layout = await page.locator('dialog').evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth }));
        assert.ok(layout.width <= width && layout.scroll <= layout.client + 1, JSON.stringify(layout));
        await action('back').click();await action('full').click();await action('edit').click();await page.getByLabel('编辑收藏文字').fill('修改稿😀'.repeat(100));
        const editorLayout=await page.locator('dialog').evaluate(node=>({width:node.getBoundingClientRect().width,scroll:node.scrollWidth,client:node.clientWidth}));assert.ok(editorLayout.width<=width&&editorLayout.scroll<=editorLayout.client+1,JSON.stringify(editorLayout));
        const editorBox=await page.getByLabel('编辑收藏文字').boundingBox(),mainBox=await page.locator('dialog > main').boundingBox();
        assert.ok(Math.abs(editorBox.x-mainBox.x-12)<2&&Math.abs(editorBox.width-(mainBox.width-24))<2,'editor aligns with reader content column');
        assert.ok(editorBox.height>mainBox.height-2,'editor fills the reading area rather than retaining 40vh height');
        assert.equal(await action('save').evaluate(n=>Math.round(n.getBoundingClientRect().right)),await page.locator('.qm-text-collection-capture-actions').evaluate(n=>Math.round(n.getBoundingClientRect().right)),'save remains bottom-right after the edit icon is hidden');
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
    await page.evaluate(()=>{fixture.source=fixture.captureTextCollectionSource({...fixture.source,text:'\n\n第一段。\r\n\r\n\n \n第二段。\n\n\n'});fixture.mode='ok';fixture.open();});
    await action('full').click();await action('edit').click();assert.equal(await page.getByLabel('编辑收藏文字').inputValue(),'第一段。\n\n第二段。');
    if(artifactDirectory){await page.setViewportSize({width:393,height:850});await page.screenshot({path:path.join(artifactDirectory,'collection_edit_normalized.png')});}
    await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');
    assert.equal(await page.evaluate(()=>fixture.writes[0].text),'\n\n第一段。\r\n\r\n\n \n第二段。\n\n\n');
    await page.evaluate(()=>{fixture.source=fixture.originalSource;});
    checks.push('redundant captured blank runs display as regular paragraphs, but untouched edit-save preserves exact original bytes');
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
        fixture.openPersistentRuntime=openPersistentTextCollectionCapture;
        fixture.readPending=async account=>{const {createTextCollectionOutboxStore}=await import('./qianmu-text-collection-outbox-store.js');const store=createTextCollectionOutboxStore();try{return (await store.read(account)).entries;}finally{store.close();}};
        fixture.openPersistent=async()=>{
            fixture.namespace='st-user:alice';fixture.current=true;fixture.completed='pending';
            fixture.host=document.createElement('section');document.getElementById('fixture').append(fixture.host);
            fixture.session=await openPersistentTextCollectionCapture({parent:fixture.host,source:fixture.source,resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'})});
            fixture.session.finished.then(result=>{fixture.completed=result;});
        };
    });
    const beforeSlow=writes.length;
    await page.evaluate(async()=>{
        fixture.host=document.createElement('section');document.getElementById('fixture').append(fixture.host);fixture.current=true;
        fixture.accountGate=new Promise(resolve=>{fixture.releaseAccount=()=>resolve('st-user:alice');});
        fixture.slowChooser=await fixture.openPersistentRuntime({parent:fixture.host,source:fixture.source,resolveNamespace:()=>fixture.accountGate,isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'})});
    });
    assert.equal(await page.locator('dialog').isVisible(),true);await action('selection').click();await page.locator('[data-collection-paragraph="1"]').click();assert.equal(await action('save').isDisabled(),false);
    await action('save').click();assert.equal(await action('save').isDisabled(),true);await action('cancel').click();await page.evaluate(async()=>{fixture.releaseAccount();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    assert.equal(await page.locator('dialog').count(),0);assert.equal(writes.length,beforeSlow);
    checks.push('slow account initialization never blocks the local paragraph chooser; cancellation before authorization prevents all writes');
    await page.evaluate(async()=>{
        fixture.rejectAccount=true;fixture.host=document.createElement('section');document.getElementById('fixture').append(fixture.host);
        fixture.retryChooser=await fixture.openPersistentRuntime({parent:fixture.host,source:fixture.source,resolveNamespace:async()=>{if(fixture.rejectAccount)throw Error('offline fixture');return 'st-user:alice';},isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'})});
    });
    await action('full').click();await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-collection-status]')?.textContent.includes('保存未完成'));
    assert.equal(writes.length,beforeSlow);await page.evaluate(()=>{fixture.rejectAccount=false;});await action('save').click();await page.waitForFunction(()=>!document.querySelector('dialog'));assert.equal(writes.length,beforeSlow+1);
    checks.push('account setup failure stays visible and retryable without discarding selected prose or claiming it was saved');
    await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('save').click();
    await page.waitForFunction(()=>fixture.completed!=='pending');
    assert.equal(writes.at(-1).record.text,await page.evaluate(()=>fixture.raw));assert.match(writes.at(-1).expectedAccount,/^st-user:[a-f0-9]{64}$/);
    assert.equal(await page.evaluate(()=>fixture.completed.id),writes.at(-1).id);
    checks.push('persistent chooser uses the real same-origin client and closes only after a matching account/operation acknowledgement');
    apiMode='fail';await page.evaluate(()=>fixture.openPersistent());await action('selection').click();
    await page.locator('[data-collection-paragraph="1"]').click();
    await action('save').click();await page.waitForFunction(()=>document.querySelector('[data-collection-status]').textContent.includes('保存未完成'));
    const retryRequest=structuredClone(writes.at(-1));assert.doesNotMatch(JSON.stringify(retryRequest),/未选前文|未选后文/);
    assert.match(await page.locator('[data-collection-status]').textContent(),/当前内容已保留/);
    const pending=await page.evaluate(account=>fixture.readPending(account),retryRequest.expectedAccount);assert.deepEqual(pending[0].request,retryRequest);
    apiMode='ok';await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');assert.deepEqual(writes.at(-1),retryRequest);
    assert.equal((await page.evaluate(account=>fixture.readPending(account),retryRequest.expectedAccount)).length,0);
    checks.push('failed selected-text save keeps the same mutation and collection IDs through an explicit UI retry without hidden full text');
    apiMode='legacy';await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('edit').click();await page.getByLabel('编辑收藏文字').fill('旧后端也不能丢掉的编辑稿😀');await action('save').click();
    await page.waitForFunction(()=>document.querySelector('[data-collection-status]').textContent.includes('收藏服务需要更新'));const editedRequest=structuredClone(writes.at(-1));assert.equal(editedRequest.record.schemaVersion,3);assert.match(await page.locator('[data-collection-status]').textContent(),/当前内容已保留/);
    assert.deepEqual((await page.evaluate(account=>fixture.readPending(account),editedRequest.expectedAccount))[0].request,editedRequest);
    apiMode='ok';await action('save').click();await page.waitForFunction(()=>fixture.completed!=='pending');assert.deepEqual(writes.at(-1),editedRequest);assert.equal((await page.evaluate(account=>fixture.readPending(account),editedRequest.expectedAccount)).length,0);
    checks.push('older backend refusal retains the edited pending original, explains updating, and explicit retry sends identical edited schema without downgrade');
    for(const mode of ['missing','wrong']){
        apiMode=mode;await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('save').click();
        await page.waitForFunction(()=>document.querySelector('[data-collection-status]').textContent.includes('保存未完成'));
        if(mode==='missing')assert.match(await page.locator('[data-collection-status]').textContent(),/安装或更新千幕后端/);
        assert.equal(await page.evaluate(()=>fixture.completed),'pending');await action('cancel').click();
    }
    checks.push('missing backend gives an actionable message and wrong confirmation leaves the draft unsaved');
    const retained=await page.evaluate(account=>fixture.readPending(account),retryRequest.expectedAccount);assert.equal(retained.length,2);
    checks.push('capture durably queues before submission; concise failure status does not claim cross-device success and closing preserves both pending originals');
    apiMode='hold';held=null;await page.evaluate(()=>fixture.openPersistent());await action('full').click();await action('save').click();
    await page.waitForFunction(()=>document.querySelector('dialog').getAttribute('aria-busy')==='true');
    for(let attempt=0;!held&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(typeof held,'function');
    await page.evaluate(()=>{fixture.namespace='st-user:bob';});await held();await page.waitForFunction(()=>fixture.completed!=='pending');
    assert.equal(await page.evaluate(()=>fixture.completed),null);assert.equal(await page.locator('dialog').count(),0);
    checks.push('account change while a persistent save is pending closes the old chooser and discards its late acknowledgement');
    apiMode='ok';
    await page.evaluate(async()=>{
        const {createTextCollectionFloorTools,injectStoryboardMessageButtons}=await import('./qianmu-text-collection-floor.js');
        const {applyQianmuIcons}=await import('./qianmu-icon-renderer.js');
        fixture.current=true;fixture.chatKey='chat-floor';fixture.namespace='st-user:alice';fixture.notice=[];fixture.detached=0;
        fixture.messages=[{mes:'第一段\n\n第二段',name:'当时角色',swipe_id:1},{mes:'system',is_system:true},{mes:'用户内容',name:'当时用户',is_user:true}];
        fixture.chat=document.createElement('div');fixture.chat.id='chat';
        fixture.chat.innerHTML='<div class="mes" mesid="0"><div class="mes_text"><p>第一段</p><p>第二段</p><div data-qianmu-transient="storyboard">不收录的图注<button>重绘</button></div><script type="text/plain">不收录的脚本</script><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div><div class="mes_buttons"><div class="extraMesButtons"></div></div></div><div class="mes" mesid="1"><div class="mes_buttons"></div></div><div class="mes" mesid="2"><div class="mes_text">用户内容</div><div class="mes_buttons"></div></div>';
        document.body.append(fixture.chat);
        const hidden=document.createElement('p');hidden.style.display='none';hidden.textContent='主题隐藏的推理不收录';fixture.chat.querySelector('.mes_text').append(hidden);
        fixture.names={charName:'当前角色',userName:'当前用户'};
        fixture.floorTools=createTextCollectionFloorTools({getContext:()=>({chat:fixture.messages}),getChatKey:()=>fixture.chatKey,names:()=>fixture.names,resolveNamespace:async()=>fixture.namespace,
            isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'}),applyIcons:applyQianmuIcons,mountPortal:()=>()=>{fixture.detached++;},notify:(...args)=>fixture.notice.push(args),
            statusSessionFactory:async()=>({expectedAccount:'fixture-status-only',snapshot:async()=>({backup:{sourceAccount:'fixture-status-only',records:[]}}),close(){}})});
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
    apiMode='ok';await page.evaluate(()=>{fixture.messages[0].name='';fixture.names={charName:'',userName:'  '};});
    await page.locator('.mes[mesid="0"] [data-qm-collect-floor]').click();await action('full').click();await action('save').click();await page.waitForFunction(()=>!document.querySelector('dialog'));
    assert.equal(writes.at(-1).record.source.charName,'CHAR 名未记录');assert.equal(writes.at(-1).record.source.userName,'USER 名未记录');assert.equal(writes.at(-1).record.source.chatId,'chat-floor');assert.equal(writes.at(-1).record.source.replyId,'swipe:2');
    checks.push('missing display names receive explicit unknown labels without guessing people, changing identity or blocking an otherwise valid collection');
    await page.evaluate(()=>fixture.floorTools.dispose());assert.equal(await page.locator('[data-qm-collect-floor]').count(),0);assert.equal(await page.locator('.sd-storyboard-message-action').count(),2);
    await page.evaluate(()=>fixture.floorTools.refresh(fixture.chat));assert.equal(await page.locator('[data-qm-collect-floor]').count(),2);
    await page.locator('.mes[mesid="2"] [data-qm-collect-floor]').click();await action('full').click();await page.evaluate(()=>fixture.floorTools.dispose());await page.waitForFunction(()=>!document.querySelector('dialog'));
    assert.equal(await page.locator('[data-qm-text-collection-portal]').count(),0);
    checks.push('disable/hot cleanup removes only collection entries and portals; reinitialization works without duplicated handlers');
    assert.ok(await page.evaluate(() => fixture.selectionEvents) > 0);
    assert.equal(external, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks, count: checks.length, externalRequests: external, productionWrites: false, artifactDirectory, persistence: 'capture adapter uses real client with intercepted synthetic API acknowledgements; no ST account or production disk', pageErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); }
