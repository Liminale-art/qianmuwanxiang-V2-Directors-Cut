import {textCollectionDisplayLabel} from './qianmu-text-collection.js';

// Local pending originals are not server-confirmed records. Browsing this view
// makes no service request; only an explicit retry submits the saved identity.
export function openTextCollectionOutbox({parent,session,outbox,isCurrent,copy,confirm}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||!session||!outbox||typeof isCurrent!=='function'||typeof confirm!=='function')throw TypeError('收藏待存页面不可用');
  let closed=false,busy=false,rows=[],selected=null,page=0,resolve;
  const controller=new view.AbortController(),focused=document.activeElement,finished=new Promise(done=>{resolve=done;});
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog';dialog.dataset.collectionOutbox='';dialog.setAttribute('aria-label','本机待存');
  dialog.innerHTML='<header><strong>本机待存</strong><button type="button" data-pending-action="close">关闭</button></header><main><p>仅保留在当前浏览器与账户；不是已同步的收藏。</p><div data-pending-list></div><section data-pending-detail hidden><p data-pending-title></p><textarea aria-label="待存原文" readonly></textarea></section></main><footer><p data-pending-status role="status" aria-live="polite"></p><div class="qm-text-collection-actions" data-pending-pages><button type="button" data-pending-action="prev">上一页</button><button type="button" data-pending-action="refresh">刷新</button><button type="button" data-pending-action="next">下一页</button></div><div class="qm-text-collection-actions" data-pending-tools hidden><button type="button" data-pending-action="back">返回列表</button><button type="button" data-pending-action="copy">复制</button><button type="button" data-pending-action="retry">重试保存</button></div></footer>';
  const q=selector=>dialog.querySelector(selector),list=q('[data-pending-list]'),detail=q('[data-pending-detail]'),editor=q('textarea'),status=q('[data-pending-status]');
  const localActions=document.createElement('div');localActions.className='qm-text-collection-actions';localActions.hidden=true;localActions.style.marginTop='8px';
  localActions.innerHTML='<button type="button" data-pending-action="remove">移除此机待存</button>';q('footer').append(localActions);
  const text=row=>Object.hasOwn(row.request,'text')?row.request.text:row.request.record.text;
  const original=row=>row.base||row.request.record;
  const label=row=>{const item=original(row);return textCollectionDisplayLabel(item.source.charName,item.source.userName,item.createdAt);};
  const stateLabel=row=>row.state==='conflict'?'版本冲突':row.started?'结果待核对':'待提交';
  function controls(){
    dialog.setAttribute('aria-busy',String(busy));
    for(const button of dialog.querySelectorAll('button'))button.disabled=busy&&button.dataset.pendingAction!=='close';
    q('[data-pending-action="prev"]').disabled=busy||page===0;q('[data-pending-action="next"]').disabled=busy||(page+1)*50>=rows.length;
    q('[data-pending-action="retry"]').disabled=busy||!selected||selected.state==='conflict';
  }
  function stop(){
    if(closed)return;closed=true;controller.abort();observer.disconnect();view.removeEventListener('pagehide',stop);
    dialog.removeEventListener('click',click);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);dialog.removeEventListener('keydown',key);
    if(dialog.open)dialog.close();dialog.remove();if(focused?.isConnected&&document.visibilityState!=='hidden')focused.focus({preventScroll:true});resolve(null);
  }
  async function run(work){
    if(busy||!current())return;busy=true;controls();status.textContent='正在读取…';
    try{await session.guard();if(!current())return;await work();}
    catch(cause){if(!current())return;try{await session.guard();}catch{stop();return;}
      status.textContent=/^text_collection_/.test(cause?.code||'')?String(cause.message).slice(0,240):'操作未确认；本机待存仍保留，请刷新核对';
    }finally{busy=false;if(current())controls();}
  }
  async function load(index=0){
    rows=await outbox.list();if(!current())return;rows.sort((a,b)=>b.queuedAt-a.queuedAt||a.request.mutationId.localeCompare(b.request.mutationId));
    page=Math.min(Math.max(0,index),Math.max(0,Math.ceil(rows.length/50)-1));selected=null;editor.value='';
    const fragment=document.createDocumentFragment();
    for(const row of rows.slice(page*50,page*50+50)){
      const button=document.createElement('button');button.type='button';button.className='qm-text-collection-row';button.dataset.pendingId=row.request.mutationId;
      const title=document.createElement('span'),preview=document.createElement('small');title.textContent=`${label(row)} · ${stateLabel(row)}`;
      const snippet=Array.from(text(row).replace(/\s+/g,' ').trim());preview.textContent=snippet.slice(0,100).join('')+(snippet.length>100?'…':'');button.append(title,preview);fragment.append(button);
    }
    list.replaceChildren(fragment);list.hidden=false;detail.hidden=true;localActions.hidden=true;q('[data-pending-pages]').hidden=false;q('[data-pending-tools]').hidden=true;
    status.textContent=`本机待存 ${rows.length} 条${rows.length?` · 第 ${page+1} 页`:''}`;
  }
  async function click(event){
    const button=event.target.closest?.('button');if(!button||!dialog.contains(button))return;const action=button.dataset.pendingAction,id=button.dataset.pendingId;
    if(action==='close'){stop();return;}
    await run(async()=>{
      if(id){selected=(await outbox.list()).find(row=>row.request.mutationId===id);if(!current())return;if(!selected)return load(page);
        editor.value=text(selected);q('[data-pending-title]').textContent=label(selected);list.hidden=true;detail.hidden=false;localActions.hidden=false;q('[data-pending-pages]').hidden=true;q('[data-pending-tools]').hidden=false;
        status.textContent=selected.state==='conflict'?'版本冲突；本机修改与编辑前原件均保留，不覆盖另一端内容。':selected.started?'上次提交结果待核对；重试使用原编号，不重复创建。':'尚未提交服务器，可重试保存。';return;
      }
      if(action==='back'||action==='refresh')return load(page);
      if(action==='prev')return load(page-1);if(action==='next')return load(page+1);
      if(!selected)return;
      if(action==='copy'){await (copy||((value)=>view.navigator.clipboard.writeText(value)))(text(selected));await session.guard();if(current())status.textContent='已复制待存原文';return;}
      if(action==='remove'){
        const snapshot=selected,unknown=snapshot.started&&snapshot.state!=='conflict';
        const warning='仅移除当前设备的这条待存文字及编辑前原件；不会删除服务器收藏，也不会改动聊天。移除后不能撤销，请先复制或备份需要的内容。';
        if(await confirm('移除此机待存',warning+(unknown?' 上次提交结果未知，服务器仍可能已保存；移除此机记录不等于取消原请求。':''))!==true){if(current())status.textContent='未移除，本机待存仍保留';return;}
        await session.guard();if(!current())return;
        const result=await outbox.remove(snapshot,{confirmed:true,acceptUnconfirmed:unknown});if(!current())return;await load(page);
        if(current())status.textContent+=result.removed?' · 已移除此机待存，未删除服务器内容':' · 此待存已不存在';return;
      }
      if(action==='retry'&&selected.state!=='conflict'){
        try{await outbox.submit(selected.request.mutationId,{signal:controller.signal});}
        catch(cause){const latest=(await outbox.list()).find(row=>row.request.mutationId===selected.request.mutationId);if(latest)selected=latest;throw cause;}
        if(!current())return;await load(page);if(current())status.textContent+=' · 服务器已确认保存';
      }
    });
  }
  const cancel=event=>{event.preventDefault();stop();},key=event=>{if(event.key==='Escape')event.stopPropagation();};
  const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected)stop();});
  dialog.addEventListener('click',click);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);dialog.addEventListener('keydown',key);view.addEventListener('pagehide',stop);
  parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
  try{dialog.showModal();void run(()=>load());}catch(cause){stop();throw cause;}
  return {element:dialog,finished,stop,dispose:stop};
}
