import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionOutboxRuntime} from './qianmu-text-collection-outbox-runtime.js';
import {textCollectionDisplayLabel,textCollectionListLabel,textCollectionRecord,TEXT_COLLECTION_LIMITS} from './qianmu-text-collection.js';
import {applyCollectionProseStyle,collectionIconButton,collectionEditorText,collectionEditorValue} from './qianmu-text-collection-presentation.js';
import {textCollectionParagraphs} from './qianmu-text-collection-paragraphs.js';

// Account originals only. Browsing never loads a chat or resolves its character.
export async function openTextCollectionLibrary({parent,resolveNamespace,isCurrent,headers,copy,download,sourceElement}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||typeof isCurrent!=='function')throw TypeError('收藏管理环境不可用');
  let closed=false,busy=false,record=null,operation=null,pageIndex=0,cursors=[null],nextCursor=null,searchValue='',resolve,session,outbox;
  let selecting=false,searchTimer=null,pendingSearch=null,exporter=null,viewEpoch=0,backgroundReading=null,pendingRevalidation=null,listSignature='';
  let pageRequest=null,backgroundRequest=null;
  const selected=new Map(),deletions=new Map();
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const announceChange=()=>document.dispatchEvent(new view.Event('qianmu-text-collections-changed'));
  async function setup(){
    if(session)return;
    const ready=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:view.crypto});
    if(!current()){ready.close();throw Error('收藏页面已关闭');}
    session=ready;outbox=createTextCollectionOutboxRuntime({session,isCurrent:current});
  }
  const dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog qm-text-collection-panel qm-text-collection-library';dialog.setAttribute('aria-label','正文收藏');
  dialog.innerHTML='<header><strong data-collection-title>正文收藏</strong><div class="qm-text-collection-header-tools"></div></header><main><div class="qm-text-collection-search"><input type="search" maxlength="160" placeholder="搜索关键词" aria-label="搜索收藏"></div><div data-collection-list></div><section data-collection-detail hidden><div class="qm-text-collection-prose" data-collection-prose></div><textarea data-collection-editor aria-label="收藏正文" readonly hidden></textarea></section></main><footer><p role="status" aria-live="polite" data-collection-status></p><div class="qm-text-collection-actions qm-text-collection-paging" data-collection-pages></div><div class="qm-text-collection-actions qm-text-collection-detail-actions" data-collection-detail-actions hidden></div></footer>';
  const q=selector=>dialog.querySelector(selector),list=q('[data-collection-list]'),detail=q('[data-collection-detail]'),editor=q('[data-collection-editor]'),prose=q('[data-collection-prose]'),status=q('[data-collection-status]');
  const searchRow=q('.qm-text-collection-search'),search=searchRow.querySelector('input'),title=q('[data-collection-title]');
  const icon=(action,label,name)=>collectionIconButton(document,action,label,name);
  q('.qm-text-collection-header-tools').append(icon('close','关闭','x'));
  searchRow.append(icon('refresh','刷新','arrows-clockwise'),icon('select','多选收藏','checks'),icon('delete-selected','删除所选','trash'));
  q('[data-collection-manage="select"]').setAttribute('aria-pressed','false');
  q('[data-collection-pages]').append(icon('prev','上一页','arrow-left'),icon('next','下一页','arrow-right'));
  const actions=q('[data-collection-detail-actions]'),right=document.createElement('div');right.className='qm-text-collection-header-tools';
  right.append(icon('image','存为图片','image'),icon('copy','复制','copy'),icon('edit','编辑','pencil-simple'),icon('save','保存修改','floppy-disk'));
  actions.append(icon('back','返回列表','arrow-left'),right);
  editor.maxLength=TEXT_COLLECTION_LIMITS.text;editor.spellcheck=false;applyCollectionProseStyle(dialog,sourceElement,parent);
  const finished=new Promise(done=>{resolve=done;}),focused=document.activeElement;
  const editorText=()=>record?collectionEditorValue(record.text,editor.value):editor.value;
  const dirty=()=>record&&!editor.readOnly&&editorText()!==record.text;
  function controls(){
    dialog.setAttribute('aria-busy',String(busy));editor.disabled=busy;
    for(const button of dialog.querySelectorAll('button'))button.disabled=busy&&button.dataset.collectionManage!=='close';
    q('[data-collection-manage="prev"]').disabled=busy||pageIndex===0;q('[data-collection-manage="next"]').disabled=busy||!nextCursor;
    q('[data-collection-manage="save"]').hidden=!record||editor.readOnly;
    q('[data-collection-manage="edit"]').hidden=Boolean(record&&!editor.readOnly);
    q('[data-collection-manage="delete-selected"]').hidden=!selecting;
    q('[data-collection-manage="delete-selected"]').disabled=busy||!selected.size;
    q('[data-collection-manage="select"]').setAttribute('aria-pressed',String(selecting));
    for(const row of list.querySelectorAll('[data-collection-id]')){
      row.classList.toggle('is-selected',selected.has(row.dataset.collectionId));
      if(selecting)row.setAttribute('aria-pressed',String(selected.has(row.dataset.collectionId)));else row.removeAttribute('aria-pressed');
    }
  }
  function stop(){
    if(closed)return;closed=true;view.clearTimeout(searchTimer);pageRequest?.abort();backgroundRequest?.abort();pendingRevalidation=null;exporter?.stop();outbox?.close();session?.close();observer.disconnect();view.removeEventListener('pagehide',stop);
    dialog.removeEventListener('click',click);dialog.removeEventListener('keydown',stopEscape);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);search.removeEventListener('input',searchChanged);
    if(dialog.open)dialog.close();dialog.remove();
    if(focused?.isConnected&&document.visibilityState!=='hidden')focused.focus({preventScroll:true});resolve(null);
  }
  async function run(work){
    if(busy||!current())return;busy=true;viewEpoch++;controls();if(!list.children.length&&!record)status.textContent='正在读取…';
    try{await setup();await session.guard();await work();}
    catch(cause){if(!current()||['st_account_storage_account','text_collection_sync_account'].includes(cause?.code)){stop();return;}if(session)try{await session.guard();}catch{stop();return;}
      if(/^(?:text_collection_sync|st_account_storage)_cancelled$/.test(cause?.code||'')&&(searchTimer!==null||pendingSearch!==null))return;
      status.textContent=/^text_collection_/.test(cause?.code||'')?String(cause.message).slice(0,240):'读取未完成，请点击刷新重试';}
    finally{busy=false;if(!closed){controls();if(pendingSearch!==null&&!record){const query=pendingSearch;pendingSearch=null;void run(()=>loadPage(0,true,query));}}}
  }
  function displayRecord(){
    title.textContent=textCollectionListLabel(record);title.title=title.textContent;
    editor.value=collectionEditorText(record.text);editor.readOnly=true;editor.hidden=true;prose.hidden=false;
    const fragment=document.createDocumentFragment();
    for(const item of textCollectionParagraphs(record.text)){const paragraph=document.createElement('p');paragraph.textContent=item.text;fragment.append(paragraph);}
    prose.replaceChildren(fragment);applyCollectionProseStyle(dialog,sourceElement,parent);
  }
  function showList(){
    title.textContent='正文收藏';title.removeAttribute('title');list.hidden=false;detail.hidden=true;searchRow.hidden=false;
    q('[data-collection-pages]').hidden=false;actions.hidden=true;
  }
  function displayPage(page,index,reset,query){
    searchValue=query;if(reset)cursors=[null];pageIndex=index;nextCursor=page.nextCursor;record=null;operation=null;editor.value='';
    selected.clear();deletions.clear();
    const fragment=document.createDocumentFragment();
    for(const item of page.items){
      const row=document.createElement('button');row.type='button';row.className='qm-text-collection-row';row.dataset.collectionId=item.id;row.dataset.collectionRevision=String(item.revision);
      const label=document.createElement('span'),preview=document.createElement('small');
      label.textContent=textCollectionDisplayLabel(item.charName,item.userName,item.createdAt);preview.textContent=item.preview;row.title=label.textContent;row.append(label,preview);fragment.append(row);
    }
    list.replaceChildren(fragment);listSignature=JSON.stringify(page);showList();
    status.textContent=`共 ${page.total} 条收藏${page.total?` · 第 ${pageIndex+1} 页`:''}`;
  }
  function revalidatePage(input,index,query,force=false){
    if(backgroundReading){pendingRevalidation={input,index,query,token:viewEpoch};return;}
    if(!force&&!session.readCacheNeedsRefresh?.())return;
    const token=viewEpoch,request=new view.AbortController();backgroundRequest=request;
    backgroundReading=Promise.resolve().then(async()=>{
      try{
        const page=await session.list(input,{revalidate:true,signal:request.signal});
        if(!current()||token!==viewEpoch||record||selecting||busy||search.value.trim()!==query)return;
        if(JSON.stringify(page)!==listSignature){displayPage(page,index,false,query);controls();}
      }catch(cause){
        if(!current()||request.signal.aborted)return;
        if(['st_account_storage_account','text_collection_sync_account'].includes(cause?.code)){stop();return;}
        try{await session.guard();}catch{stop();return;}
        if(token===viewEpoch&&!record)status.textContent='已显示本次会话的收藏，后台更新未完成；可点击刷新';
      }finally{
        if(backgroundRequest===request){
          backgroundRequest=null;backgroundReading=null;
          const pending=pendingRevalidation;pendingRevalidation=null;
          // The old read cannot validate a newer displayed query, even when it
          // refreshed the shared cache before this page finished rendering.
          if(pending&&current()&&pending.token===viewEpoch&&!record&&pageIndex===pending.index&&search.value.trim()===pending.query)
            revalidatePage(pending.input,pending.index,pending.query,true);
        }
      }
    });
  }
  async function loadPage(index=0,reset=false,query=searchValue){
    const cursor=reset?null:cursors[index],input={cursor,limit:50,...query?{search:query}:{}};
    const overlappedBackground=Boolean(backgroundReading);
    const request=new view.AbortController();pageRequest?.abort();pageRequest=request;
    try{const page=await session.list(input,{preferCache:true,signal:request.signal});if(!current()||request.signal.aborted)return;
      displayPage(page,index,reset,query);revalidatePage(input,index,query,overlappedBackground);
    }finally{if(pageRequest===request)pageRequest=null;}
  }
  async function openRecord(id){
    const result=await session.get(id,{preferCache:true});if(!current())return;
    if(!result.record){status.textContent='此收藏已被删除，请刷新列表';return;}
    record=result.record;operation=null;displayRecord();list.hidden=true;detail.hidden=false;searchRow.hidden=true;
    q('[data-collection-pages]').hidden=true;actions.hidden=false;status.textContent='';
  }
  function searchChanged(){
    view.clearTimeout(searchTimer);
    pageRequest?.abort();backgroundRequest?.abort();pendingSearch=null;
    searchTimer=view.setTimeout(()=>{searchTimer=null;pendingSearch=search.value.trim();if(!busy){const query=pendingSearch;pendingSearch=null;void run(()=>loadPage(0,true,query));}},220);
  }
  async function deleteSelected(){
    let count=0;
    // Revision and mutation stay fixed for each chosen item. A lost receipt is
    // retried identically; a concurrent edit is never silently overwritten.
    for(const [id,revision] of [...selected]){
      let deletion=deletions.get(id);if(!deletion){deletion=session.prepareDelete(id,revision);deletions.set(id,deletion);}
      try{await deletion.submit();}
      catch(cause){await session.guard();if(count)announceChange();status.textContent=`已删除 ${count} 条；${/^text_collection_/.test(cause?.code||'')?String(cause.message).slice(0,180):'其余未确认，请重试'}`;return;}
      if(!current())return;
      count++;selected.delete(id);deletions.delete(id);list.querySelectorAll('[data-collection-id]').forEach(row=>{if(row.dataset.collectionId===id)row.remove();});
    }
    if(count)announceChange();
    try{await loadPage(0,true);status.textContent+=` · 已删除 ${count} 条收藏`;}
    catch{await session.guard();list.replaceChildren();record=null;showList();cursors=[null];pageIndex=0;nextCursor=null;status.textContent='收藏已删除，列表暂未刷新；请点击刷新';}
  }
  async function click(event){
    const button=event.target.closest?.('button');if(!button||!dialog.contains(button))return;
    const action=button.dataset.collectionManage,id=button.dataset.collectionId;
    if(action==='close'){stop();return;}if(busy)return;
    if(action==='select'){selecting=!selecting;selected.clear();deletions.clear();status.textContent='';controls();return;}
    if(id&&selecting){if(selected.has(id)){selected.delete(id);deletions.delete(id);}else selected.set(id,Number(button.dataset.collectionRevision));status.textContent=selected.size?`已选 ${selected.size} 条`:'';controls();return;}
    await run(async()=>{
      if(id){view.clearTimeout(searchTimer);pendingSearch=null;search.value=searchValue;return openRecord(id);}
      if(action==='refresh'){session.invalidateReadCache?.();view.clearTimeout(searchTimer);pendingSearch=null;return loadPage(0,true,search.value.trim());}
      if(action==='delete-selected')return deleteSelected();
      if(action==='prev'&&pageIndex>0)return loadPage(pageIndex-1);
      if(action==='next'&&nextCursor){cursors[pageIndex+1]=nextCursor;return loadPage(pageIndex+1);}
      if(!record)return;
      if(action==='edit'){editor.readOnly=false;editor.hidden=false;prose.hidden=true;status.textContent='';editor.focus();return;}
      if(action==='back'){pendingSearch=null;return loadPage(pageIndex);}
      if(action==='copy'){await (copy||((text)=>view.navigator.clipboard.writeText(text)))(editorText());await session.guard();status.textContent='已复制';return;}
      if(action==='image'){
        const {openTextCollectionImageExport}=await import('./qianmu-text-collection-image-export.js');if(!current())return;
        exporter=openTextCollectionImageExport({parent:dialog,record:{...record,text:editorText()},isCurrent:current,guard:session.guard,download});status.textContent='';return;
      }
      if(action==='save'){
        if(!dirty()){displayRecord();operation=null;status.textContent='内容未改变';return;}
        if(operation?.request.operation!=='edit'||operation.request.text!==editorText())operation=session.prepareEdit(record.id,record.revision,editorText());
        let ack;try{ack=await outbox.save(operation.request,{base:record});}
        catch(cause){if(cause?.localSaved===true){status.textContent=`保存未完成，当前内容已保留。${/^text_collection_sync_/.test(cause?.code||'')?String(cause.message).slice(0,160):'请重试。'}`;return;}throw cause;}
        if(!current())return;
        record=textCollectionRecord({...record,text:operation.request.text,revision:ack.revision,updatedAt:ack.updatedAt});operation=null;cursors=[null];pageIndex=0;displayRecord();announceChange();status.textContent='收藏修改已保存';return;
      }
    });
  }
  const cancel=event=>{event.preventDefault();stop();};
  const stopEscape=event=>{if(event.key==='Escape')event.stopPropagation();if(event.target===search&&event.key==='Enter'&&!event.isComposing){event.preventDefault();view.clearTimeout(searchTimer);pendingSearch=search.value.trim();if(!busy){const query=pendingSearch;pendingSearch=null;void run(()=>loadPage(0,true,query));}}};
  const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected)stop();});
  dialog.addEventListener('click',click);dialog.addEventListener('keydown',stopEscape);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);search.addEventListener('input',searchChanged);view.addEventListener('pagehide',stop);
  parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
  try{dialog.showModal();void run(()=>loadPage(0,true));}catch(cause){stop();throw cause;}
  return {element:dialog,finished,stop,dispose:stop};
}
