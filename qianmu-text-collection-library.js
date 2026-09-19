import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionOutboxRuntime} from './qianmu-text-collection-outbox-runtime.js';
import {textCollectionDisplayLabel,textCollectionListLabel,textCollectionRecord,TEXT_COLLECTION_LIMITS} from './qianmu-text-collection.js';

// Account originals only. Browsing never loads a chat, resolves a character or fetches every text body.
export async function openTextCollectionLibrary({parent,resolveNamespace,isCurrent,headers,confirm,copy,download}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||typeof isCurrent!=='function'||typeof confirm!=='function')throw TypeError('收藏管理环境不可用');
  let closed=false,busy=false,record=null,operation=null,pendingText=null,pendingView=null,pageIndex=0,cursors=[null],nextCursor=null,searchValue='',resolve;
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:view.crypto});
  const outbox=createTextCollectionOutboxRuntime({session,isCurrent:current});
  const dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog';dialog.setAttribute('aria-label','正文收藏');
  dialog.innerHTML='<header><strong>正文收藏</strong><button type="button" data-collection-manage="close">关闭</button></header><main><div data-collection-list></div><section data-collection-detail hidden><p data-collection-title></p><textarea data-collection-editor aria-label="收藏正文" readonly></textarea><div class="qm-text-collection-actions"><button type="button" data-collection-manage="copy">复制</button><button type="button" data-collection-manage="edit">编辑</button><button type="button" data-collection-manage="delete">删除</button></div></section></main><footer><p role="status" aria-live="polite" data-collection-status></p><div class="qm-text-collection-actions" data-collection-pages><button type="button" data-collection-manage="prev">上一页</button><button type="button" data-collection-manage="refresh">刷新列表</button><button type="button" data-collection-manage="next">下一页</button></div><div class="qm-text-collection-actions" data-collection-detail-actions hidden><button type="button" data-collection-manage="back">返回列表</button><button type="button" data-collection-manage="reload">重新载入</button><button type="button" data-collection-manage="save" hidden>保存修改</button></div></footer>';
  const q=selector=>dialog.querySelector(selector),list=q('[data-collection-list]'),detail=q('[data-collection-detail]'),editor=q('[data-collection-editor]'),status=q('[data-collection-status]');
  const pendingButton=document.createElement('button');pendingButton.type='button';pendingButton.dataset.collectionManage='pending';pendingButton.textContent='本机待存';q('header strong').after(pendingButton);
  const searchRow=document.createElement('div');searchRow.className='qm-text-collection-search';
  searchRow.innerHTML='<input type="search" maxlength="160" placeholder="搜索姓名或正文" aria-label="搜索收藏"><button type="button" data-collection-manage="search">搜索</button><button type="button" data-collection-manage="clear-search">清除</button>';
  list.before(searchRow);const search=searchRow.querySelector('input');
  editor.maxLength=TEXT_COLLECTION_LIMITS.text;editor.spellcheck=false;
  const finished=new Promise(done=>{resolve=done;}),focused=document.activeElement;
  const dirty=()=>record&&!editor.readOnly&&editor.value!==record.text.replace(/\r\n?/g,'\n');
  function controls(){
    dialog.setAttribute('aria-busy',String(busy));editor.disabled=busy;search.disabled=busy;
    for(const button of dialog.querySelectorAll('button'))button.disabled=busy&&button.dataset.collectionManage!=='close';
    q('[data-collection-manage="prev"]').disabled=busy||pageIndex===0;q('[data-collection-manage="next"]').disabled=busy||!nextCursor;
    q('[data-collection-manage="save"]').hidden=!record||editor.readOnly;
  }
  function stop(){
    if(closed)return;closed=true;pendingView?.dispose();outbox.close();session.close();observer.disconnect();view.removeEventListener('pagehide',stop);
    dialog.removeEventListener('click',click);dialog.removeEventListener('keydown',stopEscape);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);
    if(dialog.open)dialog.close();dialog.remove();
    if(focused?.isConnected&&document.visibilityState!=='hidden')focused.focus({preventScroll:true});resolve(null);
  }
  async function discard(){return !dirty()||await confirm(pendingText===editor.value?'离开编辑':'放弃修改',pendingText===editor.value?'修改已保留在本机待存，尚未同步；离开不会删除待存。继续吗？':`此收藏有未保存的文字，放弃当前修改吗？${pendingText!==null?'此前提交的本机待存仍会保留。':''}`)===true;}
  async function run(work){
    if(busy||!current())return;busy=true;controls();status.textContent='正在读取…';
    try{await session.guard();await work();}
    catch(cause){if(!current()){stop();return;}try{await session.guard();}catch{stop();return;}
      status.textContent=/^text_collection_/.test(cause?.code||'')?String(cause.message).slice(0,240):'操作未确认，请保留当前内容后重试';}
    finally{busy=false;if(!closed)controls();}
  }
  async function loadPage(index=0,reset=false,query=searchValue){
    const cursor=reset?null:cursors[index];const page=await session.list({cursor,limit:50,...query?{search:query}:{}});if(!current())return;
    searchValue=query;search.value=query;searchRow.hidden=false;
    if(reset)cursors=[null];pageIndex=index;nextCursor=page.nextCursor;record=null;operation=null;pendingText=null;editor.value='';
    const fragment=document.createDocumentFragment();
    for(const item of page.items){
      const row=document.createElement('button');row.type='button';row.className='qm-text-collection-row';row.dataset.collectionId=item.id;
      const title=document.createElement('span'),preview=document.createElement('small');
      title.textContent=textCollectionDisplayLabel(item.charName,item.userName,item.createdAt);preview.textContent=item.preview;row.title=title.textContent;row.append(title,preview);fragment.append(row);
    }
    list.replaceChildren(fragment);list.hidden=false;detail.hidden=true;q('[data-collection-pages]').hidden=false;q('[data-collection-detail-actions]').hidden=true;
    status.textContent=`共 ${page.total} 条收藏${page.total?` · 第 ${pageIndex+1} 页`:''}`;
  }
  async function openRecord(id){
    const result=await session.get(id);if(!current())return;
    if(!result.record){status.textContent='此收藏已被删除，请刷新列表';return;}
    record=result.record;operation=null;pendingText=null;editor.value=record.text;editor.readOnly=true;
    q('[data-collection-title]').textContent=textCollectionListLabel(record);list.hidden=true;detail.hidden=false;searchRow.hidden=true;
    q('[data-collection-pages]').hidden=true;q('[data-collection-detail-actions]').hidden=false;status.textContent='收藏原件独立保存；编辑不会改动聊天正文';
  }
  async function click(event){
    const button=event.target.closest?.('button');if(!button||!dialog.contains(button))return;
    const action=button.dataset.collectionManage,id=button.dataset.collectionId;
    if(action==='close'){if(await discard())stop();return;}if(busy)return;
    await run(async()=>{
      if(action==='pending'){
        const module=await import('./qianmu-text-collection-outbox-view.js');if(!current())return;
        pendingView=module.openTextCollectionOutbox({parent,session,outbox,isCurrent:current,copy,confirm,download});
        try{await pendingView.finished;}finally{pendingView?.dispose();pendingView=null;}
        if(current())status.textContent='待存查看已关闭；可刷新服务器列表核对已确认的收藏';return;
      }
      if(id)return openRecord(id);
      if(action==='refresh')return loadPage(0,true);
      if(action==='search'||action==='clear-search')return loadPage(0,true,action==='search'?search.value.trim():'');
      if(action==='prev'&&pageIndex>0)return loadPage(pageIndex-1);
      if(action==='next'&&nextCursor){cursors[pageIndex+1]=nextCursor;return loadPage(pageIndex+1);}
      if(!record)return;
      if(action==='edit'){editor.readOnly=false;status.textContent='修改仅作用于此收藏';editor.focus();return;}
      if(action==='back'||action==='reload'){if(await discard()){await session.guard();return action==='back'?loadPage(0,true):openRecord(record.id);}status.textContent='已保留当前修改';return;}
      if(action==='copy'){await (copy||((text)=>view.navigator.clipboard.writeText(text)))(editor.value);await session.guard();status.textContent='已复制';return;}
      if(action==='save'){
        if(!dirty()){editor.readOnly=true;operation=null;status.textContent='内容未改变';return;}
        if(operation?.request.operation!=='edit'||operation.request.text!==editor.value)operation=session.prepareEdit(record.id,record.revision,editor.value);
        let ack;try{ack=await outbox.save(operation.request,{base:record});}
        catch(cause){if(cause?.localSaved===true){pendingText=operation.request.text;status.textContent=`本机待存已保留，服务器未确认；可重试或离开。${cause.message}`;return;}throw cause;}
        if(!current())return;
        record=textCollectionRecord({...record,text:operation.request.text,revision:ack.revision,updatedAt:ack.updatedAt});operation=null;pendingText=null;editor.readOnly=true;status.textContent='收藏修改已保存';return;
      }
      if(action==='delete'){
        if(await confirm('删除收藏','仅删除此收藏原件，不影响原聊天。确认删除吗？')!==true){status.textContent='未删除';return;}
        await session.guard();if(operation?.request.operation!=='delete')operation=session.prepareDelete(record.id,record.revision);
        await operation.submit();if(!current())return;record=null;operation=null;editor.value='';
        try{await loadPage(0,true);status.textContent+=' · 已删除收藏';}
        catch{await session.guard();list.replaceChildren();list.hidden=false;detail.hidden=true;searchRow.hidden=false;q('[data-collection-pages]').hidden=false;q('[data-collection-detail-actions]').hidden=true;
          cursors=[null];pageIndex=0;nextCursor=null;status.textContent='收藏已删除，列表暂未刷新；请点击刷新列表';}
      }
    });
  }
  const cancel=event=>{event.preventDefault();void discard().then(ok=>{if(ok)stop();});};
  const stopEscape=event=>{if(event.key==='Escape')event.stopPropagation();if(event.target===search&&event.key==='Enter'&&!event.isComposing){event.preventDefault();q('[data-collection-manage="search"]').click();}};
  const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected)stop();});
  dialog.addEventListener('click',click);dialog.addEventListener('keydown',stopEscape);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);view.addEventListener('pagehide',stop);
  parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
  try{await session.guard();dialog.showModal();void run(()=>loadPage(0,true));}catch(cause){stop();throw cause;}
  return {element:dialog,finished,stop,dispose:stop};
}
