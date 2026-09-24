import {floorCollectionText} from './qianmu-text-collection-floor.js';
import {captureProseAssistantChatSource} from './qianmu-prose-assistant-source.js';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.372';

// No model/UI imports or document observers until an explicit hive action.
export function createProseAssistantFloorTools({getContext,resolveNamespace,headers,applyIcons,mountPortal,notify,isCurrent,assistantConfig,confirm,download,assistantSettings,saveAssistantSettings,assistantHistoryFactory}={}){
  let root=null,entry=null,cleaning=null,management=null,epoch=0;
  const current=()=>isCurrent()===true;
  function close(record){
    if(!record||record.closed)return;record.closed=true;record.controller.abort();record.panel?.dispose();record.detach?.();record.portal?.remove();if(entry===record)entry=null;
  }
  function disposeFloor(){epoch++;cleaning=null;management?.dispose();management=null;close(entry);root?.querySelectorAll('[data-qm-prose-assistant]').forEach(button=>button.remove());root=null;}
  function bindRoot(value){root=value;if(entry&&!entry.valid())close(entry);}
  function refreshNode(node){node.querySelector('[data-qm-prose-assistant]')?.remove();}
  async function openAssistant(){
    if(!current())return null;if(cleaning){notify?.('请先结束助手记录清理。','warning');return null;}if(entry){entry.panel?.element.focus({preventScroll:true});return entry.panel;}
    const document=root?.ownerDocument||globalThis.document,context=getContext(),chat=context.chat,metadata=context.chatMetadata,owner=JSON.stringify([context.chatId,context.characterId,context.groupId]),revision=epoch;
    const record={closed:false,controller:new document.defaultView.AbortController(),panel:null,portal:null,detach:null,valid:()=>false};entry=record;
    record.valid=()=>{
      if(!current()||record.closed||entry!==record||epoch!==revision)return false;
      const live=getContext();return live.chat===chat&&live.chatMetadata===metadata&&JSON.stringify([live.chatId,live.characterId,live.groupId])===owner;
    };
    try{
      if(!document.querySelector('link[data-qm-prose-assistant-style]')){const link=document.createElement('link');link.rel='stylesheet';link.dataset.qmProseAssistantStyle='';link.href=new URL('./qianmu-prose-assistant.css',import.meta.url).href;document.head.append(link);link.addEventListener('error',()=>link.remove(),{once:true});}
      const portal=document.createElement('section');portal.dataset.qmProseAssistantPortal='';document.body.append(portal);record.portal=portal;record.detach=mountPortal?.(portal);
      const runtime=await loadLocalChunk('./qianmu-prose-assistant-panel.js');if(!record.valid()){close(record);return null;}
      const config=typeof assistantConfig==='function'?assistantConfig():{};
      const readText=(selected,index)=>{
        if(!record.valid()||getContext().chat[index]!==selected)throw Error('场外特助来源已变化');
        const candidates=root?.querySelectorAll(`.mes[mesid="${index}"], .mes[data-message-id="${index}"]`)||[];
        if(candidates.length>1)throw Error('参考前文未能唯一定位');const candidate=candidates[0];
        // No fallback to raw HTML, hidden reasoning or an unrendered whole chat.
        return floorCollectionText(candidate?.querySelector('.mes_text'));
      };
      const source={getContext,epoch:()=>epoch,resolveNamespace,isCurrent:record.valid,readText,signal:record.controller.signal};
      record.panel=await runtime.openProseAssistantPanel({parent:portal,source,sourceFactory:referenceFloors=>{
        if(!record.valid())throw Error('场外特助聊天已变化');
        const floor=getContext().chat?.findLastIndex(message=>message&&!message.is_system)??-1;return {...source,floor,referenceFloors,previousFloors:Math.max(0,referenceFloors-1)};
      },profiles:config?.profiles||[],selection:config?.selection,referenceFloors:config?.referenceFloors,systemPrompt:config?.systemPrompt||'',getRequestHeaders:headers,applyIcons,historyFactory:assistantHistoryFactory,
        preferences:typeof assistantSettings==='function'?{current:assistantSettings,persist:saveAssistantSettings}:undefined,
        copy:text=>document.defaultView.navigator.clipboard.writeText(text),confirm:text=>confirm('场外特助',text),isCurrent:record.valid});
      if(!record.valid()){close(record);return null;}void record.panel.finished.finally(()=>close(record));return record.panel;
    }catch(error){if(record.valid())notify?.(error?.code==='qianmu_chunk_load'?'场外特助未能载入，请重试；若仍失败，请刷新页面。':'场外特助暂未打开，请稍后重试。','warning');close(record);return null;}
  }
  function click(event){
    return false;
  }
  async function storageSummary(valid){
    const live=()=>isCurrent()===true&&valid();let module;
    try{module=await import('./qianmu-prose-assistant-storage.js?v=1.59.372');}catch{if(!live())throw Error('助手储存页面已变化');return {status:'unavailable',bytes:null,count:null,error:'助手统计组件未加载，请刷新重试。'};}
    return module.collectProseAssistantStorage({resolveNamespace,isCurrent:live,headers});
  }
  async function cleanupStorage(parent,confirm,check,expectedNamespace,otherModules=0,native=false){
    check();if(entry||cleaning)throw Error('请先关闭场外特助或结束清理');const token={};cleaning=token;
    const valid=()=>{try{check();return cleaning===token&&parent?.isConnected===true&&isCurrent()===true&&!entry;}catch{return false;}};
    try{
      if(native){
        const runtime=await import('./qianmu-assistant-history-view.js?v=1.59.372');check();
        const actual=await resolveNamespace();if(expectedNamespace===undefined)expectedNamespace=actual;if(!valid()||actual!==expectedNamespace)throw Error('助手管理账户已变化');check();
        const document=parent.ownerDocument,portal=document.createElement('section');portal.dataset.qmProseAssistantPortal='';document.body.append(portal);const detach=mountPortal?.(portal);let opened;
        try{opened=runtime.openAssistantHistoryManager({parent:portal,resolveNamespace:async()=>{const actual=await resolveNamespace();if(actual!==expectedNamespace)throw Error('助手管理账户已变化');return actual;},isCurrent:valid,headers,check,confirm,download,otherModules,applyIcons,captureDestination:({signal})=>captureProseAssistantChatSource({getContext,epoch:()=>epoch,resolveNamespace,isCurrent:valid,signal})});management=opened;await opened.finished;}
        finally{opened?.dispose();if(management===opened)management=null;detach?.();portal.remove();}return;
      }
      const runtime=await import('./qianmu-prose-assistant-storage.js?v=1.59.372');check();
      const result=await runtime.cleanupProseAssistantStorage({resolveNamespace,isCurrent:valid,expectedNamespace,check,confirm,otherModules});
      check();if(valid()&&result.status!=='cancelled')notify?.(result.status==='empty'?'本机没有可清理的助手问答。':`已清空本机 ${result.clearedConversations} 个助手会话、${result.clearedTurns} 轮问答；ST记录未删除，版本标记保留。`,'success');return result;
    }finally{if(cleaning===token)cleaning=null;}
  }
  return Object.freeze({bindRoot,refreshNode,click,openAssistant,disposeFloor,storageSummary,cleanupStorage,get busy(){return entry!==null;}});
}
