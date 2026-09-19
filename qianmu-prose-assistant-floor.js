import {floorCollectionText} from './qianmu-text-collection-floor.js';

// No model/UI imports or document observers until an explicit floor action.
export function createProseAssistantFloorTools({getContext,resolveNamespace,headers,applyIcons,mountPortal,notify,isCurrent,assistantConfig,confirm,assistantSettings,saveAssistantSettings}={}){
  let root=null,entry=null,cleaning=null,epoch=0;
  const current=()=>Boolean(root?.isConnected&&isCurrent()===true);
  function close(record){
    if(!record||record.closed)return;record.closed=true;record.controller.abort();record.panel?.dispose();record.detach?.();record.portal?.remove();if(record.button.isConnected)record.button.disabled=false;if(entry===record)entry=null;
  }
  function disposeFloor(){epoch++;cleaning=null;close(entry);root?.querySelectorAll('[data-qm-prose-assistant]').forEach(button=>button.remove());root=null;}
  function bindRoot(value){if(root!==value){disposeFloor();root=value;}if(entry&&!entry.valid())close(entry);}
  function refreshNode(node,floor,message){
    const existing=node.querySelector('[data-qm-prose-assistant]');if(!message||message.is_system){existing?.remove();return;}if(existing)return;
    const toolbar=node.querySelector('.mes_buttons .extraMesButtons, .mes_buttons .mes_buttons_inner, .mes_buttons');if(!toolbar)return;
    const button=node.ownerDocument.createElement('button');button.type='button';button.className='mes_button interactable qm-prose-assistant-floor';button.dataset.qmProseAssistant='';button.title='问正文助手';button.setAttribute('aria-label',button.title);button.innerHTML='<i class="fa-solid fa-comment-dots"></i>';toolbar.append(button);applyIcons?.(button);
  }
  async function open(button,node,floor,message){
    const document=root.ownerDocument,context=getContext(),chat=context.chat,metadata=context.chatMetadata,owner=JSON.stringify([context.chatId,context.characterId,context.groupId]),raw=message.mes,swipe=message.swipe_id??0,revision=epoch;
    const record={button,node,closed:false,controller:new document.defaultView.AbortController(),panel:null,portal:null,detach:null,valid:()=>false};entry=record;
    record.valid=()=>{
      if(!current()||record.closed||entry!==record||epoch!==revision||!node.isConnected)return false;
      const live=getContext();return live.chat===chat&&live.chatMetadata===metadata&&JSON.stringify([live.chatId,live.characterId,live.groupId])===owner&&live.chat[floor]===message&&message.mes===raw&&(message.swipe_id??0)===swipe&&!message.is_system;
    };
    button.disabled=true;
    try{
      if(!document.querySelector('link[data-qm-prose-assistant-style]')){const link=document.createElement('link');link.rel='stylesheet';link.dataset.qmProseAssistantStyle='';link.href=new URL('./qianmu-prose-assistant.css',import.meta.url).href;document.head.append(link);link.addEventListener('error',()=>link.remove(),{once:true});}
      const portal=document.createElement('section');portal.dataset.qmProseAssistantPortal='';document.body.append(portal);record.portal=portal;record.detach=mountPortal?.(portal);
      const runtime=await import('./qianmu-prose-assistant-panel.js');if(!record.valid())return;
      const config=typeof assistantConfig==='function'?assistantConfig():{};
      const readText=(selected,index)=>{
        if(!record.valid()||getContext().chat[index]!==selected)throw Error('正文助手来源已变化');
        const candidates=index===floor?[node]:root.querySelectorAll(`.mes[mesid="${index}"], .mes[data-message-id="${index}"]`);
        if(candidates.length>1)throw Error('参考前文未能唯一定位');const candidate=candidates[0];
        // No fallback to raw HTML, hidden reasoning or an unrendered whole chat.
        return floorCollectionText(candidate?.querySelector('.mes_text'));
      };
      record.panel=await runtime.openProseAssistantPanel({parent:portal,source:{getContext,epoch:()=>epoch,resolveNamespace,isCurrent:record.valid,readText,floor,signal:record.controller.signal},
        profiles:config?.profiles||[],selection:config?.selection,systemPrompt:config?.systemPrompt||'',getRequestHeaders:headers,
        preferences:typeof assistantSettings==='function'?{current:assistantSettings,persist:saveAssistantSettings}:undefined,
        copy:text=>document.defaultView.navigator.clipboard.writeText(text),confirm:text=>confirm('正文助手',text),isCurrent:record.valid});
      if(!record.valid()){record.panel.dispose();return;}await record.panel.finished;
    }catch(_){if(record.valid())notify?.('正文助手未能打开，请核对当前聊天与账户后重试。','warning');}
    finally{close(record);}
  }
  function click(event){
    const button=event.target.closest?.('[data-qm-prose-assistant]');if(!button||!root?.contains(button))return false;
    event.preventDefault();event.stopPropagation();if(!current())return true;if(cleaning){notify?.('请先结束助手记录清理，再打开正文助手。','warning');return true;}if(entry){entry.panel?.element.focus();return true;}
    const node=button.closest('.mes'),raw=node?.getAttribute('mesid')??node?.dataset?.messageId;
    const floor=typeof raw==='string'&&/^(0|[1-9][0-9]*)$/.test(raw)?Number(raw):null,message=Number.isSafeInteger(floor)?getContext().chat?.[floor]:null;
    if(message&&!message.is_system)void open(button,node,floor,message);return true;
  }
  async function storageSummary(valid){
    const live=()=>isCurrent()===true&&valid();let module;
    try{module=await import('./qianmu-prose-assistant-storage.js');}catch{if(!live())throw Error('助手储存页面已变化');return {status:'unavailable',bytes:null,count:null,error:'助手统计组件未加载，请刷新重试。'};}
    return module.collectProseAssistantStorage({resolveNamespace,isCurrent:live});
  }
  async function cleanupStorage(parent,confirm,check,expectedNamespace,otherModules=0){
    check();if(entry||cleaning)throw Error('请先关闭正文助手或结束清理');const token={};cleaning=token;
    const valid=()=>cleaning===token&&parent?.isConnected===true&&isCurrent()===true&&!entry;
    try{
      const runtime=await import('./qianmu-prose-assistant-storage.js');check();
      const result=await runtime.cleanupProseAssistantStorage({resolveNamespace,isCurrent:valid,expectedNamespace,check,confirm,otherModules});
      check();if(valid()&&result.status!=='cancelled')notify?.(result.status==='empty'?'本机没有可清理的助手问答。':`已清空 ${result.clearedConversations} 个助手会话、${result.clearedTurns} 轮问答；版本标记保留。`,'success');return result;
    }finally{if(cleaning===token)cleaning=null;}
  }
  return Object.freeze({bindRoot,refreshNode,click,disposeFloor,storageSummary,cleanupStorage,get busy(){return entry!==null;}});
}
