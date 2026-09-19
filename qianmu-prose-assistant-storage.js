import {createProseAssistantHistoryStore} from './qianmu-prose-assistant-history.js';
import {proseAssistantAccountForNamespace} from './qianmu-prose-assistant-source.js';

const stale=()=>Object.assign(Error('助手储存账户或页面已变化，请重新盘点'),{code:'prose_assistant_storage_stale'});
const fields=['bytes','count','records','chats','markers','complete','failed','cancelled'];

// Host namespace guards the view; only the derived v2 digest enters the history DB.
// No chat is required and no model, server, cleanup or whole-history read is used.
export async function collectProseAssistantStorage({resolveNamespace,isCurrent,store=null}={}){
  if(typeof resolveNamespace!=='function'||typeof isCurrent!=='function')throw stale();
  let namespace;const owned=!store,current=()=>isCurrent()===true;
  const guard=async()=>{if(!current())throw stale();const next=await resolveNamespace();if(!current()||typeof next!=='string'||!next.startsWith('st-user:')||namespace!==undefined&&next!==namespace)throw stale();namespace=next;};
  try{
    await guard();const account=await proseAssistantAccountForNamespace(namespace);await guard();store ||= createProseAssistantHistoryStore();
    const measured=await store.usage(account,{guard:current});await guard();
    if(measured?.namespace!==account||measured.status!=='ready'||measured.scope!=='current-account-local'||measured.estimated!==true||fields.some(key=>!Number.isSafeInteger(measured[key])||measured[key]<0)
      ||measured.complete+measured.failed+measured.cancelled!==measured.count||measured.chats+measured.markers!==measured.records)throw Error('invalid summary');
    return Object.freeze({namespace,status:'ready',scope:'current-account-local',estimated:true,...Object.fromEntries(fields.map(key=>[key,measured[key]]))});
  }catch(cause){await guard();if(cause?.code==='prose_assistant_storage_stale')throw cause;
    return Object.freeze({namespace,status:'unavailable',bytes:null,count:null,error:'助手本机历史暂未读取；请刷新核对，未按零占用处理。'});
  }finally{if(owned)store?.close();}
}
