// Production dialog/session/readers, native IndexedDB, decoded synthetic PNGs and real download.
// No real account, ST data, paid API or external requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), errors = [], checks = []; let external = 0;
if (process.env.QIANMU_CHECK_PROGRESS) checks.push = (...items) => { console.error(items.join('\n')); return Array.prototype.push.apply(checks, items); };
const timer = setTimeout(() => { console.error(JSON.stringify({timeout:true,checks})); void browser.close(); }, 120000);
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
    await page.addScriptTag({ content: storyboardFunctionSource('ttsDownloadBlob') });
    await page.evaluate(async () => {
        const { createGalleryCatalogStore } = await import('/qianmu-gallery-catalog-store.js');
        const { createGalleryDirectorySession } = await import('/qianmu-gallery-directory.js');
        const { openGalleryDirectory } = await import('/qianmu-gallery-directory-view.js');
        const { createCurrentChatGalleryReceiptClient, createChatGalleryReceiptClient, createChatGalleryRecordClient } = await import('/qianmu-chat-character-receipt-client.js');
        const { loadGalleryPreviewImage } = await import('/qianmu-gallery-preview-media.js');
        const { chatGalleryReceiptText } = await import('/qianmu-chat-gallery-receipt.js');
        const ns = 'st-user:fixture', source = { ownerKey: 'char:D.png', chatKey: '历史聊天' };
        const frames = Array.from({length:110}, (_,i)=>({id:`id${i}`,createdAt:100+i,tags:['海岸'],url:`/user/images/image${i}.png`}));
        const current = [{id:'current',createdAt:1,tags:['当前'],url:'/user/images/current.png'}];
        const store = createGalleryCatalogStore(); await store.upsert(ns,source,frames.map(({id,createdAt,tags})=>({id,createdAt,tags,kind:'still'})),{expectedRevision:0}); store.close();
        const listeners = new Map(); window.account=ns;window.generation=1;
        window.host={chatId:'当前聊天',characterId:0,chat:[],chatMetadata:{story_director_liminale:{storyboardImages:current}},characters:[{avatar:'A.png',chat:'当前聊天',name:'当前角色'},{avatar:'D.png',chat:'历史聊天',name:'历史角色'}],
            eventSource:{on(type,handler){const set=listeners.get(type)||new Set();set.add(handler);listeners.set(type,set);},removeListener(type,handler){listeners.get(type)?.delete(handler);}}};
        window.listenerCount=()=>[...listeners.values()].reduce((n,set)=>n+set.size,0);
        window.mediaCalls=0;window.saveCalls=0;window.failAt=0;window.imageGate=null;window.changeFinal=false;window.savedNames=[];
        const canvas=document.createElement('canvas');canvas.width=30;canvas.height=60;canvas.getContext('2d').fillRect(0,0,30,60);
        window.previewBlob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
        const expectedAccount='st-user:'+await digest('fixture');
        const fetchImpl=async(url,options)=>{
            const request=JSON.parse(options.body),selected=request.target.avatar==='D.png'?frames:current;
            if(!/\/chat-gallery\/(receipt|record)$/.test(url)||request.target.kind!=='character')throw Error('unexpected source');
            const value=chatGalleryReceiptText(selected),hash=await digest(value.text);
            const result=url.endsWith('/record')?{gallerySha256:hash,record:selected.find(row=>row.id===request.selection.recordId),proof:'read-only-record'}:
                {state:'present',gallery:{count:value.count,bytes:value.bytes,sha256:window.changeFinal&&window.mediaCalls>window.changeAfter?'b'.repeat(64):hash},proof:'read-only-snapshot'};
            return new Response(JSON.stringify({ok:true,version:1,expectedAccount,target:request.target,...result}),{headers:{'Content-Type':'application/json'}});
        };
        window.catalogSnapshot=async()=>{const s=createGalleryCatalogStore();try{const pages=[];let cursor=null;do{const page=await s.page(ns,{limit:60,cursor});pages.push(page);cursor=page.nextCursor;}while(cursor);return pages;}finally{s.close();}};
        window.openFixture=()=>{
            const parent=document.getElementById('story-director-modal');parent.classList.add('open');
            window.controller=openGalleryDirectory({parent,getContext:()=>window.host,epoch:()=>window.generation,locate:()=>{},
                save:(blob,name)=>{window.saveCalls++;window.savedNames.push(name);window.ttsDownloadBlob(blob,name);},
                connect:options=>createGalleryDirectorySession({...options,
                    createClient:opts=>createCurrentChatGalleryReceiptClient({...opts,account:async()=>window.account,fetchImpl}),
                    createHistoricalClient:opts=>createChatGalleryReceiptClient({...opts,fetchImpl}),
                    createRecordClient:opts=>createChatGalleryRecordClient({...opts,fetchImpl}),
                    loadImage:(url,opts)=>loadGalleryPreviewImage(url,{...opts,fetchImpl:async(path,options)=>{
                        if(!/^\/user\/images\/image\d+\.png$/.test(path)||options.redirect!=='error'||options.credentials!=='same-origin')throw Error('unexpected media');
                        window.mediaCalls++;if(window.imageGate)await window.imageGate;
                        return window.mediaCalls===window.failAt?new Response('missing',{status:404}):new Response(window.previewBlob,{headers:{'Content-Type':'image/png'}});
                    }}),
                })});
        };
        const { createQianmuThemeSurfaceController }=await import('/qianmu-theme-surfaces.js');
        window.themeController=createQianmuThemeSurfaceController();window.themeController.register(document.getElementById('story-director-modal'));
        window.openFixture();
    });
    const dialog=page.locator('.sd-gallery-directory'), action=name=>dialog.locator(`[data-directory-action="${name}"]`);
    const idle=()=>page.waitForFunction(()=>{const node=document.querySelector('.sd-gallery-directory fieldset');return node&&!node.disabled;});
    const click=async name=>{await action(name).click();await idle();};
    const historical=async()=>{await dialog.locator('[data-directory-scope]').filter({hasText:'历史角色'}).click();await idle();await dialog.locator('[data-directory-scope]').first().click();await idle();};
    await idle();await historical();
    const before=await page.evaluate(async()=>({host:JSON.stringify(window.host.chatMetadata),catalog:await window.catalogSnapshot()}));
    assert.equal(await page.evaluate(()=>window.mediaCalls),0);checks.push('historical list and selection do not prefetch originals');
    await dialog.locator('[data-directory-select="0"]').check();await click('next');await dialog.locator('[data-directory-select="0"]').check();
    assert.equal(await dialog.locator('[data-directory-export-count]').innerText(),'已选 2 张');await click('previous');assert.equal(await dialog.locator('[data-directory-select="0"]').isChecked(),true);
    checks.push('cross-page selection survives previous/next with exact original record identity');
    const downloadEvent=page.waitForEvent('download');await action('export-selected').click();const download=await downloadEvent;await idle();
    assert.match(download.suggestedFilename(),/^qianmu-originals-selected-2-\d+\.zip$/);assert.equal(await page.evaluate(()=>window.saveCalls),1);assert.equal(await page.evaluate(()=>window.mediaCalls),2);
    const file=await download.path(),names=execFileSync('tar.exe',['-tf',file],{encoding:'utf8'}).trim().split(/\r?\n/);
    assert.deepEqual(names,['source.json','README.txt','images/001.png','images/002.png']);
    const manifest=JSON.parse(execFileSync('tar.exe',['-xOf',file,'source.json'],{encoding:'utf8'}));
    assert.deepEqual(manifest.source,{ownerKey:'char:D.png',chatKey:'历史聊天'});assert.deepEqual(manifest.images.map(row=>row.recordId),['id109','id85']);
    assert.doesNotMatch(JSON.stringify(manifest),/prompt|apiKey|\/user\/images|当前聊天/);
    const image=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await window.previewBlob.arrayBuffer()))));
    for(const name of names.filter(name=>name.startsWith('images/')))assert.deepEqual(execFileSync('tar.exe',['-xOf',file,name]),image);
    checks.push('native browser ZIP download independently extracts byte-exact PNGs and historical-only source manifest');
    assert.match(await dialog.locator('footer').innerText(),/2 张.*交给浏览器.*不是完整/);
    assert.equal(await action('export-cancel').count(),0);checks.push('completion is browser handoff, never a full-chat backup claim');
    await click('export-clear');await click('export-page');assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/24/);
    for(let n=0;n<3;n++){await click('next');await click('export-page');}
    assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/96/);await click('next');await click('export-page');
    assert.match(await dialog.locator('footer').innerText(),/100 张/);assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/96/);
    for(let n=0;n<4;n++)await dialog.locator(`[data-directory-select="${n}"]`).check();
    await dialog.locator('[data-directory-select="4"]').click();
    assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/100/);assert.equal(await dialog.locator('[data-directory-select="4"]').isChecked(),false);
    checks.push('page selection is atomic at 100-image limit and 101st checkbox is rejected');
    await dialog.locator('[name="tag"]').fill('海岸');await dialog.locator('[name="tag"]').press('Enter');await idle();assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/0 张/);
    assert.equal(await action('export-selected').isDisabled(),true);checks.push('changing filters clears selection instead of silently exporting hidden prior scope');
    await click('clear-tag');await dialog.locator('[data-directory-select="0"]').check();await dialog.locator('[data-directory-select="1"]').check();
    for(const theme of [null,{theme:'editorial',mode:'light'},{theme:'editorial',mode:'dark'},{theme:'glass',mode:'light'},{theme:'glass',mode:'dark'}])for(const width of [320,393,1280]){
        await page.evaluate(theme=>window.themeController.setTheme(theme),theme);await page.setViewportSize({width,height:width===1280?800:720});
        const layout=await dialog.evaluate(node=>({width:node.getBoundingClientRect().width,viewport:innerWidth,main:node.querySelector('main').clientWidth,scroll:node.querySelector('main').scrollWidth}));
        assert.ok(layout.width<=layout.viewport&&layout.scroll<=layout.main+2,JSON.stringify({theme,width,layout}));checks.push(`selection controls fit ${theme?.theme||'classic'}-${theme?.mode||'default'} ${width}`);
    }
    await page.evaluate(()=>window.failAt=window.mediaCalls+2);await click('export-selected');assert.equal(await page.evaluate(()=>window.saveCalls),1);assert.match(await dialog.locator('footer').innerText(),/原图不存在/);
    assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/2 张/);checks.push('missing second selected image prevents partial ZIP and preserves selection for retry');
    await page.evaluate(()=>{window.failAt=0;window.changeAfter=window.mediaCalls;window.changeFinal=true;});await click('export-selected');
    assert.match(await dialog.locator('footer').innerText(),/打包期间.*变化/);assert.equal(await page.evaluate(()=>window.saveCalls),1);checks.push('final source revalidation rejects a changed historical snapshot without a download');
    await page.evaluate(()=>{window.changeFinal=false;window.imageGate=new Promise(resolve=>window.releaseImage=resolve);});
    let previous=await page.evaluate(()=>window.mediaCalls);await action('export-selected').click();await page.waitForFunction(n=>window.mediaCalls>n,previous);
    await action('export-selected').dispatchEvent('click');assert.equal(await page.evaluate(()=>window.mediaCalls),previous+1);
    await click('export-cancel');assert.match(await dialog.locator('footer').innerText(),/取消/);await page.evaluate(()=>{window.releaseImage();window.imageGate=null;});
    assert.equal(await page.evaluate(()=>window.saveCalls),1);checks.push('duplicate click is ignored and cancellation stays responsive during non-abortable media fetch');
    const retryEvent=page.waitForEvent('download');await action('export-selected').click();await retryEvent;await idle();assert.equal(await page.evaluate(()=>window.saveCalls),2);
    checks.push('cancelled export permits an explicit successful retry');
    assert.deepEqual(await page.evaluate(async()=>({host:JSON.stringify(window.host.chatMetadata),catalog:await window.catalogSnapshot()})),before);
    checks.push('success and failures never change chat metadata or directory records');
    await click('chats');await dialog.locator('[data-directory-scope]').first().click();await idle();assert.match(await dialog.locator('[data-directory-export-count]').innerText(),/0 张/);
    checks.push('leaving a historical chat clears its selection');
    await dialog.locator('[data-directory-select="0"]').check();await page.evaluate(()=>{window.imageGate=new Promise(resolve=>window.releaseImage=resolve);});
    previous=await page.evaluate(()=>window.mediaCalls);await action('export-selected').click();await page.waitForFunction(n=>window.mediaCalls>n,previous);
    await page.keyboard.press('Escape');await page.evaluate(()=>{window.releaseImage();window.imageGate=null;});await page.waitForFunction(()=>window.listenerCount()===0);
    assert.equal(await page.evaluate(()=>window.saveCalls),2);checks.push('closing pending export removes source listeners and suppresses late download');
    await page.evaluate(()=>window.openFixture());await idle();await historical();await dialog.locator('[data-directory-select="0"]').check();
    await page.evaluate(()=>{window.imageGate=new Promise(resolve=>window.releaseImage=resolve);});previous=await page.evaluate(()=>window.mediaCalls);
    await action('export-selected').click();await page.waitForFunction(n=>window.mediaCalls>n,previous);
    await page.evaluate(()=>{window.account='st-user:other';window.releaseImage();window.imageGate=null;});await page.waitForFunction(()=>!document.querySelector('.sd-gallery-directory'));
    assert.equal(await page.evaluate(()=>window.saveCalls),2);assert.equal(await page.evaluate(()=>window.listenerCount()),0);checks.push('account change invalidates pending ZIP before browser handoff');
    assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,externalRequests:external,pageErrors:errors}));
} finally {clearTimeout(timer);await browser.close();}
