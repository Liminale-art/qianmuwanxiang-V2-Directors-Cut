import {floorProseText} from './qianmu-prose-floor-entries.js?v=1.59.440';
import {captureProseAssistantChatSource} from './qianmu-prose-assistant-source.js';
import {loadLocalChunk,localChunkFailure} from './qianmu-feature-runtime.js?v=1.59.425';

// No model/UI imports or document observers until an explicit hive action.
export function createProseAssistantFloorTools({getContext,resolveNamespace,headers,applyIcons,mountPortal,notify,isCurrent,assistantConfig,confirm,download,assistantSettings,saveAssistantSettings,assistantHistoryFactory,assistantConversationFactory,pending}={}){
  let root=null,entry=null,cleaning=null,management=null,epoch=0;
  const current=()=>isCurrent()===true;
  function close(record){
    if(!record||record.closed)return;record.closed=true;record.controller.abort();record.panel?.dispose();record.detach?.();record.portal?.remove();if(entry===record)entry=null;
  }
  function disposeFloor(){epoch++;cleaning=null;management?.dispose();management=null;close(entry);root?.querySelectorAll('[data-qm-prose-assistant]').forEach(button=>button.remove());root=null;}
  function bindRoot(value){root=value;if(entry&&!entry.valid())close(entry);}
  function refreshNode(node){node.querySelector('[data-qm-prose-assistant]')?.remove();}
  function inheritProseTypography(portal){
    const document=portal.ownerDocument,prose=root?.querySelector('.sd-prose-run')||root?.querySelector('.mes_text');
    const style=document.defaultView.getComputedStyle?.(prose||document.body);if(!style)return;
    for(const [name,value] of [['--qm-pa-prose-font',style.fontFamily],['--qm-pa-prose-size',style.fontSize]])if(value)portal.style.setProperty(name,value);
  }
  // The click answers at once: a stand-in window covers the time the panel's code and account guard take.
  function openAssistant(){const opening=openPanel();pending?.('场外特助','正在打开场外特助…',opening);return opening;}
  async function openPanel(){
    if(!current())return null;if(cleaning){notify?.('请先结束助手记录清理。','warning');return null;}
    if(entry&&!entry.valid())close(entry);
    if(entry){
      const prior=entry;if(!prior.panel)return null;const reopened=await prior.panel.reopen();
      // Reopening can await an account guard while navigation disposes this
      // record. An old invocation must neither rebuild nor adopt a newer panel.
      if(!prior.valid()){close(prior);return null;}
      if(reopened){inheritProseTypography(prior.portal);return prior.panel;}
      close(prior);
    }
    const document=root?.ownerDocument||globalThis.document,context=getContext(),chat=context.chat,metadata=context.chatMetadata,owner=JSON.stringify([context.chatId,context.characterId,context.groupId]),revision=epoch;
    const record={closed:false,controller:new document.defaultView.AbortController(),panel:null,portal:null,detach:null,valid:()=>false};entry=record;
    record.valid=()=>{
      if(!current()||record.closed||entry!==record||epoch!==revision)return false;
      const live=getContext();return live.chat===chat&&live.chatMetadata===metadata&&JSON.stringify([live.chatId,live.characterId,live.groupId])===owner;
    };
    try{
      const styleUrl=new URL('./qianmu-prose-assistant.css?v=1.59.614',import.meta.url).href,existingStyle=document.querySelector('link[data-qm-prose-assistant-style]');
      if(!existingStyle){const link=document.createElement('link');link.rel='stylesheet';link.dataset.qmProseAssistantStyle='';link.href=styleUrl;document.head.append(link);link.addEventListener('error',()=>link.remove(),{once:true});}else if(existingStyle.href!==styleUrl)existingStyle.href=styleUrl;
      const portal=document.createElement('section');portal.dataset.qmProseAssistantPortal='';document.body.append(portal);record.portal=portal;record.detach=mountPortal?.(portal);inheritProseTypography(portal);
      const runtime=await loadLocalChunk('./qianmu-prose-assistant-panel.js?v=1.59.452');if(!record.valid()){close(record);return null;}
      const config=typeof assistantConfig==='function'?assistantConfig():{};
      const readText=(selected,index)=>{
        if(!record.valid()||getContext().chat[index]!==selected)throw Error('场外特助来源已变化');
        const candidates=root?.querySelectorAll(`.mes[mesid="${index}"], .mes[data-message-id="${index}"]`)||[];
        if(candidates.length>1)throw Error('参考前文未能唯一定位');const candidate=candidates[0];
        // No fallback to raw HTML, hidden reasoning or an unrendered whole chat.
        return floorProseText(candidate?.querySelector('.mes_text'));
      };
      const source={getContext,epoch:()=>epoch,resolveNamespace,isCurrent:record.valid,readText,signal:record.controller.signal};
      record.panel=await runtime.openProseAssistantPanel({parent:portal,source,sourceFactory:referenceFloors=>{
        if(!record.valid())throw Error('场外特助聊天已变化');
        const floor=getContext().chat?.findLastIndex(message=>message&&!message.is_system)??-1;return {...source,floor,referenceFloors,previousFloors:Math.max(0,referenceFloors-1)};
      },profiles:config?.profiles||[],selection:config?.selection,getProfileStream:()=>assistantSettings?.()?.streamEnabled===true,referenceFloors:config?.referenceFloors,systemPrompt:config?.systemPrompt||'',getRequestHeaders:headers,applyIcons,historyFactory:assistantHistoryFactory,conversationFactory:assistantConversationFactory,retainOnClose:true,
        preferences:typeof assistantSettings==='function'?{current:assistantSettings,persist:saveAssistantSettings}:undefined,
        copy:text=>document.defaultView.navigator.clipboard.writeText(text),confirm:text=>confirm('场外特助',text),isCurrent:record.valid});
      if(!record.valid()){close(record);return null;}void record.panel.finished.finally(()=>close(record));return record.panel;
    }catch(error){if(record.valid())notify?.(localChunkFailure(error,'场外特助').message,'warning');close(record);return null;}
  }
  function click(event){
    return false;
  }
  async function storageSummary(valid){
    const live=()=>isCurrent()===true&&valid();let module;
    try{module=await import('./qianmu-prose-assistant-storage.js?v=1.59.414');}catch{if(!live())throw Error('助手储存页面已变化');return {status:'unavailable',bytes:null,count:null,error:'助手统计组件未加载，请刷新重试。'};}
    return module.collectProseAssistantStorage({resolveNamespace,isCurrent:live,headers});
  }
  async function cleanupStorage(parent,confirm,check,expectedNamespace,otherModules=0,native=false){
    check();if(entry?.panel?.visible===false)close(entry);if(entry||cleaning)throw Error('请先关闭场外特助或结束清理');const token={};cleaning=token;
    const valid=()=>{try{check();return cleaning===token&&parent?.isConnected===true&&isCurrent()===true&&!entry;}catch{return false;}};
    try{
      if(native){
        const runtime=await import('./qianmu-assistant-history-view.js?v=1.59.419');check();
        const actual=await resolveNamespace();if(expectedNamespace===undefined)expectedNamespace=actual;if(!valid()||actual!==expectedNamespace)throw Error('助手管理账户已变化');check();
        // 清理即整库清空：目录里的对话全部标为已删除，各份历史内容清空。不开管理面板，不再逐项确认。
        const scoped=async()=>{const now=await resolveNamespace();if(now!==expectedNamespace)throw Error('助手管理账户已变化');return now;};
        const library=await import('./qianmu-prose-assistant-library-transfer.js?v=1.59.614');check();
        await library.createProseAssistantLibraryTransfer({resolveNamespace:scoped,isCurrent:valid,download,confirm:async()=>true,notify:()=>{}}).clearLibrary();check();
        const done=await runtime.clearAllAssistantHistories({resolveNamespace:scoped,isCurrent:valid,headers});
        if(valid())notify?.(`已清空 ${done.cleared} 个特助对话${done.skipped?`，${done.skipped} 个未能读取、已保留`:''}。`,done.skipped?'warning':'success');return done;
      }
      const runtime=await import('./qianmu-prose-assistant-storage.js?v=1.59.414');check();
      const result=await runtime.cleanupProseAssistantStorage({resolveNamespace,isCurrent:valid,expectedNamespace,check,confirm:async()=>true,otherModules});
      check();if(valid()&&result.status!=='cancelled')notify?.(result.status==='empty'?'没有可清理的特助旧副本。':'已清理特助旧副本。','success');return result;
    }finally{if(cleaning===token)cleaning=null;}
  }
  // Whole-library backup: same exclusion as cleanup (no open window, one job at a time); failures are reported here, never thrown.
  async function libraryTransfer(label,button,work){
    if(button?.disabled)return {status:'cancelled'};
    if(entry?.panel?.visible===false)close(entry);
    if(entry||cleaning){notify?.('请先关闭场外特助或结束清理。','warning');return {status:'cancelled'};}
    const token={};cleaning=token;if(button)button.disabled=true;
    try{
      const runtime=await import('./qianmu-prose-assistant-library-transfer.js?v=1.59.614');
      const transfer=runtime.createProseAssistantLibraryTransfer({resolveNamespace,isCurrent:()=>cleaning===token&&isCurrent()===true&&!entry,download,confirm,notify});
      return await work(transfer);
    }catch(error){
      const known=/^(prose_assistant_|st_account_storage_)/.test(error?.code||'');
      if(isCurrent()===true)notify?.(`${label}未完成：${known?String(error.message).slice(0,120):'请重试。'}`,'warning');return {status:'failed'};
    }finally{if(cleaning===token)cleaning=null;if(button?.isConnected)button.disabled=false;}
  }
  const exportAssistantLibrary=button=>libraryTransfer('场外特助导出',button,transfer=>transfer.exportLibrary());
  const importAssistantLibrary=(file,input)=>libraryTransfer('场外特助导入',input,transfer=>transfer.importLibrary(file));
  return Object.freeze({bindRoot,refreshNode,click,openAssistant,disposeFloor,storageSummary,cleanupStorage,exportAssistantLibrary,importAssistantLibrary,get busy(){return entry!==null&&entry.panel?.visible!==false;}});
}
