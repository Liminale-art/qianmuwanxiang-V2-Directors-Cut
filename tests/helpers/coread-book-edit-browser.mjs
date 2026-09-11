import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export async function checkBookEditBrowser(page) {
  const source=await readFile(new URL('../../qianmu-blobstore.js',import.meta.url),'utf8');
  await page.evaluate(async({source,functions})=>{
    window.nativeBooks=await import('data:text/javascript,'+encodeURIComponent(source));
    window.MODULE_NAME='isolated-book-edit';window.eval(functions);
    window.prepareBookEdit=async scenario=>{
      prepareCollectionMutation();window.editScenario=scenario;window.editEntered=false;window.editResult=null;window.editFinished=false;
      window.editGate=new Promise(resolve=>window.releaseEdit=resolve);
      await nativeBooks.putBook('a',{meta:{title:'Alpha <book>',author:'作者甲',mode:'text'},fullText:'Original body',chapters:[{title:'Chapter'}],comicDescriptions:{one:'keep'}});
      if(scenario==='missing')await nativeBooks.deleteBook('a');
      window.blobStore={...blobStore,updateBookMetadata:async(...args)=>{
        editEntered=true;await editGate;
        if(editScenario==='failure')throw Error('Synthetic storage failure');
        const result=await nativeBooks.updateBookMetadata(...args);editResult=result;
        if(editScenario==='committed-owner')settings={enabled:true,coread:structuredClone(settings.coread)};
        return result;
      }};
      window.editBefore=JSON.stringify(settings.coread);
    };
    const edit=window.coreadEditBookInfo;
    window.coreadEditBookInfo=async(...args)=>{try{return await edit(...args);}finally{editFinished=true;}};
  },{source,functions:['coreadCollectionForBook','coreadEditBookInfo'].map(section).join('\n')});
  const results=[];
  for(const width of [320,360,430,1100])for(const scenario of ['normal','cancel','empty','missing','popup-owner','popup-page','popup-target','wait-owner','wait-delete','wait-body','failure','committed-owner']){
    await page.setViewportSize({width,height:898});await page.evaluate(s=>prepareBookEdit(s),scenario);
    await page.locator('.sd-reader-card-edit[data-book="a"]').tap();await page.locator('.sd-reader-bookedit-form').waitFor();
    const boxes=await page.locator('.sd-reader-bookedit-form input, .sd-reader-bookedit-form select').evaluateAll(els=>els.map(el=>{const b=el.getBoundingClientRect();return {x:b.x,right:b.right};}));
    assert.ok(boxes.every(b=>b.x>=0&&b.right<=width+1),`${width}:${scenario}:form overflow`);
    await page.locator('.sd-reader-bookedit-title').fill(scenario==='empty'?'  ':'Renamed');
    await page.locator('.sd-reader-bookedit-author').fill('New writer');await page.locator('.sd-reader-bookedit-collection').selectOption('folder');
    await page.evaluate(scenario=>{
      if(scenario==='popup-owner')settings={enabled:true,coread:structuredClone(settings.coread)};
      if(scenario==='popup-page')renderModal();
      if(scenario==='popup-target')settings.coread.collections=[];
      window.editAfterExternal=JSON.stringify(settings.coread);window.editRenderBefore=shelfRenders;
    },scenario);
    await page.locator(scenario==='cancel'?'#shelf-popup-cancel':'#shelf-popup-ok').tap();
    const early=['cancel','empty','popup-owner','popup-page','popup-target'].includes(scenario);
    if(!early){
      await page.waitForFunction(()=>editEntered);
      await page.evaluate(async scenario=>{
        if(scenario==='wait-owner')settings={enabled:true,coread:structuredClone(settings.coread)};
        if(scenario==='wait-delete'){settings.coread.books=settings.coread.books.filter(b=>b.id!=='a');await nativeBooks.deleteBook('a');}
        if(scenario==='wait-body'){
          const rec=await nativeBooks.getBook('a');await nativeBooks.putBook('a',{...rec,fullText:'Newest body',comicDescriptions:{two:'new'}});
          settings.coread.books.find(b=>b.id==='a').progress=81;
        }
        editAfterExternal=JSON.stringify(settings.coread);releaseEdit();
      },scenario);
    }
    await page.waitForFunction(()=>editFinished);
    const result=await page.evaluate(async()=>({body:await nativeBooks.getBook('a'),data:JSON.stringify(settings.coread),book:settings.coread.books.find(b=>b.id==='a'),
      afterExternal:editAfterExternal,saves:shelfCalls.filter(c=>c[0]==='save').length,renders:shelfRenders-editRenderBefore,notices:shelfNotices,entered:editEntered}));
    const label=`${width}:${scenario}`,success=['normal','missing','wait-body'].includes(scenario);
    if(success){
      assert.equal(result.book.title,'Renamed',label);assert.equal(result.book.author,'New writer',label);assert.equal(result.saves,1,label);assert.equal(result.renders,1,label);
      if(scenario==='missing'){assert.equal(result.body,undefined,label);assert.match(result.notices.at(-1)[0],/仅更新书架信息/,label);}
      else {assert.equal(result.body.meta.title,'Renamed',label);assert.equal(result.body.fullText,scenario==='wait-body'?'Newest body':'Original body',label);}
      if(scenario==='wait-body'){assert.equal(result.book.progress,81,label);assert.deepEqual(result.body.comicDescriptions,{two:'new'},label);}
    }else{
      assert.equal(result.data,result.afterExternal,label);assert.equal(result.saves,0,label);assert.equal(result.renders,0,label);assert.ok(result.notices.every(n=>n[1]!=='success'),label);
      if(scenario==='wait-delete')assert.equal(result.body,undefined,label);
      else assert.equal(result.body.meta.title,scenario==='committed-owner'?'Renamed':'Alpha <book>',label);
      if(scenario==='committed-owner')assert.match(result.notices.at(-1)[0],/正文信息已保存.*书架/,label);
      if(early)assert.equal(result.entered,false,label);
    }
    results.push({width,scenario});
  }
  return {cases:results.length,realEditor:true,realIndexedDB:true,results,limits:'synthetic host Popup, synthetic books; settings persistence is an observed stub, not a server save'};
}
