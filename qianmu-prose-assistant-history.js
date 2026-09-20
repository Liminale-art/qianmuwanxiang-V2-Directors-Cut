import {createAccountLocalStore} from './qianmu-account-local-store.js';
import {proseAssistantHistoryKey,validateProseAssistantHistory,emptyProseAssistantHistory,proseAssistantHistoryAccount,measureProseAssistantHistory,validateProseAssistantCleanupPlan,proseAssistantHistoryError as error} from './qianmu-prose-assistant-history-contract.js';
export {PROSE_ASSISTANT_HISTORY_LIMITS,proseAssistantHistoryKey,validateProseAssistantHistory,emptyProseAssistantHistory} from './qianmu-prose-assistant-history-contract.js';
const fail=()=>{throw error('invalid','助手历史格式或来源不一致，未覆盖原记录');};

export function createProseAssistantHistoryStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-prose-assistant-history',timeoutMs=8000}={}){
  const store=createAccountLocalStore({indexedDB,dbName,timeoutMs,validateNamespace:proseAssistantHistoryKey,validate:validateProseAssistantHistory,empty:emptyProseAssistantHistory,error,label:'场外特助历史'});
  const rangeFor=namespace=>{proseAssistantHistoryAccount(namespace);const prefix=JSON.stringify(['qianmu-prose-assistant-v2',namespace]).slice(0,-1)+',';
    try{return keyRange.bound(prefix,prefix+'\uffff');}catch(_){throw error('storage','助手历史盘点不可用，未按零占用处理');}};
  return Object.freeze({
    read(namespace,key,options){proseAssistantHistoryKey(key,namespace);return store.read(key,options);},
    async usage(namespace,{guard=()=>true}={}){
      const range=rangeFor(namespace);
      const summary={namespace,status:'ready',scope:'current-account-local',bytes:0,count:0,records:0,chats:0,markers:0,complete:0,failed:0,cancelled:0,estimated:true};
      await store.scan({range,limit:10000,visit(state,key){
        const size=measureProseAssistantHistory(state,key,namespace);for(const name of ['bytes','count','complete','failed','cancelled'])summary[name]+=size[name];
        summary.records++;if(size.count)summary.chats++;else summary.markers++;
      }},{guard});return Object.freeze(summary);
    },
    async planCleanup(namespace,{guard=()=>true}={}){
      const entries=[];await store.scan({range:rangeFor(namespace),limit:10000,visit(state,key){
        const size=measureProseAssistantHistory(state,key,namespace);if(size.count)entries.push(Object.freeze({key,revision:state.revision,updatedAt:state.updatedAt,count:size.count,bytes:size.bytes}));
      }},{guard});return Object.freeze(validateProseAssistantCleanupPlan({version:1,namespace,entries:Object.freeze(entries)},namespace));
    },
    async clearPlan(namespace,input,{confirmed=false,guard=()=>true,now=Date.now()}={}){
      if(confirmed!==true)throw error('confirmation','请先确认助手历史清理范围');const plan=validateProseAssistantCleanupPlan(structuredClone(input),namespace);
      if(!Number.isSafeInteger(now)||now<0||now>253402214400000)fail();const expected=new Map(plan.entries.map(entry=>[entry.key,entry]));
      const cleared=await store.updateMany([...expected.keys()],(state,key)=>{
        const row=expected.get(key),size=measureProseAssistantHistory(state,key,namespace);
        if(state.revision!==row.revision||state.updatedAt!==row.updatedAt||size.count!==row.count||size.bytes!==row.bytes)throw error('conflict','助手历史在确认后发生变化，整批未清理，请重新盘点');
        state.rows=[];state.revision++;state.updatedAt=now;
      },{guard});return Object.freeze({status:'complete',clearedConversations:cleared,clearedTurns:plan.entries.reduce((sum,row)=>sum+row.count,0),retainedRevisionMarkers:true});
    },
    write(namespace,key,expectedRevision,rows,{guard=()=>true,now=Date.now()}={}){
      proseAssistantHistoryKey(key,namespace);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)fail();
      const next=validateProseAssistantHistory({version:1,namespace:key,revision:expectedRevision+1,updatedAt:now,rows:structuredClone(rows)},key);
      return store.update(key,state=>{if(state.revision!==expectedRevision)throw error('conflict','此助手历史已在另一页面变化，未覆盖；请保留本页内容并重新打开');Object.assign(state,next);},{guard});
    },
    close:store.close,
  });
}
