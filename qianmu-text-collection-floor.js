// Light floor entry; the editor, transport and storage contracts load on demand.
export function createTextCollectionFloorTools({getContext,getChatKey,names,resolveNamespace,headers,applyIcons,mountPortal,notify,isCurrent}={}){
  let root=null,active=null,host=null,opening=false,epoch=0;
  const floorOf=node=>{const raw=node?.getAttribute('mesid')??node?.dataset?.messageId;return raw!==undefined&&raw!==null&&/^(0|[1-9][0-9]*)$/.test(raw)?Number(raw):null;};
  const current=()=>root?.isConnected&&isCurrent()===true;
  const stylesheet=()=>{
    const document=root.ownerDocument;
    if(document.querySelector('link[data-qm-text-collections]'))return;
    const link=document.createElement('link');link.rel='stylesheet';link.dataset.qmTextCollections='';
    link.href=new URL('./qianmu-text-collection.css',import.meta.url).href;document.head.append(link);
    link.addEventListener('error',()=>link.remove(),{once:true});
  };
  async function click(event){
    const button=event.target.closest?.('[data-qm-collect-floor]');
    if(!button||!root?.contains(button)||!current()||opening||active)return;
    const node=button.closest('.mes'),floor=floorOf(node),message=Number.isInteger(floor)?getContext().chat?.[floor]:null;
    if(!message||message.is_system)return;
    event.preventDefault();event.stopPropagation();
    const token=epoch,chatKey=String(getChatKey()||''),raw=message.mes,swipe=message.swipe_id??0;
    const capturedNames=names();
    const source={chatId:chatKey,messageId:floor,replyId:`swipe:${swipe}`,charName:String(!message.is_user&&message.name||capturedNames.charName||''),userName:String(message.is_user&&message.name||capturedNames.userName||''),text:floorCollectionText(node.querySelector('.mes_text'))};
    const valid=()=>current()&&epoch===token&&node.isConnected&&String(getChatKey()||'')===chatKey&&getContext().chat?.[floor]===message&&message.mes===raw&&(message.swipe_id??0)===swipe;
    opening=true;button.disabled=true;let portal,chooser,detach;
    try{
      stylesheet();portal=root.ownerDocument.createElement('section');portal.dataset.qmTextCollectionPortal='';root.ownerDocument.body.append(portal);host=portal;detach=mountPortal?.(portal);
      const runtime=await import('./qianmu-text-collection-capture.js');
      if(!valid())throw Error('楼层或页面已变化，请重新点击收藏');
      chooser=await runtime.openPersistentTextCollectionCapture({parent:portal,source,resolveNamespace,isCurrent:valid,headers});
      active=chooser;opening=false;
      const result=await chooser.finished;
      if(result&&valid())notify?.('收藏已保存','success');
    }catch(cause){if(current()&&epoch===token)notify?.(String(cause?.message||'收藏未保存，请重试').slice(0,240),'warning');}
    finally{chooser?.dispose();detach?.();portal?.remove();if(host===portal)host=null;if(active===chooser)active=null;if(epoch===token)opening=false;if(button.isConnected)button.disabled=false;}
  }
  function dispose(){epoch++;root?.removeEventListener('click',click);root?.querySelectorAll('[data-qm-collect-floor]').forEach(button=>button.remove());active?.dispose();active=null;host?.remove();host=null;opening=false;root=null;}
  function refresh(chatRoot){
    if(!chatRoot?.isConnected||isCurrent()!==true)return;
    if(root!==chatRoot){dispose();root=chatRoot;root.addEventListener('click',click);}
    for(const node of root.querySelectorAll('.mes')){
      const floor=floorOf(node),message=Number.isInteger(floor)?getContext().chat?.[floor]:null,existing=node.querySelector('[data-qm-collect-floor]');
      if(!message||message.is_system){existing?.remove();continue;}if(existing)continue;
      const toolbar=node.querySelector('.mes_buttons .extraMesButtons, .mes_buttons .mes_buttons_inner, .mes_buttons');if(!toolbar)continue;
      const button=root.ownerDocument.createElement('button');button.type='button';button.className='mes_button interactable qm-text-collection-floor';button.dataset.qmCollectFloor='';button.title='收藏正文';button.setAttribute('aria-label',button.title);
      button.innerHTML='<i class="fa-solid fa-bookmark"></i>';toolbar.append(button);applyIcons?.(button);
    }
  }
  return Object.freeze({refresh,dispose});
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
