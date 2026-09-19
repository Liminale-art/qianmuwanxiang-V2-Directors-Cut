import {textCollectionDisplayLabel} from './qianmu-text-collection.js';
import {readTextCollectionOutboxBackupFile} from './qianmu-text-collection-outbox-backup.js';

// Local pending originals are not server-confirmed records. Browsing this view
// makes no service request; retry and confirmed conflict copies submit stable identities.
export function openTextCollectionOutbox({parent,session,outbox,isCurrent,copy,confirm,download}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||!session||!outbox||typeof isCurrent!=='function'||typeof confirm!=='function')throw TypeError('收藏待存页面不可用');
  let closed=false,busy=false,rows=[],selected=null,page=0,resolve;
  const controller=new view.AbortController(),focused=document.activeElement,finished=new Promise(done=>{resolve=done;});
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog';dialog.dataset.collectionOutbox='';dialog.setAttribute('aria-label','本机待存');
  dialog.innerHTML='<header><strong>本机待存</strong><button type="button" data-pending-action="close">关闭</button></header><main><p>仅保留在当前浏览器与账户；不是已同步的收藏。</p><div data-pending-list></div><section data-pending-detail hidden><p data-pending-title></p><textarea aria-label="待存原文" readonly></textarea></section></main><footer><p data-pending-status role="status" aria-live="polite"></p><div class="qm-text-collection-actions" data-pending-pages><button type="button" data-pending-action="prev">上一页</button><button type="button" data-pending-action="refresh">刷新</button><button type="button" data-pending-action="next">下一页</button></div><div class="qm-text-collection-actions" data-pending-tools hidden><button type="button" data-pending-action="back">返回列表</button><button type="button" data-pending-action="copy">复制</button><button type="button" data-pending-action="retry">重试保存</button></div></footer>';
  const q=selector=>dialog.querySelector(selector),list=q('[data-pending-list]'),detail=q('[data-pending-detail]'),editor=q('textarea'),status=q('[data-pending-status]');
  const localActions=document.createElement('div');localActions.className='qm-text-collection-actions';localActions.hidden=true;localActions.style.marginTop='8px';
  localActions.innerHTML='<button type="button" data-pending-action="keep-copy">保留为新副本</button><button type="button" data-pending-action="remove">移除此机待存</button>';q('footer').append(localActions);
  const backupActions=document.createElement('div');backupActions.className='qm-text-collection-actions';backupActions.style.marginBottom='10px';
  backupActions.innerHTML='<button type="button" data-pending-action="export">导出待存</button><button type="button" data-pending-action="import">导入待存备份</button><input type="file" accept=".json,application/json" aria-label="导入本机待存备份" hidden>';
  list.before(backupActions);const fileInput=backupActions.querySelector('input');
  const check=()=>{if(!current())throw Object.assign(new Error('待存页面已关闭，未继续备份操作'),{code:'text_collection_sync_account'});};
  const text=row=>Object.hasOwn(row.request,'text')?row.request.text:row.request.record.text;
  const original=row=>row.base||row.request.record;
  const label=row=>{const item=original(row);return textCollectionDisplayLabel(item.source.charName,item.source.userName,item.createdAt);};
  const stateLabel=row=>(row.request.operation==='restore'&&Object.hasOwn(row.request,'text')?'副本 · ':'')+(row.state==='conflict'?'版本冲突':row.started?'结果待核对':'待提交');
  function controls(){
    dialog.setAttribute('aria-busy',String(busy));
    for(const button of dialog.querySelectorAll('button'))button.disabled=busy&&button.dataset.pendingAction!=='close';
    q('[data-pending-action="prev"]').disabled=busy||page===0;q('[data-pending-action="next"]').disabled=busy||(page+1)*50>=rows.length;
    q('[data-pending-action="retry"]').disabled=busy||!selected||selected.state==='conflict';
    q('[data-pending-action="keep-copy"]').hidden=!selected||selected.state!=='conflict';
    q('[data-pending-action="export"]').disabled=busy||typeof download!=='function';fileInput.disabled=busy;
  }
  function stop(){
    if(closed)return;closed=true;controller.abort();observer.disconnect();view.removeEventListener('pagehide',stop);
    dialog.removeEventListener('click',click);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);dialog.removeEventListener('keydown',key);
    fileInput.removeEventListener('change',importFile);
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
    if(action==='import'){if(!busy&&current()){fileInput.value='';fileInput.click();}return;}
    await run(async()=>{
      if(action==='export'){
        if(typeof download!=='function')return;
        const result=await outbox.backup();check();
        if(!result.count){status.textContent='没有可导出的本机待存';return;}
        if(await confirm('导出本机待存',`将下载 ${result.count} 条待存请求，包含私人正文、修改前原件、姓名及来源标识。文件未加密，请妥善保管；不是服务器已确认收藏的备份。是否继续？`)!==true){if(current())status.textContent='未导出，本机内容不变';return;}
        await session.guard();check();
        const stamp=new Date(result.payload.exportedAt).toISOString().replace(/[:.]/g,'-');await download(result.blob,`qianmu-text-collection-outbox-${stamp}.json`);
        if(current())status.textContent=`已发起 ${result.count} 条待存的下载，请确认浏览器已保存文件；本机内容未移除`;return;
      }
      if(id){selected=(await outbox.list()).find(row=>row.request.mutationId===id);if(!current())return;if(!selected)return load(page);
        editor.value=text(selected);q('[data-pending-title]').textContent=label(selected);list.hidden=true;detail.hidden=false;localActions.hidden=false;q('[data-pending-pages]').hidden=true;q('[data-pending-tools]').hidden=false;
        status.textContent=selected.state==='conflict'?'版本冲突；本机修改与编辑前原件均保留，不覆盖另一端内容。':selected.started?'上次提交结果待核对；重试使用原编号，不重复创建。':'尚未提交服务器，可重试保存。';return;
      }
      if(action==='back'||action==='refresh')return load(page);
      if(action==='prev')return load(page-1);if(action==='next')return load(page+1);
      if(!selected)return;
      if(action==='copy'){await (copy||((value)=>view.navigator.clipboard.writeText(value)))(text(selected));await session.guard();if(current())status.textContent='已复制待存原文';return;}
      if(action==='keep-copy'&&selected.state==='conflict'){
        const snapshot=selected;
        if(await confirm('保留为新副本','将本机冲突文字保存为独立收藏，保留原姓名、日期与来源，不覆盖服务器原件。重试沿用同一副本编号；确认保存后移除此条本机冲突记录。')!==true){if(current())status.textContent='未创建副本，冲突内容仍保留';return;}
        await session.guard();if(!current())return;
        try{await outbox.keepCopy(snapshot,{confirmed:true,signal:controller.signal});}
        catch(cause){if(cause?.code==='text_collection_sync_contract')throw Object.assign(new Error('后端未接受副本格式，请核对并更新千幕后端；本机内容仍保留'),{code:cause.code});throw cause;}
        if(!current())return;await load(page);if(current())status.textContent+=' · 新副本已保存，原收藏未覆盖';return;
      }
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
  async function importFile(){
    const file=fileInput.files?.[0];fileInput.value='';if(!file)return;
    await run(async()=>{
      let payload;try{payload=await readTextCollectionOutboxBackupFile(file,{check});}
      catch(cause){throw Object.assign(new Error(`待存备份未导入：${String(cause?.message||'文件无效').slice(0,180)}`),{code:'text_collection_sync_pending_backup'});}
      await session.guard();check();
      if(payload.namespace!==outbox.namespace){status.textContent='备份属于另一账户，请切回原账户导入；本机内容未改动';return;}
      if(await confirm('导入本机待存',`将 ${payload.entries.length} 条请求合并到当前账户的此浏览器，保留原编号、冲突与待核对状态，不覆盖已有内容。不会自动提交服务器；导入后请逐条核对并手动重试。是否继续？`)!==true){if(current())status.textContent='未导入，本机内容不变';return;}
      await session.guard();check();const result=await outbox.importBackup(payload,{confirmed:true});check();await load();
      if(current())status.textContent=`已导入本机待存 ${result.added} 条，已有 ${result.duplicates} 条；未向服务器提交`;
    });
  }
  const cancel=event=>{event.preventDefault();stop();},key=event=>{if(event.key==='Escape')event.stopPropagation();};
  const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected)stop();});
  dialog.addEventListener('click',click);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);dialog.addEventListener('keydown',key);view.addEventListener('pagehide',stop);
  fileInput.addEventListener('change',importFile);
  parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
  try{dialog.showModal();void run(()=>load());}catch(cause){stop();throw cause;}
  return {element:dialog,finished,stop,dispose:stop};
}
