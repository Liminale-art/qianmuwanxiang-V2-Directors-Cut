import assert from 'node:assert/strict';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

// Used after the shelf editor fixture creates nativeBooks in a fresh intercepted origin.
export async function checkBookDeleteBrowser(page) {
  await page.evaluate(functions=>{
    window.eval(functions);
    const request=coreadRequestDeleteBooks;
    window.coreadRequestDeleteBooks=async(...args)=>{try{return await request(...args);}finally{deleteFinished=true;}};
    window.prepareBookDelete=async scenario=>{
      prepareCollectionMutation();window.deleteFinished=false;window.deleteCalls=[];window.saveEntered=false;
      window.coreadMemoryWrites=0;window.coreadIdentitySwitchBusy=false;window.coreadWorldSyncBusy=false;window.coreadDistilling=false;window.coreadAutoTextInFlight=false;
      window.dialogBusy=false;window.readerAssistantBusy=false;window.coreadComicVisionBusy=false;window.readerView=null;window.coreadEchoTtl=new Map();
      window.readerDialog={bookId:'a',bucket:'fixture::a',loaded:true,slices:['unsaved fixture slice']};
      const gate=new Promise(resolve=>window.releasePreserve=resolve);
      window.coreadSaveDialog=async()=>{saveEntered=true;deleteCalls.push('preserve');return scenario.startsWith('save-')?await gate:true;};
      window.unmountReaderPortal=()=>deleteCalls.push('unmount');window.coreadInvalidatePool=()=>{};
      window.coreadClearBookDialogue=async()=>{deleteCalls.push('clear-dialog');return {};};window.coreadPurgeBookMemory=async()=>{deleteCalls.push('purge-memory');return {};};
      for(const id of ['a','b'])await nativeBooks.putBook(id,{meta:{title:id},fullText:'Synthetic body',chapters:[{}]});
      window.blobStore={...blobStore,deleteBook:async id=>{
        deleteCalls.push('body:'+id);await nativeBooks.deleteBook(id);
        if(scenario==='next-book'&&id==='a')settings.coread.books.find(b=>b.id==='b').title='Changed after first removal';
      },deleteReaderImages:async()=>deleteCalls.push('images')};
      window.deleteBefore={data:JSON.stringify(settings.coread),renders:shelfRenders};
    };
  },['coreadChooseDeleteMemory','coreadCanDeleteBooks','coreadRequestDeleteBooks','coreadDeleteBook'].map(section).join('\n'));
  const results=[];
  const scenarios=['single-keep','single-purge','batch','cancel','confirm-owner','confirm-page','memory-owner','memory-page','memory-replaced','memory-busy','save-failed','save-owner','save-dialogue','next-book'];
  for(const width of [320,360,430,1100])for(const scenario of scenarios){
    await page.setViewportSize({width,height:898});await page.evaluate(s=>prepareBookDelete(s),scenario);
    const batch=['batch','next-book'].includes(scenario);
    if(batch){for(const id of ['a','b'])await page.locator(`.sd-reader-book-check[data-book="${id}"]`).check();await page.locator('.sd-reader-batch-delete').tap();}
    else await page.locator('.sd-reader-card-del[data-book="a"]').tap();
    await page.locator('#shelf-popup-fixture').waitFor();
    const box=await page.locator('#shelf-popup-fixture').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    if(scenario.startsWith('confirm-'))await page.evaluate(s=>{if(s==='confirm-owner')settings={enabled:true,coread:structuredClone(settings.coread)};else renderModal();},scenario);
    await page.locator(scenario==='cancel'?'#shelf-popup-cancel':'#shelf-popup-ok').tap();
    if(!['cancel','confirm-owner','confirm-page'].includes(scenario)){
      await page.locator('#shelf-popup-fixture h3').waitFor();
      await page.evaluate(s=>{
        if(s==='memory-owner')settings={enabled:true,coread:structuredClone(settings.coread)};
        if(s==='memory-page')renderModal();
        if(s==='memory-replaced')settings.coread.books[0]={...settings.coread.books[0]};
        if(s==='memory-busy')coreadMemoryWrites=1;
      },scenario);
      // The second cancel-labelled fixture button is the product's explicit "保留记忆" choice.
      await page.locator(scenario==='single-purge'?'#shelf-popup-ok':'#shelf-popup-cancel').tap();
      if(scenario.startsWith('save-')){
        await page.waitForFunction(()=>saveEntered);
        await page.evaluate(s=>{if(s==='save-owner')settings={enabled:true,coread:structuredClone(settings.coread)};if(s==='save-dialogue')readerDialog={bookId:'b',loaded:true};releasePreserve(s!=='save-failed');},scenario);
      }
    }
    await page.waitForFunction(()=>deleteFinished);
    const result=await page.evaluate(async()=>({data:JSON.stringify(settings.coread),before:deleteBefore,ids:settings.coread.books.map(b=>b.id),
      bodyA:!!await nativeBooks.getBook('a'),bodyB:!!await nativeBooks.getBook('b'),calls:deleteCalls,saves:shelfCalls.filter(c=>c[0]==='save').length,renders:shelfRenders,notices:shelfNotices}));
    const label=width+':'+scenario,admitted=['single-keep','single-purge','batch','next-book'].includes(scenario);
    if(admitted){
      assert.equal(result.bodyA,false,label);assert.equal(result.bodyB,scenario!=='batch',label);assert.equal(result.ids.includes('a'),false,label);
      assert.equal(result.calls.includes('purge-memory'),scenario==='single-purge',label);
      assert.equal(result.saves,scenario==='batch'?2:1,label);assert.equal(result.renders,result.before.renders+1,label);
      if(scenario==='next-book')assert.match(result.notices.at(-1)[0],/1\/2.*停止/,label);
    }else{
      assert.equal(result.data,result.before.data,label);assert.equal(result.bodyA,true,label);assert.equal(result.bodyB,true,label);
      assert.equal(result.saves,0,label);assert.equal(result.renders,result.before.renders+(scenario.endsWith('-page')?1:0),label);
      assert.ok(result.calls.every(c=>c==='preserve'),label);assert.ok(result.notices.every(n=>!/已从书架移除/.test(n[0])),label);
    }
    assert.equal(await page.locator('#shelf-popup-fixture').count(),0,label);results.push({width,scenario});
  }
  return {cases:results.length,realDeleteEntry:true,nativeIsolatedBooks:true,results,limits:'synthetic host Popup, settings and dialogue/world-book cleanup; no real data deleted and cleanup completeness not validated'};
}
