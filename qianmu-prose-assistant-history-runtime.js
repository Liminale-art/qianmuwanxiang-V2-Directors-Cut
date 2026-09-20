import {createProseAssistantHistoryStore} from './qianmu-prose-assistant-history.js';
import {proseAssistantHistoryKey,validateProseAssistantHistory,proseAssistantHistoryError as error} from './qianmu-prose-assistant-history-contract.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const safe=cause=>{
 const name=String(cause?.code||'').replace(/^prose_assistant_history_/,''),messages={conflict:'助手历史已在另一页面变化，未覆盖；请复制本页新内容后重新打开',capacity:'助手历史超过单会话容量，未截断原内容',invalid:'助手历史格式或确认结果不一致，未覆盖原记录',scope:'正文助手来源已变化，原保存未确认',closed:'正文助手历史已关闭',busy:'请等待当前历史保存完成',pending:'尚有未确认的助手历史，请先重试保存或复制后重新打开'};
 return Object.hasOwn(messages,name)?error(name,messages[name]):error('storage','助手历史保存未确认，请保留本页内容并重试');
};

// One explicit terminal snapshot at a time. No timers, model requests, automatic
// retries, revision rebasing, global history pool or writes after scope changes.
export async function openProseAssistantHistory({source,store=null,isCurrent,onStatus=()=>{}}={}){
 const namespace=source?.scope?.namespace;if(typeof namespace!=='string')throw safe({code:'prose_assistant_history_invalid'});
 const key=proseAssistantHistoryKey(source?.key,namespace),owned=!store;
 if(typeof source?.guard!=='function'||typeof source?.assertCurrent!=='function'||typeof isCurrent!=='function'||typeof onStatus!=='function')throw safe({code:'prose_assistant_history_invalid'});
 store ||= createProseAssistantHistoryStore();let closed=false,active=null,pending=null,committed=null,lastError=null;
 const current=()=>{try{return !closed&&isCurrent()===true&&source.assertCurrent()===true;}catch(_){return false;}};
 const check=async()=>{try{if(!current()||await source.guard()!==true||!current())throw Error();}catch(_){throw error('scope','');}};
 const status=()=>Object.freeze({phase:closed?'closed':active?'saving':lastError?'error':'ready',revision:committed?.revision??null,dirty:pending!==null,code:lastError?.code||'',canRetry:!closed&&!active&&!!pending&&lastError?.code!=='prose_assistant_history_conflict'});
 const report=()=>{if(current())try{onStatus(status());}catch(_){/* Presentation cannot change transaction outcomes. */}};
 function close(){closed=true;if(owned)store.close();pending=null;committed=null;lastError=null;}
 try{await check();const value=await store.read(namespace,key,{guard:current});await check();committed=structuredClone(validateProseAssistantHistory(value,key));}
 catch(cause){close();throw safe(cause);}
 async function execute(){
  await check();const actual=validateProseAssistantHistory(await store.read(namespace,key,{guard:current}),key);await check();
  const target=pending;
  // A write may have committed before its acknowledgement was lost. Only this
  // exact requested revision/content can be reconciled; never rebase on edits.
  if(target.attempted&&actual.revision===committed.revision+1&&same(actual.rows,target.rows))committed=structuredClone(actual);
  else{
   if(actual.revision!==committed.revision||!same(actual,committed))throw error('conflict','');
   if(!same(actual.rows,target.rows)){
    target.attempted=true;const receipt=validateProseAssistantHistory(await store.write(namespace,key,committed.revision,target.rows,{guard:current}),key);await check();
    if(receipt.revision!==committed.revision+1||!same(receipt.rows,target.rows))throw error('invalid','');committed=structuredClone(receipt);
   }
  }
  pending=null;lastError=null;return Object.freeze({status:'confirmed',revision:committed.revision,persistence:store.persistence||'local-transaction',...(store.concurrency?{concurrency:store.concurrency}:{})});
 }
 function start(){
  const token={promise:null};active=token;
  token.promise=Promise.resolve().then(execute).catch(cause=>{lastError=safe(cause);throw lastError;}).finally(()=>{if(active===token)active=null;report();});report();return token.promise;
 }
 function save(snapshot){
  try{
   if(!current())throw error('scope','');if(!snapshot||snapshot.key!==key||snapshot.busy!==false)throw error('invalid','');
   const rows=structuredClone(snapshot.rows);validateProseAssistantHistory({version:1,namespace:key,revision:1,updatedAt:0,rows},key);
   if(active){if(pending&&same(pending.rows,rows))return active.promise;throw error('busy','');}
   if(pending)throw error('pending','');pending={rows,attempted:false};lastError=null;return start();
  }catch(cause){return Promise.reject(safe(cause));}
 }
 return Object.freeze({save,status,
  initialHistory(){if(!current())throw safe({code:'prose_assistant_history_scope'});return structuredClone(committed);},
  retry(){if(!current())return Promise.reject(safe({code:'prose_assistant_history_scope'}));if(active)return active.promise;if(!pending)return Promise.resolve({status:'unchanged'});if(lastError?.code==='prose_assistant_history_conflict')return Promise.reject(lastError);return start();},
  close,
 });
}
