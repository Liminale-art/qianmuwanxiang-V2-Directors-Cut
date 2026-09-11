// Real shelf templates, ownership move and event handlers; fake books, storage and dialogs only.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {libraryFunctions} from '../tests/helpers/coread-library-fixture.mjs';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
import {checkCollectionMutationBrowser} from '../tests/helpers/coread-collection-browser.mjs';
import {checkBookEditBrowser} from '../tests/helpers/coread-book-edit-browser.mjs';
import {checkBookDeleteBrowser} from '../tests/helpers/coread-book-delete-browser.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8'),view=await readFile(new URL('../qianmu-reader-library-view.js',import.meta.url),'utf8');
const utils=await readFile(new URL('../qianmu-storyboard-utils.js',import.meta.url),'utf8'),icons=await readFile(new URL('../qianmu-icon-renderer.js',import.meta.url),'utf8');
const functions=libraryFunctions+'\n'+['coreadMoveBooksToCollection','loadShelfCovers','bindLibraryBookDrag','bindLibraryViewEvents'].map(section).join('\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext({hasTouch:true});
const errors=[];let external=0;await context.route('**/*',route=>route.request().url()==='https://qianmu.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated shelf</title>'}):(external++,route.abort()));const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('https://qianmu.test/');
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#222}#story-director-modal{position:static!important;display:block!important;width:100%;box-sizing:border-box;padding:12px}</style><div id="story-director-modal" class="sd-theme-dark"><div id="shelf"></div></div>`);
  await page.evaluate(async({view,utils,icons,functions})=>{
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(view)),await import('data:text/javascript,'+encodeURIComponent(utils)),await import('data:text/javascript,'+encodeURIComponent(icons)));
    window.COREAD_BOOK_ACCEPT='fixture-books-only';window.shelfCoverUrls=new Map();window.coread=()=>shelfData;
    window.saveSettings=()=>shelfCalls.push(['save']);window.toast=()=>{};window.coreadOpenBook=id=>shelfCalls.push(['open',id]);
    window.coreadEditBookInfo=async id=>{shelfCalls.push(['edit',id]);return false;};window.coreadRenameCollection=async id=>{shelfCalls.push(['rename',id]);return false;};
    window.coreadCreateCollection=async()=>{shelfCalls.push(['create']);return false;};window.coreadDissolveCollection=async id=>{shelfCalls.push(['dissolve',id]);return false;};
    window.coreadChooseCollectionForBooks=async ids=>{shelfCalls.push(['collect',ids]);coreadMoveBooksToCollection(ids,'folder');return true;};
    window.confirmDialog=async title=>{shelfCalls.push(['confirm',title]);return false;};window.coreadDeleteBook=()=>{throw Error('must not delete after cancellation');};
    window.coreadRequestDeleteBooks=async ids=>{if(await confirmDialog(`删除 ${ids.length} 本测试书`))throw Error('fixture deletion not authorized');return false;};
    window.coreadHandleImportFiles=()=>{throw Error('no fixture import authorized');};
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='),x=>x.charCodeAt(0));
    window.blobStore={getCover:async id=>{shelfCalls.push(['cover',id]);return new Blob([bytes],{type:'image/png'});}};
    window.eval(functions);window.renderModal=()=>{const root=document.getElementById('shelf');root.innerHTML=renderLibraryView();bindLibraryViewEvents(root);applyQianmuIcons(root);};
    window.resetShelfFixture=()=>{
      for(const url of shelfCoverUrls.values())URL.revokeObjectURL(url);shelfCoverUrls.clear();window.shelfCalls=[];
      window.shelfData={books:[{id:'a',title:'Alpha <book>',author:'作者甲',progress:15,tags:['blue'],addedAt:3},{id:'b',title:'Beta',author:'作者乙',progress:30,tags:['green'],addedAt:2},
        {id:'f',title:'Folder Book',author:'作者丙',progress:50,tags:['blue'],hasCover:true,addedAt:1}],collections:[{id:'folder',name:'Collection',bookIds:['f'],createdAt:1,updatedAt:1}],libCollectionId:'',libTags:[],libSort:'addedAt-desc',libViewMode:'grid'};
      renderModal();
    };resetShelfFixture();
  },{view,utils,icons,functions});
  const layouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:898});await page.evaluate(()=>resetShelfFixture());
    await page.waitForFunction(()=>document.querySelector('[data-cover="f"]')?.naturalWidth===1);
    assert.equal(await page.locator('.sd-reader-collection-tile').count(),4);assert.equal(await page.locator('.sd-reader-card-del').count(),0);
    const a=page.locator('.sd-reader-card[data-book="a"]'),folder=page.locator('.sd-reader-collection-card');
    await a.locator('.sd-reader-card-edit').tap();await folder.locator('.sd-reader-collection-edit').tap();
    assert.deepEqual(await page.evaluate(()=>shelfCalls.filter(x=>['open','edit','rename'].includes(x[0]))),[['edit','a'],['rename','folder']]);
    assert.equal(await page.evaluate(()=>shelfData.libCollectionId),'');
    const search=page.locator('.sd-reader-search');await search.fill('作者甲');assert.equal(await page.locator('.sd-reader-card:visible').count(),1);
    await search.evaluate(el=>window.shelfSearch=el);await search.press('Backspace');assert.equal(await search.evaluate(el=>el===shelfSearch&&document.activeElement===el),true);await search.fill('');
    await a.locator('.sd-reader-card-title').click();assert.deepEqual(await page.evaluate(()=>shelfCalls.filter(x=>x[0]==='open')),[['open','a']]);
    await page.evaluate(()=>shelfCalls=[]);
    const from=await a.locator('.sd-reader-card-title').boundingBox(),to=await folder.boundingBox();
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.locator('.sd-reader-book-drag-ghost').waitFor({state:'visible'});
    await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:6});assert.equal(await folder.evaluate(el=>el.classList.contains('sd-reader-collection-drop-target')),true);await page.mouse.up();
    await page.waitForFunction(()=>!document.querySelector('.sd-reader-card[data-book="a"]'));assert.equal(await page.locator('.sd-reader-book-drag-ghost').count(),0);
    assert.deepEqual(await page.evaluate(()=>shelfData.collections[0].bookIds),['f','a']);assert.deepEqual(await page.evaluate(()=>shelfCalls.filter(x=>x[0]==='open')),[]);
    await folder.locator('.sd-reader-card-title').tap();assert.equal(await page.evaluate(()=>shelfData.libCollectionId),'folder');
    await page.locator('.sd-reader-card[data-book="a"] .sd-reader-collection-remove-book').tap();
    assert.deepEqual(await page.evaluate(()=>shelfData.collections[0].bookIds),['f']);assert.equal(await page.evaluate(()=>shelfData.books.find(b=>b.id==='a').progress),15);
    await page.locator('.sd-reader-collection-back').tap();await page.locator('.sd-reader-view-toggle').tap();
    assert.equal(await page.locator('.sd-reader-batch-collect').isDisabled(),true);await page.locator('.sd-reader-book-check[data-book="b"]').check();
    assert.equal(await page.locator('.sd-reader-batch-collect').isEnabled(),true);assert.equal(await page.locator('.sd-reader-batch-count').innerText(),'1');
    assert.deepEqual(await page.evaluate(()=>shelfCalls.filter(x=>x[0]==='open')),[]);await page.locator('.sd-reader-batch-collect').tap();
    assert.deepEqual(await page.evaluate(()=>shelfData.collections[0].bookIds),['f','b']);
    await page.locator('.sd-reader-card-del[data-book="a"]').tap();assert.equal(await page.evaluate(()=>shelfData.books.length),3);
    assert.equal(await page.evaluate(()=>shelfCalls.filter(x=>x[0]==='confirm').length),1);assert.deepEqual(await page.evaluate(()=>shelfCalls.filter(x=>x[0]==='open')),[]);
    await page.locator('.sd-reader-sort-toggle').tap();await page.locator('.sd-reader-sort-opt[data-sort="title-asc"]').tap();assert.equal(await page.evaluate(()=>shelfData.libSort),'title-asc');
    await page.locator('.sd-reader-tag[data-tag="green"]').tap();assert.equal(await page.locator('.sd-reader-row').count(),0);assert.equal(await page.locator('.sd-reader-collection-row').count(),1);
    await page.locator('.sd-reader-tag[data-tag="green"]').tap();
    const boxes=await page.locator('.sd-reader-lib-bar, .sd-reader-row, .sd-reader-collection-row').evaluateAll(els=>els.map(el=>{const b=el.getBoundingClientRect();return {x:b.x,right:b.right,width:b.width};}));
    assert.ok(boxes.every(b=>b.x>=-1&&b.right<=width+1));
    const native=await page.locator('.sd-reader-import-input').evaluate(el=>{const b=el.getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===el;});assert.equal(native,true);
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/reader-library-${width}.png`,import.meta.url))});layouts.push({width,boxes,nativeFileHit:native,toolIsolation:true,mouseDrag:true,ownershipPreserved:true});
  }
  const mutations=await checkCollectionMutationBrowser(page);
  const bookEdits=await checkBookEditBrowser(page);
  const bookDeletes=await checkBookDeleteBrowser(page);
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({layouts,mutations,bookEdits,bookDeletes,realTemplates:true,realEvents:true,localCoverBlob:true,external,errors,limits:'synthetic host Popup, books and navigation; metadata edits/deletions use native isolated IndexedDB; no real user import/deletion or physical mobile drag validation'}));
}finally{await context.close();await browser.close();}
