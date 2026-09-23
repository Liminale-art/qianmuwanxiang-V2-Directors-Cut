import assert from 'node:assert/strict';
import {createLocalVibeEncodingStore} from '../../qianmu-vibe-encoding-store.js';
import {namespace} from './character-native-fixture.mjs';

// Five-table protocol double, not a browser IDB implementation. Readwrite
// transactions serialize across connections, roll back on abort, and publish
// writes only at completion. Actual production store methods run unchanged.
export function receiptWritableFixture(inputs=[]){
  const initial=structuredClone(inputs),size=v=>Buffer.byteLength(JSON.stringify(v)),segments=initial.flatMap(v=>v.segments),archived=initial.filter(v=>v.section==='archived').map(v=>v.receipt);
  const state={tables:{receipts:initial.filter(v=>v.section==='current').map(v=>v.receipt),archive:archived,reviewSegments:segments,
    archiveUsage:archived.length?[{namespace,count:archived.length,bytes:archived.reduce((n,r)=>n+size(r),0)}]:[],
    reviewUsage:segments.length?[{namespace,count:segments.length,bytes:segments.reduce((n,r)=>n+size(r),0),reviews:segments.reduce((n,r)=>n+r.reviews.length,0)}]:[]},transactions:[],writes:[],beforeTransaction:null,failWrite:false,failOpen:false};
  const pending=[];let running=false;
  const drain=()=>{if(running||!pending.length)return;running=true;const begin=pending.shift();queueMicrotask(()=>begin(()=>{running=false;drain();}));};
  const primary=(name,row)=>['archiveUsage','reviewUsage'].includes(name)?row.namespace:row.key;
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const matches=(value,range)=>range?.kind==='only'?equal(value,range.value):range?.kind==='bound'?(value>range.lower||!range.lowerOpen&&value===range.lower)&&(value<range.upper||!range.upperOpen&&value===range.upper):range===undefined||equal(value,range);
  const keyRange={only:value=>({kind:'only',value}),bound:(lower,upper,lowerOpen,upperOpen)=>({kind:'bound',lower,upper,lowerOpen,upperOpen})};
  const indexedDB={open(){const request={};queueMicrotask(()=>{
    if(state.failOpen){request.onerror?.();return;}
    request.result={close(){},transaction(names,mode){assert.deepEqual(names,['receipts','archive','archiveUsage','reviewSegments','reviewUsage']);assert.ok(['readonly','readwrite'].includes(mode));
      const tasks=[],writes=[];let tables,finish,started=false,ended=false,scheduled=false;
      const tx={abort(){if(ended)return;ended=true;queueMicrotask(()=>{tx.onabort?.();finish?.();});}};
      const schedule=()=>{if(!started||ended||scheduled)return;scheduled=true;queueMicrotask(()=>{
        scheduled=false;if(ended)return;const next=tasks.shift();
        if(!next){ended=true;if(mode==='readwrite')state.tables=tables;state.writes.push(...writes);tx.oncomplete?.();finish();return;}
        try{next.request.result=structuredClone(next.work());next.request.onsuccess?.();}catch(error){next.request.error=error;next.request.onerror?.();tx.onerror?.();tx.abort();return;}schedule();
      });};
      const ask=work=>{assert.equal(ended,false);const request={};tasks.push({request,work});schedule();return request;};
      tx.objectStore=name=>{assert.ok(names.includes(name));const all=(range,limit,index)=>tables[name].filter(row=>matches(index==='receipt'?[row.namespace,row.cacheKey]:index==='namespace'?row.namespace:primary(name,row),range)).sort((a,b)=>String(primary(name,a)).localeCompare(String(primary(name,b)))).slice(0,limit);
        const write=(kind,value)=>ask(()=>{assert.equal(mode,'readwrite');if(state.failWrite)throw Error('simulated IDB write failure');const id=kind==='delete'?value:primary(name,value),at=tables[name].findIndex(row=>primary(name,row)===id);
          if(kind==='add'&&at>=0)throw Error('ConstraintError');if(kind==='delete'){if(at>=0)tables[name].splice(at,1);}else if(at>=0)tables[name][at]=structuredClone(value);else tables[name].push(structuredClone(value));writes.push({name,kind,id});return id;});
        return {get:id=>ask(()=>tables[name].find(row=>primary(name,row)===id)),getAll:(range,limit)=>ask(()=>all(range,limit)),put:value=>write('put',structuredClone(value)),add:value=>write('add',structuredClone(value)),delete:id=>write('delete',id),
          index:index=>({getAll:(range,limit)=>ask(()=>all(range,limit,index)),count:range=>ask(()=>all(range,undefined,index).length)})};};
      pending.push(done=>{finish=done;if(ended){done();return;}state.beforeTransaction?.({mode,names});tables=structuredClone(state.tables);state.transactions.push({mode,names});started=true;schedule();});drain();return tx;
    }};request.onsuccess?.();
  });return request;}};
  return {state,indexedDB,keyRange,open:options=>createLocalVibeEncodingStore({indexedDB,keyRange,now:()=>10,...options})};
}
