import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Run after the existing delete harness. All bodies live in the intercepted QA origin's IndexedDB.
export async function checkCollectionDeleteBrowser(page) {
  const qa=new URL('../../dist/local-qa/reader-library/',import.meta.url);
  await mkdir(qa,{recursive:true});
  await page.evaluate(async()=>{
    const [{createQianmuAppearanceSession},{updateAppearancePreferences}]=await Promise.all([
      import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js')]);
    window.collectionDeleteAppearance=createQianmuAppearanceSession({readSettings:()=>settings,
      loadStyles:()=>({promise:Promise.resolve(true),cancel(){}}),loadFont:()=>({promise:Promise.resolve(true),cancel(){}})});
    collectionDeleteAppearance.mount(document.getElementById(MODAL_ID));
    const dissolve=coreadDissolveCollection;
    window.coreadDissolveCollection=async(...args)=>{try{return await dissolve(...args);}finally{deleteFinished=true;}};
    window.prepareCollectionDelete=async({family,mode,scenario})=>{
      await prepareBookDelete('collection-fixture');
      shelfData.books.find(book=>book.id==='a').title='孤岛来信';
      shelfData.books.find(book=>book.id==='f').title='合集内书籍';
      shelfData.collections[0].name='旅途';
      shelfData.collections.push({id:'empty',name:'空合集',bookIds:[],createdAt:1,updatedAt:1});
      await nativeBooks.putBook('f',{meta:{title:'合集内书籍'},fullText:'Body retained when its collection is removed',chapters:[{}]});
      shelfData.libViewMode=scenario.startsWith('grid-')?'grid':'list';renderModal();
      settings.theme=mode;
      const root=document.getElementById(MODAL_ID);root.classList.remove('sd-theme-light','sd-theme-dark');root.classList.add('sd-theme-'+mode);
      settings.appearance=updateAppearancePreferences(settings,{family,mode,source:'manual',accent:'#7789a6'});await collectionDeleteAppearance.sync();
      window.collectionDeleteBefore={data:JSON.stringify(settings.coread),renders:shelfRenders};shelfCalls=[];
    };
  });
  const scenarios=['grid-empty-delete','grid-empty-cancel','folders-only','mixed','mixed-cancel','mixed-profile','mixed-page','mixed-runtime','mixed-folder-change','mixed-memory-change'];
  let assertions=0;const ok=(value,label)=>{assert.ok(value,label);assertions++;};
  for(const family of ['classic','editorial','glass'])for(const mode of ['light','dark'])for(const width of [320,393,1100])for(const scenario of scenarios){
    const label=`${family}/${mode}/${width}/${scenario}`,grid=scenario.startsWith('grid-'),mixed=scenario.startsWith('mixed');
    await page.setViewportSize({width,height:898});await page.evaluate(args=>prepareCollectionDelete(args),{family,mode,scenario});
    if(grid){
      const button=page.locator('.sd-reader-collection-card[data-collection="empty"] .sd-reader-collection-dissolve');
      ok(await button.isVisible(),label+' empty collection has direct delete');
      if(family==='glass'&&mode==='light'&&width===393&&scenario==='grid-empty-delete')await page.screenshot({path:fileURLToPath(new URL('glass-light-393-empty-collection-delete.png',qa))});
      await button.click();
      ok(await page.evaluate(()=>shelfData.libCollectionId)==='',label+' tool does not enter collection');
    }else{
      ok(await page.locator('.sd-reader-collection-check:visible').count()===0,label+' folder checks initially hidden');
      await page.locator('.sd-reader-batch-mode').focus();await page.keyboard.press('Enter');
      await page.locator('.sd-reader-collection-row[data-collection="folder"] .sd-reader-row-title').click();
      ok(await page.locator('.sd-reader-collection-check[data-collection="folder"]').isChecked(),label+' folder row selects without entering');
      ok(await page.evaluate(()=>shelfData.libCollectionId)==='',label+' multiselect stays at root');
      if(mixed)await page.locator('.sd-reader-book-check[data-book="a"]').check();
      else await page.locator('.sd-reader-collection-check[data-collection="empty"]').check();
      ok(await page.locator('.sd-reader-batch-count').innerText()==='2',label+' count includes folders');
      ok(await page.locator('.sd-reader-batch-collect').isDisabled(),label+' folders are not silently nested');
      if(family==='glass'&&mode==='light'&&width===393&&scenario==='mixed')await page.screenshot({path:fileURLToPath(new URL('glass-light-393-mixed-selection.png',qa))});
      await page.locator('.sd-reader-batch-delete').click();
    }
    await page.locator('#shelf-popup-fixture').waitFor();
    const prompt=await page.locator('#shelf-popup-fixture').innerText();
    ok(prompt.includes('确定删除')&&prompt.includes('书籍保留在书架中'),label+' same confirmation explicitly preserves collection contents');
    if(mixed)ok(prompt.includes('孤岛来信')&&prompt.includes('正文、阅读进度和伴读对话'),label+' mixed confirmation distinguishes explicit books');
    if(family==='glass'&&mode==='light'&&width===393&&scenario==='mixed')await page.locator('#shelf-popup-fixture').screenshot({path:fileURLToPath(new URL('glass-light-393-mixed-delete-confirm.png',qa))});
    await page.evaluate(scenario=>{
      if(scenario==='mixed-profile')settings={...settings,coread:structuredClone(settings.coread)};
      if(scenario==='mixed-page')renderModal();
      if(scenario==='mixed-runtime')shelfRuntime={};
      if(scenario==='mixed-folder-change')settings.coread.collections.find(c=>c.id==='folder').name='Changed while confirming';
      window.expectedAfterInterruption=JSON.stringify(settings.coread);
    },scenario);
    await page.locator(scenario.endsWith('-cancel')?'#shelf-popup-cancel':'#shelf-popup-ok').click();
    if(scenario==='mixed'||scenario==='mixed-memory-change'){
      await page.locator('#shelf-popup-fixture h3').waitFor();
      if(scenario==='mixed-memory-change')await page.evaluate(()=>{
        settings.coread.collections.find(c=>c.id==='folder').bookIds.push('b');
        window.expectedAfterInterruption=JSON.stringify(settings.coread);
      });
      await page.locator('#shelf-popup-cancel').click(); // Explicit "保留记忆" action, not canceling the deletion.
    }
    await page.waitForFunction(()=>deleteFinished);
    const state=await page.evaluate(async()=>({data:JSON.stringify(settings.coread),expected:expectedAfterInterruption,
      ids:settings.coread.books.map(b=>b.id),folders:settings.coread.collections.map(c=>c.id),
      bodyA:!!await nativeBooks.getBook('a'),bodyF:!!await nativeBooks.getBook('f'),calls:deleteCalls,
      saves:shelfCalls.filter(c=>c[0]==='save').length}));
    const success=['grid-empty-delete','folders-only','mixed'].includes(scenario);
    if(success){
      ok(state.saves===(scenario==='mixed'?2:1),label+' only expected writes occur');
      if(scenario==='grid-empty-delete')ok(!state.folders.includes('empty')&&state.folders.includes('folder'),label+' only selected empty folder removed');
      if(scenario==='folders-only')ok(state.folders.length===0&&state.ids.length===3&&state.calls.length===0,label+' selected folders removed without book cleanup');
      if(scenario==='mixed')ok(!state.folders.includes('folder')&&state.folders.includes('empty')&&!state.ids.includes('a')&&!state.bodyA&&state.ids.includes('b'),label+' mixed removes only explicit book and chosen folder');
    }else{
      ok(state.data===state.expected&&state.saves===0,label+' cancellation/stale owner makes no writes');
      ok(state.bodyA&&state.calls.length===0,label+' canceled or stale batch never starts book cleanup');
    }
    ok(state.bodyF&&state.ids.includes('f')&&!state.calls.includes('body:f'),label+' collection book is never recursively deleted');
    ok(await page.locator('#shelf-popup-fixture').count()===0,label+' dialog closed');
    ok(await page.locator('.sd-reader-lib').evaluate(el=>el.scrollWidth<=el.clientWidth+1),label+' no panel overflow');
  }
  // Explicitly selecting an inner book remains distinct from implicitly selecting its collection.
  await page.evaluate(async()=>{await prepareCollectionDelete({family:'glass',mode:'light',scenario:'mixed'});window.overlapResult=null;void coreadRequestDeleteBooks(['f'],['folder']).then(result=>overlapResult=result);});
  await page.locator('#shelf-popup-ok').click();await page.locator('#shelf-popup-fixture h3').waitFor();await page.locator('#shelf-popup-cancel').click();
  await page.waitForFunction(()=>overlapResult!==null);
  ok(await page.evaluate(async()=>overlapResult&&!coreadBookMeta('f')&&!shelfData.collections.some(c=>c.id==='folder')&&!await nativeBooks.getBook('f')&&!!await nativeBooks.getBook('a')),'explicit inner book deletion updates own collection guard without clearing unrelated books');
  await page.evaluate(()=>collectionDeleteAppearance.reset());
  return {assertions,scenarios:scenarios.length*18+1,realEntryHandlers:true,realConfirmation:true,nativeIsolatedBooks:true};
}
