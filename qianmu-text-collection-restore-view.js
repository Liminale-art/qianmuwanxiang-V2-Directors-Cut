import {readTextCollectionBackupFile} from './qianmu-text-collection-backup.js';
import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionRestoreBatch} from './qianmu-text-collection-restore-batch.js';
import {createTextCollectionCleanupBatch} from './qianmu-text-collection-cleanup-batch.js';

export const openTextCollectionRestore=options=>openTextCollectionOperation({...options,operation:'restore'});
export const openTextCollectionCleanup=options=>openTextCollectionOperation({...options,operation:'cleanup'});

// Shared dialog lifetime/progress; restore and cleanup keep separate admission and mutation controllers.
function openTextCollectionOperation({parent,file,resolveNamespace,isCurrent,headers,confirm,check,operation,otherModules=0}={}){
  if(!parent?.isConnected||typeof isCurrent!=='function'||typeof confirm!=='function'||typeof check!=='function')throw TypeError('收藏操作页面不可用');
  const cleanup=operation==='cleanup',verb=cleanup?'清理':'恢复';
  const document=parent.ownerDocument,view=document.defaultView,focused=document.activeElement;
  let closed=false,busy=true,closing=false,session=null,batch=null,resolve;
  const finished=new Promise(done=>{resolve=done;}),dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog';dialog.setAttribute('aria-label','恢复正文收藏');
  dialog.innerHTML='<header><strong>恢复正文收藏</strong><button type="button" data-collection-restore="close">关闭</button></header><main><p data-collection-restore-file></p><p>仅新增独立副本，不覆盖已有收藏。服务器已确认的副本不会因关闭窗口而撤销。</p><p>发生中断时，请保留本窗口重试；关闭或刷新后不能自动续接。</p></main><footer><p role="status" aria-live="polite" data-collection-status></p><div class="qm-text-collection-actions"><button type="button" data-collection-restore="run" disabled>确认恢复</button></div></footer>';
  const q=s=>dialog.querySelector(s),status=q('[data-collection-status]'),runButton=q('[data-collection-restore="run"]');
  dialog.dataset.collectionOperation=operation;dialog.setAttribute('aria-label',`${verb}正文收藏`);q('header strong').textContent=`${verb}正文收藏`;runButton.textContent=`确认${verb}`;
  if(cleanup){const notes=q('main').querySelectorAll('p');notes[1].textContent='删除当前账户的收藏原件，不影响聊天。不可恢复，请先备份；同步回执保留，文件不一定归零或变小。';notes[2].textContent=`中断请保留窗口重试；关闭或刷新后不能续接。${otherModules>0?`同时勾选的其他 ${otherModules} 个模块本次不执行。`:''}`;}
  q('[data-collection-restore-file]').textContent=String(file?.name||'收藏备份');
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const guard=()=>{check();if(!current())throw Error(`收藏${verb}页面已关闭`);};
  const pending=()=>{const p=batch?.progress;return Boolean(p&&(busy||p.uncertain||p.confirmed>0&&p.confirmed<p.total));};
  const summary=()=>{const p=batch?.progress;return p?`已确认 ${p.confirmed} / ${p.total} 条${p.uncertain?`；当前批次回执未确认，重试不会${cleanup?'扩大清理范围':'重复新增'}`:''}`:'';};
  function controls(){dialog.setAttribute('aria-busy',String(busy));runButton.disabled=busy||!batch||batch.progress.confirmed===batch.progress.total;}
  function stop(){
    if(closed)return;closed=true;batch?.close();session?.close();observer.disconnect();view.removeEventListener('pagehide',stop);view.removeEventListener('beforeunload',unload);
    dialog.removeEventListener('click',click);dialog.removeEventListener('keydown',key);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);
    if(dialog.open)dialog.close();dialog.remove();if(focused?.isConnected&&document.visibilityState!=='hidden')focused.focus({preventScroll:true});resolve(batch?.progress||null);
  }
  async function requestClose(){
    if(closing||closed)return;closing=true;
    try{if(!pending()||await confirm(`停止并关闭${verb}`,`${summary()}。关闭将停止后续提交；已完成的${verb}不会撤回，尚未确认的请求可能已写入。关闭后无法沿用本次进度自动续接，确定关闭吗？`)===true)stop();}
    catch{if(current())status.textContent=`未能确认关闭，请重试；当前${verb}进度仍保留。`;}
    finally{closing=false;}
  }
  async function run(){
    if(busy||!batch||!current())return;busy=true;controls();status.textContent=`正在核对${verb}能力与当前账户…`;
    try{guard();const result=await batch.run();guard();status.textContent=result.status==='complete'?`${summary()} · ${verb}完成`:`${summary()} · 未开始${verb}`;runButton.textContent=`继续${verb}`;}
    catch(cause){if(!current()){stop();return;}try{guard();await session.guard();}catch{stop();return;}
      status.textContent=`${summary()}。${String(cause?.message||`${verb}未完成，请保留窗口重试`).slice(0,240)}${cleanup&&cause?.code==='text_collection_sync_conflict'?' 请关闭此窗口后重新盘点；不会强删新版本。':''}`;runButton.textContent='重试未确认部分';}
    finally{busy=false;if(!closed)controls();}
  }
  async function load(){
    try{
      guard();const backup=cleanup?null:await readTextCollectionBackupFile(file,{check:guard});guard();
      session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:view.crypto});guard();
      const options={session,check:guard,confirm,onProgress:()=>{guard();status.textContent=summary();}};
      if(cleanup){const plan=await session.cleanupPlan();guard();batch=createTextCollectionCleanupBatch({...options,plan,otherModules});q('[data-collection-restore-file]').textContent=`当前账户 · 本次 ${plan.total} 条收藏原件`;}else batch=createTextCollectionRestoreBatch({...options,backup});
      status.textContent=batch.progress.total?`共 ${batch.progress.total} 条；点击确认${verb}后进行后端预检与授权。`:`没有可${verb}的收藏，未写入任何内容。`;
    }catch(cause){session?.close();if(!current()){stop();return;}status.textContent=`未开始${verb}：${String(cause?.message||'收藏资料无法完整读取').slice(0,240)}`;}
    finally{busy=false;if(!closed)controls();}
  }
  const click=event=>{const action=event.target.closest?.('[data-collection-restore]')?.dataset.collectionRestore;if(action==='close')void requestClose();if(action==='run')void run();};
  const key=event=>{if(event.key==='Escape')event.stopPropagation();},cancel=event=>{event.preventDefault();void requestClose();};
  const unload=event=>{if(pending()){event.preventDefault();event.returnValue='';}};
  const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected)stop();});
  dialog.addEventListener('click',click);dialog.addEventListener('keydown',key);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);view.addEventListener('pagehide',stop);view.addEventListener('beforeunload',unload);
  parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
  try{guard();dialog.showModal();status.textContent=cleanup?'正在读取本次清理范围…':'正在完整校验备份…';controls();void load();}catch(cause){stop();throw cause;}
  return {element:dialog,finished,dispose:stop};
}
