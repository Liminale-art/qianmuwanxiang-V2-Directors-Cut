import {createProseAssistantHistoryStore} from './qianmu-prose-assistant-history.js';
import {proseAssistantAccountForNamespace} from './qianmu-prose-assistant-source.js';
import {collectAssistantNativeStorage} from './qianmu-assistant-storage-client.js';

const stale=()=>Object.assign(Error('助手储存账户或页面已变化，请重新盘点'),{code:'prose_assistant_storage_stale'});
const fields=['bytes','count','records','chats','markers','complete','failed','cancelled'];

// Confirmation owns an exact snapshot, not everything present at deletion time.
export async function cleanupProseAssistantStorage({resolveNamespace,isCurrent,expectedNamespace,check,confirm,otherModules=0,store=null}={}){
  if(typeof check!=='function'||typeof confirm!=='function'||typeof resolveNamespace!=='function'||typeof isCurrent!=='function'||!expectedNamespace)throw stale();
  const owned=!store,current=()=>{try{check();return isCurrent()===true;}catch{return false;}};
  const guard=async()=>{if(!current())throw stale();const namespace=await resolveNamespace();if(!current()||namespace!==expectedNamespace)throw stale();};
  try{
    await guard();const account=await proseAssistantAccountForNamespace(expectedNamespace);await guard();store ||= createProseAssistantHistoryStore();
    const plan=await store.planCleanup(account,{guard:current});await guard();
    if(!plan.entries.length)return {status:'empty'};
    const turns=plan.entries.reduce((sum,row)=>sum+row.count,0);
    const accepted=await confirm('清理场外特助旧本机副本',`将不可恢复地清空本浏览器当前账户的 ${plan.entries.length} 个会话、${turns} 轮助手问答（含失败或停止时已保存的内容）。需要的文字请先在对应助手面板复制留存；不删除正文、收藏、连接设置或其他设备记录，也不删除ST中的助手记录。保留防止旧页面写回的版本标记，不保证磁盘占用归零；旧版归属未核实的记录不处理。${otherModules>0?`同时勾选的其他 ${otherModules} 个模块本次不执行，需重新选择。`:''}确认期间记录变化会使整批停止，之后新增记录不清。确定清理吗？`);
    await guard();if(accepted!==true)return {status:'cancelled'};
    const result=await store.clearPlan(account,plan,{confirmed:true,guard:current});await guard();return result;
  }catch(cause){
    if(cause?.code==='prose_assistant_storage_stale')throw cause;
    if(cause?.code==='prose_assistant_history_conflict')throw Object.assign(Error('助手记录已变化，整批未清理，请重新盘点。'),{code:cause.code});
    throw Object.assign(Error('助手清理未能确认完成，请重新盘点；未继续清理其他模块。'),{code:'prose_assistant_cleanup_unconfirmed'});
  }finally{if(owned)store?.close();}
}

// Host namespace guards the view; only the derived v2 digest enters the history DB.
// No chat is required and no model, server, cleanup or whole-history read is used.
export async function collectProseAssistantLocalStorage({resolveNamespace,isCurrent,store=null}={}){
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

// Keep native server sizes outside browser-quota arithmetic. Legacy local data
// remains separately observable/cleanable and is never treated as the ST truth.
export async function collectProseAssistantStorage(options={}){
  const controller=new AbortController();
  try{
    const [local,native]=await Promise.all([collectProseAssistantLocalStorage(options),collectAssistantNativeStorage({...options,signal:controller.signal})]);
    const current=await options.resolveNamespace();
    if(options.isCurrent()!==true||local.namespace!==current||native.namespace&&native.namespace!==local.namespace)throw stale();
    return Object.freeze({...local,native});
  }finally{controller.abort();}
}
