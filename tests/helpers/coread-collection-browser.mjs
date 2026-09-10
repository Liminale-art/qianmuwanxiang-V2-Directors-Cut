// Real shelf handlers and dialog adapters; synthetic host transport and books only.
import assert from 'node:assert/strict';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export async function checkCollectionMutationBrowser(page) {
  await page.evaluate(functions=>{
    window.MODAL_ID='story-director-modal';window.RUNTIME_LOCK_KEY='shelfRuntime';window.shelfRuntime={};window.coreadOpenRequestId=0;
    const baseRender=window.renderModal;
    window.renderModal=()=>{window.shelfRenders++;baseRender();};
    window.uid=()=> 'new-folder';window.toast=(...args)=>shelfNotices.push(args);
    function openDialog(content,initial){
      const dialog=document.createElement('dialog');dialog.id='shelf-popup-fixture';
      dialog.style.cssText='box-sizing:border-box;width:min(320px,90vw)';
      if(typeof content==='string')dialog.textContent=content;else dialog.append(content);
      if(initial!==undefined){const input=document.createElement('input');input.id='shelf-name-fixture';input.value=initial;input.style.width='90%';dialog.append(input);}
      const ok=document.createElement('button'),cancel=document.createElement('button');ok.textContent='确定';cancel.textContent='取消';
      ok.id='shelf-popup-ok';cancel.id='shelf-popup-cancel';dialog.append(ok,cancel);document.body.append(dialog);dialog.showModal();
      return new Promise(resolve=>{
        const finish=value=>{dialog.close();dialog.remove();resolve(value);};
        ok.onclick=()=>finish(initial!==undefined?dialog.querySelector('input').value:true);
        cancel.onclick=()=>finish(initial!==undefined?null:false);
        dialog.oncancel=event=>{event.preventDefault();cancel.click();};
      });
    }
    class Popup {constructor(content){this.content=content;}show(){return openDialog(this.content);}}
    Popup.show={input:(title,text,value)=>openDialog(title+' '+text,value),confirm:(title,text)=>openDialog(title+' '+text)};
    window.ctx=()=>({Popup,POPUP_TYPE:{CONFIRM:1}});
    window.eval(functions);
    window.prepareCollectionMutation=()=>{
      window.coread=()=>shelfData;resetShelfFixture();window.settings={enabled:true,coread:shelfData};window.coread=()=>settings.coread;
      shelfRuntime={};coreadOpenRequestId++;document.getElementById(MODAL_ID).classList.add('open');
      shelfData.libViewMode='list';renderModal();window.shelfRenders=0;window.shelfNotices=[];shelfCalls=[];
    };
  },['promptInput','confirmDialog','coreadCaptureCollectionMutation','coreadCreateCollection','coreadRenameCollection','coreadDissolveCollection','coreadChooseCollectionForBooks'].map(section).join('\n'));
  const results=[];
  for(const width of [320,360,430,1100])for(const action of ['create','rename','dissolve','move','nested'])for(const change of ['none','normalize','reopen','owner','runtime','changed','cancel']){
    if(action==='create'&&change==='changed')continue;
    await page.setViewportSize({width,height:898});await page.evaluate(()=>prepareCollectionMutation());
    const selectors={create:'.sd-reader-collection-create',rename:'.sd-reader-collection-edit',dissolve:'.sd-reader-collection-dissolve'};
    if(action==='move'||action==='nested'){
      await page.locator('.sd-reader-book-check[data-book="a"]').check();await page.locator('.sd-reader-batch-collect').tap();
      await page.locator('.sd-reader-collection-pick').selectOption(action==='move'?'folder':'__new__');
      if(action==='nested'){await page.locator('#shelf-popup-ok').tap();await page.locator('#shelf-name-fixture').waitFor();}
    }else await page.locator(selectors[action]).tap();
    await page.locator('#shelf-popup-fixture').waitFor();
    if(['create','rename','nested'].includes(action))await page.locator('#shelf-name-fixture').fill('New collection');
    await page.evaluate(({change,action})=>{
      if(change==='normalize')coreadCollections();
      if(change==='reopen')renderModal();
      if(change==='owner')settings={enabled:true,coread:structuredClone(shelfData)};
      if(change==='runtime')shelfRuntime={};
      if(change==='changed'){
        if(action==='move')shelfData.collections=[];
        else if(action==='nested')shelfData.books=shelfData.books.filter(b=>b.id!=='a');
        else shelfData.collections[0].name='Concurrent change';
      }
      window.collectionBefore={data:JSON.stringify([shelfData,settings.coread]),renders:shelfRenders};
    },{change,action});
    await page.locator(change==='cancel'?'#shelf-popup-cancel':'#shelf-popup-ok').tap();
    await page.evaluate(()=>new Promise(r=>setTimeout(r,0)));
    const result=await page.evaluate(()=>({before:collectionBefore,data:JSON.stringify([shelfData,settings.coread]),
      saves:shelfCalls.filter(c=>c[0]==='save').length,renders:shelfRenders,notices:shelfNotices,collections:settings.coread.collections}));
    const label=width+':'+action+':'+change;
    if(!['none','normalize'].includes(change)){
      assert.equal(result.data,result.before.data,label);assert.equal(result.saves,0,label);assert.equal(result.renders,result.before.renders,label);
      assert.equal(result.notices.length,change==='changed'?1:0,label);
    }else{
      assert.equal(result.saves,action==='nested'?2:1,label);assert.equal(result.renders,1,label);
      if(action==='create'||action==='nested')assert.equal(result.collections.at(-1).name,'New collection',label);
      if(action==='rename')assert.equal(result.collections[0].name,'New collection',label);
      if(action==='dissolve')assert.equal(result.collections.length,0,label);
      if(action==='move')assert.ok(result.collections[0].bookIds.includes('a'),label);
      if(action==='nested')assert.deepEqual(result.collections.at(-1).bookIds,['a'],label);
    }
    assert.equal(await page.locator('#shelf-popup-fixture').count(),0,label);results.push({width,action,change});
  }
  return {cases:results.length,realHandlers:true,realDialogAdapters:true,hostPopup:'synthetic',results};
}
