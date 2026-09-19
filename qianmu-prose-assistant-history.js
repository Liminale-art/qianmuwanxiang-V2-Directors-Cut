import {createAccountLocalStore} from './qianmu-account-local-store.js';
import {proseAssistantHistoryKey,validateProseAssistantHistory,emptyProseAssistantHistory,proseAssistantHistoryAccount,measureProseAssistantHistory,proseAssistantHistoryError as error} from './qianmu-prose-assistant-history-contract.js';
export {PROSE_ASSISTANT_HISTORY_LIMITS,proseAssistantHistoryKey,validateProseAssistantHistory,emptyProseAssistantHistory} from './qianmu-prose-assistant-history-contract.js';
const fail=()=>{throw error('invalid','助手历史格式或来源不一致，未覆盖原记录');};

export function createProseAssistantHistoryStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-prose-assistant-history',timeoutMs=8000}={}){
  const store=createAccountLocalStore({indexedDB,dbName,timeoutMs,validateNamespace:proseAssistantHistoryKey,validate:validateProseAssistantHistory,empty:emptyProseAssistantHistory,error,label:'正文助手历史'});
  return Object.freeze({
    read(namespace,key,options){proseAssistantHistoryKey(key,namespace);return store.read(key,options);},
    async usage(namespace,{guard=()=>true}={}){
      proseAssistantHistoryAccount(namespace);const prefix=JSON.stringify(['qianmu-prose-assistant-v2',namespace]).slice(0,-1)+',';let range;
      try{range=keyRange.bound(prefix,prefix+'\uffff');}catch(_){throw error('storage','助手历史盘点不可用，未按零占用处理');}
      const summary={namespace,status:'ready',scope:'current-account-local',bytes:0,count:0,records:0,chats:0,markers:0,complete:0,failed:0,cancelled:0,estimated:true};
      await store.scan({range,limit:10000,visit(state,key){
        const size=measureProseAssistantHistory(state,key,namespace);for(const name of ['bytes','count','complete','failed','cancelled'])summary[name]+=size[name];
        summary.records++;if(size.count)summary.chats++;else summary.markers++;
      }},{guard});return Object.freeze(summary);
    },
    write(namespace,key,expectedRevision,rows,{guard=()=>true,now=Date.now()}={}){
      proseAssistantHistoryKey(key,namespace);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)fail();
      const next=validateProseAssistantHistory({version:1,namespace:key,revision:expectedRevision+1,updatedAt:now,rows:structuredClone(rows)},key);
      return store.update(key,state=>{if(state.revision!==expectedRevision)throw error('conflict','此助手历史已在另一页面变化，未覆盖；请保留本页内容并重新打开');Object.assign(state,next);},{guard});
    },
    close:store.close,
  });
}
