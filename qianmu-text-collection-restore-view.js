import {readTextCollectionBackupFile} from './qianmu-text-collection-backup.js';
import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionRestoreBatch} from './qianmu-text-collection-restore-batch.js';

export function openTextCollectionRestore({parent,file,resolveNamespace,isCurrent,headers,confirm,check}={}){
  if(!parent?.isConnected||typeof isCurrent!=='function'||typeof confirm!=='function'||typeof check!=='function')throw TypeError('收藏恢复页面不可用');
  const document=parent.ownerDocument,view=document.defaultView,focused=document.activeElement;
  let closed=false,busy=true,closing=false,session=null,batch=null,resolve;
  const finished=new Promise(done=>{resolve=done;}),dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog';dialog.setAttribute('aria-label','恢复正文收藏');
  dialog.innerHTML='<header><strong>恢复正文收藏</strong><button type="button" data-collection-restore="close">关闭</button></header><main><p data-collection-restore-file></p><p>仅新增独立副本，不覆盖已有收藏。服务器已确认的副本不会因关闭窗口而撤销。</p><p>发生中断时，请保留本窗口重试；关闭或刷新后不能自动续接。</p></main><footer><p role="status" aria-live="polite" data-collection-status></p><div class="qm-text-collection-actions"><button type="button" data-collection-restore="run" disabled>确认恢复</button></div></footer>';
  const q=s=>dialog.querySelector(s),status=q('[data-collection-status]'),runButton=q('[data-collection-restore="run"]');
  q('[data-collection-restore-file]').textContent=String(file?.name||'收藏备份');
  const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
  const guard=()=>{check();if(!current())throw Error('收藏恢复页面已关闭');};
  const pending=()=>{const p=batch?.progress;return Boolean(p&&(busy||p.uncertain||p.confirmed>0&&p.confirmed<p.total));};
  const summary=()=>{const p=batch?.progress;return p?`已确认 ${p.confirmed} / ${p.total} 条${p.uncertain?'；当前批次回执未确认，重试不会重复新增':''}`:'';};
  function controls(){dialog.setAttribute('aria-busy',String(busy));runButton.disabled=busy||!batch||batch.progress.confirmed===batch.progress.total;}
  function stop(){
    if(closed)return;closed=true;batch?.close();session?.close();observer.disconnect();view.removeEventListener('pagehide',stop);view.removeEventListener('beforeunload',unload);
    dialog.removeEventListener('click',click);dialog.removeEventListener('keydown',key);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);
    if(dialog.open)dialog.close();dialog.remove();if(focused?.isConnected&&document.visibilityState!=='hidden')focused.focus({preventScroll:true});resolve(batch?.progress||null);
  }
  async function requestClose(){
    if(closing||closed)return;closing=true;
    try{if(!pending()||await confirm('停止并关闭恢复',`${summary()}。关闭将停止后续提交；已确认副本仍保留，尚未确认的请求可能已写入。关闭后无法沿用本次进度自动续接，确定关闭吗？`)===true)stop();}
    catch{if(current())status.textContent='未能确认关闭，请重试；当前恢复进度仍保留。';}
    finally{closing=false;}
  }
  async function run(){
    if(busy||!batch||!current())return;busy=true;controls();status.textContent='正在核对恢复能力与当前账户…';
    try{guard();const result=await batch.run();guard();status.textContent=result.status==='complete'?`${summary()} · 恢复完成`:`${summary()} · 未开始恢复`;runButton.textContent='继续恢复';}
    catch(cause){if(!current()){stop();return;}try{guard();await session.guard();}catch{stop();return;}
      status.textContent=`${summary()}。${String(cause?.message||'恢复未完成，请保留窗口重试').slice(0,240)}`;runButton.textContent='重试未确认部分';}
    finally{busy=false;if(!closed)controls();}
  }
  async function load(){
    try{
      guard();const backup=await readTextCollectionBackupFile(file,{check:guard});guard();
      session=await createTextCollectionSession({resolveNamespace,isCurrent:current,headers,cryptoImpl:view.crypto});guard();
      batch=createTextCollectionRestoreBatch({backup,session,check:guard,confirm,onProgress:()=>{guard();status.textContent=summary();}});
      status.textContent=backup.records.length?`共 ${backup.records.length} 条；点击确认恢复后进行后端预检与授权。`:'此备份不含收藏，未写入任何内容。';
    }catch(cause){session?.close();if(!current()){stop();return;}status.textContent=`未开始恢复：${String(cause?.message||'备份无法完整读取').slice(0,240)}`;}
    finally{busy=false;if(!closed)controls();}
  }
  const click=event=>{const action=event.target.closest?.('[data-collection-restore]')?.dataset.collectionRestore;if(action==='close')void requestClose();if(action==='run')void run();};
  const key=event=>{if(event.key==='Escape')event.stopPropagation();},cancel=event=>{event.preventDefault();void requestClose();};
  const unload=event=>{if(pending()){event.preventDefault();event.returnValue='';}};
  const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected)stop();});
  dialog.addEventListener('click',click);dialog.addEventListener('keydown',key);dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);view.addEventListener('pagehide',stop);view.addEventListener('beforeunload',unload);
  parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
  try{guard();dialog.showModal();status.textContent='正在完整校验备份…';controls();void load();}catch(cause){stop();throw cause;}
  return {element:dialog,finished,dispose:stop};
}
