// Real editor/handlers, synthetic ST popup transport and data. No host database or network.
import assert from 'node:assert/strict';
import {storyboardFunctionSource} from './storyboard-form-fixture.mjs';

export async function checkDictionaryMutationBrowser(page){
  await page.evaluate(functions=>{
    const baseRender=window.rerenderMore;
    window.rerenderMore=()=>{calls.renders=(calls.renders||0)+1;baseRender();};
    window.dictionaryChat='A';window.getChatKey=()=>dictionaryChat;
    window.dictionaryHost={POPUP_TYPE:{INPUT:1,CONFIRM:2}};
    dictionaryHost.Popup=class{
      constructor(content,type,initial){this.content=content;this.type=type;this.initial=initial;}
      show(){
        const dialog=document.createElement('dialog');dialog.id='dictionary-popup-fixture';
        if(typeof this.content==='string')dialog.innerHTML=this.content;else dialog.append(this.content);
        if(this.type===1){const input=document.createElement('input');input.id='dictionary-name-fixture';input.value=this.initial;dialog.append(input);}
        document.body.append(dialog);dialog.showModal();
        return new Promise(resolve=>{window.answerDictionary=value=>{dialog.close();dialog.remove();resolve(value);};});
      }
    };
    window.ctx=()=>dictionaryHost;
    window.confirmDialog=(title,message)=>new dictionaryHost.Popup(title+' '+message,2,'').show();
    window.eval(functions);
    window.prepareDictionary=()=>{
      document.querySelector('.sd-reader-morepage').hidden=false;dictionaryChat='A';dictionaryFixtureRuntime={};readerView={bookId:'book'};
      coreadOpenRequestId++;resetInject();store.coreadDictBound=['custom"'];rerenderMore();
      calls.save=0;calls.metadata=0;calls.invalidate=0;calls.renders=0;calls.notices=[];
    };
  },['coreadPromptText','coreadOpenDictEntryDialog'].map(storyboardFunctionSource).join('\n'));
  const results=[];
  const actions={add:'dictbook-add',rename:'dictbook-rename',delete:'dictbook-delbtn',rowDelete:'dict-row-del',entryAdd:'dict-addentry',entryEdit:'dict-row-edit'};
  for(const width of [320,360,430,1100])for(const [action,selector]of Object.entries(actions))for(const change of ['none','normalize','chat','reopen','identity','runtime','changed']){
    if(change==='changed'&&action==='add')continue;
    await page.setViewportSize({width,height:850});await page.evaluate(()=>prepareDictionary());
    await page.locator('.sd-reader-'+selector).tap();await page.locator('#dictionary-popup-fixture').waitFor();
    if(action.startsWith('entry')){
      if(action==='entryEdit')assert.equal(await page.locator('.sd-reader-de-canon').inputValue(),'关键词<&');
      await page.locator('.sd-reader-de-canon').fill('new-key');await page.locator('.sd-reader-de-aliases').fill('一，二、new-key');
      assert.equal(await page.locator('.sd-reader-de-preview').textContent(),'一二new-key');
    }
    await page.evaluate(change=>{
      if(change==='normalize')memory.dictBooks=memory.dictBooks.map(d=>({...d,pairs:coreadNormalizeSynonyms(d.pairs)}));
      if(change==='chat'){dictionaryChat='B';window.store={coreadDictBound:['custom"','other']};}
      if(change==='reopen'){const n=document.querySelector('.sd-reader-morepage');n.hidden=true;n.hidden=false;rerenderMore();}
      if(change==='identity'){coreadOpenRequestId++;readerView={bookId:'book',companion:'new'};}
      if(change==='runtime')dictionaryFixtureRuntime={};
      if(change==='changed')memory.dictBooks[1].pairs.other=['newer'];
      window.beforeDictionary={data:JSON.stringify([memory,store]),renders:calls.renders};
    },change);
    await page.evaluate(async action=>{answerDictionary(['add','rename'].includes(action)?' New dictionary ':true);await new Promise(resolve=>setTimeout(resolve,0));},action);
    const result=await page.evaluate(()=>({data:JSON.stringify([memory,store]),before:beforeDictionary,save:calls.save,metadata:calls.metadata,invalidate:calls.invalidate,renders:calls.renders,notices:calls.notices,books:memory.dictBooks,bound:store.coreadDictBound}));
    const label=width+':'+action+':'+change;
    if(!['none','normalize'].includes(change)){
      assert.equal(result.data,result.before.data,label);assert.equal(result.save,0,label);assert.equal(result.metadata,0,label);assert.equal(result.invalidate,0,label);assert.equal(result.renders,result.before.renders,label);
      assert.equal(result.notices.length,change==='changed'?1:0,label);if(change==='changed')assert.equal(result.notices[0][1],'warning',label);
    }else{
      assert.equal(result.save,1,label);assert.equal(result.renders,1,label);assert.equal(result.notices.length,1,label);
      if(action==='add')assert.equal(result.books[2].name,'New dictionary',label);
      if(action==='rename')assert.equal(result.books[1].name,'New dictionary',label);
      if(action==='delete'){assert.equal(result.books.length,1,label);assert.deepEqual(result.bound,[],label);}
      if(action==='rowDelete')assert.deepEqual(result.books[1].pairs,{},label);
      if(action.startsWith('entry'))assert.deepEqual(result.books[1].pairs['new-key'],['一','二'],label);
    }
    results.push({width,action,change});
  }
  return {cases:results.length,results,realEditor:true,popupTransport:'synthetic',realHostData:false};
}
