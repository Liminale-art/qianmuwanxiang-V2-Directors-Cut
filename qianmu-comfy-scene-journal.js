import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
import {normalizeComfySceneReceipt,comfySceneLockError,comfySceneScopeKey} from './qianmu-comfy-scene-lock.js';
import {validateSceneProposal,sceneSame} from './qianmu-comfy-scene-native-contract.js';

const schema='qianmu.comfy.scene-local-journal.v1',table='accounts';
const fail=message=>{throw comfySceneLockError('journal',message);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),copy=value=>structuredClone(value);
const receiptKey=value=>JSON.stringify(normalizeComfySceneReceipt(value));
function valid(value,namespace){
  if(!exact(value,['schema','namespace','nativeKnown','revision','claims','pending','conflicts'])||value.schema!==schema||value.namespace!==namespace||typeof value.nativeKnown!=='boolean'||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.claims)||value.claims.length>32768||!Array.isArray(value.conflicts)||value.conflicts.length>1024
    ||new TextEncoder().encode(JSON.stringify(value)).length>64*1024*1024)fail('续场本机事务记录损坏或超出容量');
  const keys=new Set();for(const claim of value.claims){const receipt=normalizeComfySceneReceipt(claim.receipt),key=receiptKey(receipt);
    if(!exact(claim,['receipt','outcomes'])||!sceneSame(receipt,claim.receipt)||receipt.scope.namespace!==namespace||keys.has(key)||!Array.isArray(claim.outcomes)||claim.outcomes.length>64||new Set(claim.outcomes.map(row=>row.id)).size!==claim.outcomes.length||claim.outcomes.some(row=>!exact(row,['id','outcome'])||typeof row.id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(row.id)||!['not_submitted','rejected','unknown','accepted','succeeded'].includes(row.outcome)))fail('续场原账户票据或结果不完整');keys.add(key);}
  if(value.pending!==null&&!exact(value.pending,['id','proposal']))fail('续场待保存操作不完整');
  const operations=[...value.conflicts,...(value.pending?[value.pending]:[])],ids=new Set();
  for(const item of operations){if(!exact(item,['id','proposal'])||typeof item.id!=='string'||!item.proposal||item.proposal.namespace!==namespace||item.id!==item.proposal.id||ids.has(item.id))fail('续场待保存操作归属不符');validateSceneProposal(item.proposal);ids.add(item.id);}return value;
}

// Separate DB: legacy scopes/usage remain untouched. Staging a native mutation
// and retaining its own receipt is one local atomic transaction. No HTTP/LLM
// call occurs inside an IDB transaction, and outcomes survive account changes.
export function createComfySceneJournal({indexedDB=globalThis.indexedDB,dbName='qianmu-comfy-scene-runtime',timeoutMs=6000}={}){
  let db,opening,closed=false;const transactions=new Set(),timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||6000));
  function open(){
    if(closed)return Promise.reject(comfySceneLockError('closed','续场本机日志已关闭'));if(db)return Promise.resolve(db);if(opening)return opening;
    const promise=new Promise((resolve,reject)=>{let request,done=false;const finish=(error,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(comfySceneLockError('timeout','续场本机日志读取超时')),timeout);
      try{request=indexedDB.open(dbName,1);}catch{finish(comfySceneLockError('journal','续场本机日志不可用'));return;}
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(table))request.result.createObjectStore(table);};
      request.onerror=()=>finish(comfySceneLockError('journal','续场本机日志不可用'));request.onblocked=()=>finish(comfySceneLockError('blocked','请关闭占用续场日志的旧页面'));
      request.onsuccess=()=>{const value=request.result;if(closed||done){value.close();finish(comfySceneLockError('closed','续场本机日志已关闭'));return;}db=value;
        const release=()=>{if(db===value){db=null;opening=null;}};value.onversionchange=()=>{value.close();release();};value.onclose=release;finish(null,value);};
    });opening=promise;void promise.catch(()=>{if(opening===promise)opening=null;});return promise;
  }
  async function run(namespace,mode,work){
    namespace=assertComfyRouteNamespace(namespace);const connection=await open();if(closed)fail('续场本机日志已关闭');
    return new Promise((resolve,reject)=>{let tx,result,error,ended=false;const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);transactions.delete(tx);cause?reject(cause):resolve(copy(result));};
      const abort=cause=>{error=cause;try{tx?.abort();}catch{finish(error);}};
      const timer=setTimeout(()=>{abort(comfySceneLockError('timeout','续场本机日志写入未确认'));finish(error);},timeout);
      try{tx=connection.transaction([table],mode);transactions.add(tx);tx.oncomplete=()=>finish();tx.onabort=()=>finish(error||comfySceneLockError('journal','续场本机事务未完成'));tx.onerror=()=>{error||=comfySceneLockError('journal','续场本机事务失败');};
        const store=tx.objectStore(table),read=store.get(namespace);read.onsuccess=()=>{try{
          if(closed)fail('续场本机日志已关闭');const value=valid(read.result??{schema,namespace,revision:0,nativeKnown:false,pending:null,claims:[],conflicts:[]},namespace);result=work(value);
          if(mode==='readwrite'){value.revision++;valid(value,namespace);store.put(value,namespace);}
        }catch(cause){abort(cause);}};
      }catch(cause){abort(cause);finish(error);}
    });
  }
  return Object.freeze({
    read:namespace=>run(namespace,'readonly',value=>value),
    observeNative:namespace=>run(namespace,'readwrite',value=>{value.nativeKnown=true;return true;}),
    stage(namespace,proposal){const captured=copy(proposal);validateSceneProposal(captured);return run(namespace,'readwrite',value=>{
      if(value.pending)fail('本机仍有未确认的续场保存，请先核对');if(captured.namespace!==namespace||typeof captured.id!=='string')fail('续场新操作归属不符');
      if(captured.receipt){const receipt=normalizeComfySceneReceipt(captured.receipt);if(receipt.scope.namespace!==namespace)fail('续场票据账户不符');
        const key=receiptKey(receipt),existing=value.claims.find(row=>receiptKey(row.receipt)===key);
        if(captured.kind==='reserve'){if(!existing)value.claims.push({receipt,outcomes:[]});}
        else if(['begin','settle','branch_result'].includes(captured.kind)&&!existing)fail('此浏览器没有原任务的本机预留，未接受导入票据');
      }
      value.pending={id:captured.id,proposal:captured};return value.pending;
    });},
    acknowledge(namespace,id){return run(namespace,'readwrite',value=>{if(!value.pending||value.pending.id!==id)fail('续场待保存操作已变化');const proposal=value.pending.proposal;
      if(proposal.outcomeId){const claim=value.claims.find(row=>receiptKey(row.receipt)===receiptKey(proposal.receipt));if(!claim)fail('原账户结果票据缺失');claim.outcomes=claim.outcomes.filter(row=>row.id!==proposal.outcomeId);}
      value.pending=null;if(proposal.events?.length)value.nativeKnown=true;return proposal;
    });},
    retainConflict(namespace,id){return run(namespace,'readwrite',value=>{
      if(!value.pending||value.pending.id!==id||value.conflicts.length>=1024)fail('续场冲突原件保全未就绪');
      const item=value.pending;value.conflicts.push(item);value.pending=null;
      // A reserve that never returned cannot have submitted a provider job.
      // Only its exact original ticket is released; no foreign holder changes.
      if(item.proposal.kind==='reserve'){
        const claim=value.claims.find(row=>receiptKey(row.receipt)===receiptKey(item.proposal.receipt));if(!claim)fail('原预留票据缺失');
        if(!claim.outcomes.length)claim.outcomes.push({id:crypto.randomUUID(),outcome:'not_submitted'});
      }
      return item;
    });},
    acknowledgeOutcome(namespace,receipt,id){const captured=normalizeComfySceneReceipt(receipt);return run(namespace,'readwrite',value=>{
      if(value.pending)fail('续场仍有待保存操作');const claim=value.claims.find(row=>receiptKey(row.receipt)===receiptKey(captured));if(!claim)fail('原账户结果票据缺失');claim.outcomes=claim.outcomes.filter(row=>row.id!==id);return true;
    });},
    remember(receipt,outcome){const captured=normalizeComfySceneReceipt(receipt);if(!['not_submitted','rejected','unknown','accepted','succeeded'].includes(outcome))return Promise.reject(comfySceneLockError('outcome','续场结果无效'));
      return run(captured.scope.namespace,'readwrite',value=>{const claim=value.claims.find(row=>receiptKey(row.receipt)===receiptKey(captured));if(!claim)fail('此浏览器不持有原账户任务票据');
        const last=claim.outcomes.at(-1);if(last?.outcome===outcome)return last;if(claim.outcomes.length>=64)fail('原任务待同步结果过多，未覆盖旧结果');const row={id:crypto.randomUUID(),outcome};claim.outcomes.push(row);return row;});},
    retire(namespace,receipts){const keys=new Set(receipts.map(receiptKey));return run(namespace,'readwrite',value=>{if(value.pending)fail('续场待保存时不能清理本机票据');
      value.claims=value.claims.filter(row=>!keys.has(receiptKey(row.receipt))||row.outcomes.length);return true;});},
    async localOwners(scope){const value=await this.read(scope.namespace),key=comfySceneScopeKey(scope);return [...new Set(value.claims.filter(row=>comfySceneScopeKey(row.receipt.scope)===key).map(row=>row.receipt.ownerId))];},
    close(){closed=true;for(const tx of transactions)try{tx.abort();}catch{}db?.close();db=null;opening=null;},
  });
}
