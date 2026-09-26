// Light floor entry; the editor, transport and storage contracts load on demand.
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.391';
export function createTextCollectionFloorTools({getContext,getChatKey,names,resolveNamespace,headers,applyIcons,mountPortal,notify,isCurrent,download,extraFloorTools,statusSessionFactory}={}){
  let root=null,active=null,host=null,opening=false,epoch=0,library=null,exporting=null,restoring=null,cleaning=null;
  let floorStatus=null,statusLoading=null,detachStatus=null;
  const floorOf=node=>{const raw=node?.getAttribute('mesid')??node?.dataset?.messageId;return raw!==undefined&&raw!==null&&/^(0|[1-9][0-9]*)$/.test(raw)?Number(raw):null;};
  const current=()=>root?.isConnected&&isCurrent()===true;
  function paintStatus(){
    if(!current())return;
    for(const button of root.querySelectorAll('[data-qm-collect-floor]')){
      const saved=floorStatus?.status(floorOf(button.closest('.mes')))??null;
      button.classList.toggle('is-collected',saved===true);button.dataset.qmCollectionState=saved===null?'unknown':saved?'saved':'empty';
      button.title=saved===true?'取消本层全部正文收藏（含其他回复版本）':saved===false?'收藏正文':'收藏正文（收藏状态正在确认或暂不可读取）';
      button.setAttribute('aria-label',button.title);
    }
  }
  function refreshStatus(force=false,retain=false){
    if(!current()||!root.querySelector('[data-qm-collect-floor]'))return;
    if(floorStatus)return floorStatus.refresh({force,retain});
    if(statusLoading)return statusLoading;
    const token=epoch,document=root.ownerDocument;
    statusLoading=import('./qianmu-text-collection-floor-status.js').then(({createTextCollectionFloorStatus})=>{
      if(!current()||epoch!==token)return;
      floorStatus=createTextCollectionFloorStatus({getScope:()=>({chatId:String(getChatKey()||''),chat:getContext().chat}),resolveNamespace,isCurrent:()=>!!current(),headers,onChange:paintStatus,...(statusSessionFactory?{sessionFactory:statusSessionFactory}:{})});
      const resumed=createTextCollectionResumeRefresh(()=>refreshStatus(true,true));
      const changed=()=>resumed.changed(),visible=()=>{if(document.visibilityState==='visible')resumed.schedule();};
      const focused=()=>{if(document.visibilityState==='visible')resumed.schedule();};
      document.addEventListener('qianmu-text-collections-changed',changed);document.addEventListener('visibilitychange',visible);document.defaultView.addEventListener('focus',focused);
      detachStatus=()=>{resumed.dispose();document.removeEventListener('qianmu-text-collections-changed',changed);document.removeEventListener('visibilitychange',visible);document.defaultView.removeEventListener('focus',focused);};
      void floorStatus.refresh().catch(()=>{if(current()&&epoch===token)paintStatus();});return floorStatus;
    }).catch(()=>{if(current()&&epoch===token)paintStatus();}).finally(()=>{if(epoch===token)statusLoading=null;});
    return statusLoading;
  }
  const stylesheet=(document=root.ownerDocument)=>{
    if(document.querySelector('link[data-qm-text-collections]'))return;
    const link=document.createElement('link');link.rel='stylesheet';link.dataset.qmTextCollections='';
    link.href=new URL('./qianmu-text-collection.css',import.meta.url).href;document.head.append(link);
    link.addEventListener('error',()=>link.remove(),{once:true});
  };
  async function click(event){
    if(extraFloorTools?.click(event)===true)return;
    const button=event.target.closest?.('[data-qm-collect-floor]');
    if(!button||!root?.contains(button)||!current()||opening||active)return;
    const node=button.closest('.mes'),floor=floorOf(node),message=Number.isInteger(floor)?getContext().chat?.[floor]:null;
    if(!message||message.is_system)return;
    event.preventDefault();event.stopPropagation();
    const token=epoch,chatKey=String(getChatKey()||''),raw=message.mes,swipe=message.swipe_id??0;
    const valid=()=>current()&&epoch===token&&node.isConnected&&String(getChatKey()||'')===chatKey&&getContext().chat?.[floor]===message&&message.mes===raw&&(message.swipe_id??0)===swipe;
    if(floorStatus?.status(floor)===true){
      opening=true;button.disabled=true;button.classList.add('is-removing');button.setAttribute('aria-busy','true');let session,confirmed=0,result=null,failure=null,owner=null;
      try{
        const [{createTextCollectionSession},{deleteTextCollectionFloor}]=await Promise.all([import('./qianmu-text-collection-session.js'),import('./qianmu-text-collection-floor-delete.js')]);
        if(!valid())return;
        session=await createTextCollectionSession({resolveNamespace,isCurrent:valid,headers,cryptoImpl:root.ownerDocument.defaultView.crypto});
        owner=session.namespace;
        result=await deleteTextCollectionFloor({session,chatId:chatKey,messageId:floor,check:()=>{if(!valid())throw Error('楼层或页面已变化，未继续删除');},onProgress:progress=>{
          confirmed=progress.confirmed;if(valid())floorStatus?.markUnknown(floor);
        }});
        const saved=await session.knownFloorState(chatKey,floor);
        if(valid()){
          if(saved===false){
            floorStatus?.confirmedDelete(floor,session.expectedAccount);
            notify?.(result.total?`已取消本层 ${result.confirmed} 条正文收藏`:'本层已无正文收藏','success');
          }else if(saved===true){
            floorStatus?.confirmedCreate(floor,session.expectedAccount);
            notify?.(`已取消 ${result.confirmed} 条收藏，本层仍有其他收藏`,'info');
          }else{
            floorStatus?.markUnknown(floor);
            notify?.(result.total?`已取消 ${result.confirmed} 条收藏`:'正在更新本层收藏状态',result.total?'success':'info');
          }
        }
      }catch(cause){failure=cause;}
      finally{
        session?.close();
        button.classList.remove('is-removing');button.removeAttribute('aria-busy');if(button.isConnected)button.disabled=false;if(epoch===token)opening=false;
        // The write already completed its authoritative readback. Reconcile
        // other-device changes in the background, not on the interaction path.
        if(current()&&epoch===token)void Promise.resolve(refreshStatus(true,true)).catch(()=>{});
      }
      if(!failure||!valid())return;
      if(owner)try{if(await resolveNamespace()!==owner||!valid())return;}catch{return;}
      if(failure){notify?.(confirmed?`已确认取消 ${confirmed} 条；其余未确认，请核对：${String(failure?.message||failure).slice(0,160)}`:`取消收藏未完成，请核对：${String(failure?.message||failure).slice(0,180)}`,'warning');return;}
      return;
    }
    const capturedNames=names();
    const displayName=(value,missing)=>{const name=String(value??'');return name.trim()?name:missing;};
    const source={chatId:chatKey,messageId:floor,replyId:`swipe:${swipe}`,charName:displayName(!message.is_user&&message.name||capturedNames.charName,'CHAR 名未记录'),userName:displayName(message.is_user&&message.name||capturedNames.userName,'USER 名未记录'),text:floorCollectionText(node.querySelector('.mes_text'))};
    opening=true;button.disabled=true;let portal,chooser,detach;
    try{
      stylesheet();portal=root.ownerDocument.createElement('section');portal.dataset.qmTextCollectionPortal='';root.ownerDocument.body.append(portal);host=portal;detach=mountPortal?.(portal);
      const runtime=await loadLocalChunk('./qianmu-text-collection-capture.js');
      if(!valid())throw Error('楼层或页面已变化，请重新点击收藏');
      chooser=await runtime.openPersistentTextCollectionCapture({parent:portal,source,sourceElement:node.querySelector('.mes_text'),resolveNamespace,isCurrent:valid,headers});
      active=chooser;opening=false;
      const result=await chooser.finished;
      if(result&&valid()){
        if(!floorStatus)await refreshStatus();
        if(!valid())return;
        floorStatus?.confirmedCreate(floor,result.expectedAccount);
        notify?.('收藏已保存','success');
        root.ownerDocument.dispatchEvent(new root.ownerDocument.defaultView.Event('qianmu-text-collections-changed'));
      }
    }catch(cause){if(current()&&epoch===token)notify?.(String(cause?.message||'收藏未保存，请重试').slice(0,240),'warning');}
    finally{chooser?.dispose();detach?.();portal?.remove();if(host===portal)host=null;if(active===chooser)active=null;if(epoch===token)opening=false;if(button.isConnected)button.disabled=false;}
  }
  function closeLibrary(entry){
    if(!entry||entry.closed)return;entry.closed=true;entry.view?.dispose();entry.detach?.();entry.portal.remove();if(library===entry)library=null;
  }
  async function openLibrary(parent,confirm,copy){
    if(library){library.view?.element.focus();return library.view;}
    if(!parent?.isConnected||isCurrent()!==true)return null;
    const document=parent.ownerDocument,portal=document.createElement('section'),entry={portal,view:null,closed:false};library=entry;
    const valid=()=>library===entry&&!entry.closed&&parent.isConnected&&isCurrent()===true;
    try{
      stylesheet(document);portal.dataset.qmTextCollectionPortal='';parent.append(portal);entry.detach=mountPortal?.(portal);
      const runtime=await loadLocalChunk('./qianmu-text-collection-library.js');if(!valid()){closeLibrary(entry);return null;}
      entry.view=await runtime.openTextCollectionLibrary({parent:portal,resolveNamespace,isCurrent:valid,headers,confirm,copy,download});
      entry.view.finished.then(()=>closeLibrary(entry));return entry.view;
    }catch(cause){if(valid())notify?.(String(cause?.message||'收藏管理暂不可用').slice(0,240),'warning');closeLibrary(entry);return null;}
  }
  async function exportBackup(button,confirm,download,createCheck){
    if(exporting||!button?.isConnected||isCurrent()!==true)return;
    const entry={cancelled:false},disabled=button.disabled;exporting=entry;button.disabled=true;let check;
    const valid=()=>exporting===entry&&!entry.cancelled&&button.isConnected&&isCurrent()===true;
    try{
      check=createCheck();check();
      const runtime=await import('./qianmu-text-collection-export.js');
      const result=await runtime.exportTextCollectionBackup({resolveNamespace,isCurrent:valid,headers,confirm,download,check:()=>{check();if(!valid())throw Error('收藏导出页面已关闭，未下载备份');}});
      if(valid()){
        if(result.status==='empty')notify?.('没有可导出的正文收藏。','info');
        if(result.status==='download-started')notify?.(`已发起 ${result.count} 条收藏的备份下载，请确认浏览器已保存文件。`,'success');
      }
      return result;
    }catch(cause){if(valid())notify?.(`收藏导出未完成：${String(cause?.message||cause).slice(0,200)}`,'warning');}
    finally{check?.release?.();if(exporting===entry)exporting=null;button.disabled=disabled;}
  }
  function disposeFloor(){epoch++;detachStatus?.();detachStatus=null;floorStatus?.dispose();floorStatus=null;statusLoading=null;extraFloorTools?.disposeFloor();root?.removeEventListener('click',click);root?.querySelectorAll('[data-qm-collect-floor]').forEach(button=>button.remove());active?.dispose();active=null;host?.remove();host=null;opening=false;root=null;}
  async function restoreBackup(file,input,confirm,createCheck){
    if(restoring){restoring.view?.element.focus();return;}if(!input?.isConnected||isCurrent()!==true)return;
    const parent=input.closest('.sd-storage-backup-section'),document=input.ownerDocument;if(!parent)return;
    const portal=document.createElement('section'),entry={portal,view:null,closed:false},disabled=input.disabled;let check,detach;restoring=entry;input.disabled=true;
    const valid=()=>restoring===entry&&!entry.closed&&parent.isConnected&&isCurrent()===true;
    try{
      check=createCheck();check();stylesheet(document);parent.append(portal);detach=mountPortal?.(portal);
      const runtime=await import('./qianmu-text-collection-restore-view.js');if(!valid())return;
      entry.view=runtime.openTextCollectionRestore({parent:portal,file,resolveNamespace,isCurrent:valid,headers,confirm,check});await entry.view.finished;
    }catch(cause){if(valid())notify?.(`收藏恢复暂不可用：${String(cause?.message||cause).slice(0,200)}`,'warning');}
    finally{entry.closed=true;entry.view?.dispose();detach?.();portal.remove();check?.release?.();input.disabled=disabled;if(restoring===entry)restoring=null;refreshStatus(true);}
  }
  async function cleanupOriginals(parent,confirm,check,expectedNamespace,otherModules=0,local=false){
    if(cleaning){cleaning.view?.element.focus();return;}check();
    if(!parent?.isConnected||isCurrent()!==true||!expectedNamespace)throw Error('收藏清理范围已变化，请重新盘点');
    const portal=parent.ownerDocument.createElement('section'),entry={portal,view:null,closed:false};let detach;cleaning=entry;
    const valid=()=>cleaning===entry&&!entry.closed&&parent.isConnected&&isCurrent()===true;
    const account=async()=>{check();const current=await resolveNamespace();check();if(current!==expectedNamespace)throw Error('收藏账户已变化，请重新盘点');return current;};
    try{
      stylesheet(parent.ownerDocument);portal.dataset.qmTextCollectionPortal='';parent.append(portal);detach=mountPortal?.(portal);
      if(local){
        const runtime=await import('./qianmu-text-collection-storage.js');check();if(!valid())return;
        const result=await runtime.cleanupTextCollectionPending({resolveNamespace:account,isCurrent:valid,headers,confirm,check,otherModules});
        if(valid()&&result.status!=='cancelled')notify?.(result.status==='empty'?'本机没有待存收藏。':`已移除 ${result.removed} 条本机待存，未删除服务器收藏。${result.missing?`另有 ${result.missing} 条此前已不存在。`:''}`,'success');return result;
      }
      const runtime=await import('./qianmu-text-collection-restore-view.js');check();if(!valid())return;
      entry.view=runtime.openTextCollectionCleanup({parent:portal,resolveNamespace:account,isCurrent:valid,headers,confirm,check,otherModules});return await entry.view.finished;
    }finally{entry.closed=true;entry.view?.dispose();detach?.();portal.remove();if(cleaning===entry)cleaning=null;refreshStatus(true);}
  }
  function dispose(){disposeFloor();closeLibrary(library);if(exporting)exporting.cancelled=true;for(const entry of [restoring,cleaning])if(entry){entry.closed=true;entry.view?.dispose();entry.portal.remove();}}
  function refresh(chatRoot){
    if(!chatRoot?.isConnected||isCurrent()!==true)return;
    if(root!==chatRoot){disposeFloor();root=chatRoot;root.addEventListener('click',click);}
    extraFloorTools?.bindRoot(root);
    for(const node of root.querySelectorAll('.mes')){
      const floor=floorOf(node),message=Number.isInteger(floor)?getContext().chat?.[floor]:null,existing=node.querySelector('[data-qm-collect-floor]');
      extraFloorTools?.refreshNode(node,floor,message);
      if(!message||message.is_system){existing?.remove();continue;}if(existing)continue;
      const toolbar=node.querySelector('.mes_buttons .extraMesButtons, .mes_buttons .mes_buttons_inner, .mes_buttons');if(!toolbar)continue;
      const button=root.ownerDocument.createElement('button');button.type='button';button.className='mes_button interactable qm-text-collection-floor';button.dataset.qmCollectFloor='';button.title='收藏正文';button.setAttribute('aria-label',button.title);
      button.innerHTML='<i class="fa-regular fa-star" data-qm-icon="qm-regular-star"></i>';toolbar.append(button);applyIcons?.(button);
    }
    paintStatus();refreshStatus();
  }
  const storageSummary=async valid=>{
    let module;try{module=await import('./qianmu-text-collection-storage.js');}catch{
      if(isCurrent()!==true||!valid())throw new Error('收藏储存页面已变化，请重新盘点');
      return {status:'unavailable',bytes:null,count:null,error:'收藏统计组件未加载，请刷新重试；未按零占用处理。'};
    }
    return module.collectTextCollectionStorage({resolveNamespace,isCurrent:()=>isCurrent()===true&&valid(),headers});
  };
  return Object.freeze({refresh,dispose,openLibrary,exportBackup,restoreBackup,cleanupOriginals,storageSummary,cleanupAssistant:(...args)=>extraFloorTools.cleanupStorage(...args),assistantStorageSummary:valid=>extraFloorTools.storageSummary(valid),get restoreBusy(){return restoring!==null;},get assistantBusy(){return extraFloorTools?.busy===true;}});
}

// A browser resume commonly emits both focus and visibilitychange. Refresh
// once after that pair, while an actual collection mutation stays immediate.
export function createTextCollectionResumeRefresh(refresh,{delayMs=120,scheduleTimer=setTimeout,cancelTimer=clearTimeout}={}){
  if(typeof refresh!=='function')throw new TypeError('收藏状态刷新函数无效');
  let timer=null,closed=false;
  const cancel=()=>{if(timer!==null){cancelTimer(timer);timer=null;}};
  return Object.freeze({
    schedule(){if(closed||timer!==null)return;timer=scheduleTimer(()=>{timer=null;if(!closed)refresh();},delayMs);},
    changed(){if(closed)return;cancel();refresh();},
    dispose(){closed=true;cancel();},
  });
}

// Save rendered prose as plain text; never collect embedded media or plugin controls.
export function floorCollectionText(element){
  if(!element)return '';
  const copy=element.cloneNode(true);
  const originals=element.querySelectorAll('*'),copies=copy.querySelectorAll('*'),view=element.ownerDocument.defaultView;
  originals.forEach((node,index)=>{const style=view.getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')copies[index].remove();});
  copy.querySelectorAll('script,style,iframe,img,video,audio,svg,button,[hidden],[data-qianmu-transient],.sd-storyboard-inline,.sd-tts-inline,.mes_reasoning').forEach(node=>node.remove());
  copy.querySelectorAll('br').forEach(node=>node.replaceWith('\n'));
  for(const node of copy.querySelectorAll('p,div,li,blockquote,pre,tr,h1,h2,h3,h4,h5,h6')){node.before('\n');node.after('\n');}
  return String(copy.textContent||'').trim();
}

// Existing storyboard shortcut, extracted unchanged except for explicit dependencies.
export function injectStoryboardMessageButtons(chatRoot,{floorOf,getContext,getState,planForMessage,applyIcons}){
  chatRoot.querySelectorAll('.mes').forEach((message)=>{
    const floor=floorOf(message),chatMessage=Number.isInteger(floor)?getContext().chat?.[floor]:null;
    if(!chatMessage||chatMessage.is_system||message.querySelector('.sd-storyboard-message-action'))return;
    const toolbar=message.querySelector('.mes_buttons .extraMesButtons, .mes_buttons .mes_buttons_inner, .mes_buttons');if(!toolbar)return;
    const button=chatRoot.ownerDocument.createElement('button');button.type='button';button.className='mes_button interactable sd-storyboard-message-action';
    button.dataset.storyboardChatAction = 'capture-floor';
    const plan=planForMessage(getState(),floor,chatMessage);
    button.title=plan?.shots?.some((shot)=>shot.hasPrompt||String(shot.prompt||'').trim())?`重新提取第 ${floor} 层生成词`:`提取第 ${floor} 层生成词`;
    button.setAttribute('aria-label',button.title);button.innerHTML='<i class="fa-solid fa-video" data-qm-icon="qm-regular-aperture"></i>';toolbar.appendChild(button);applyIcons(button);
  });
}
