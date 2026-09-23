import assert from 'node:assert/strict';
import {createLocalComfyWorkflowStore} from '../../qianmu-comfy-library.js';
import {unpackComfyLibraryRecord} from '../../qianmu-comfy-library-backup.js';

// Bounded three-table protocol double, not browser acceptance. Production
// save/backup/census methods execute, with serialized atomic transactions.
export function comfyLibraryIdbFixture(packet){
  const records=packet?.workflows.map(row=>unpackComfyLibraryRecord(packet.namespace,row))||[];
  const state={tables:{workflows:records.map(row=>row.head),revisions:records.flatMap(row=>row.versions.map(v=>v.meta)),documents:records.flatMap(row=>row.versions.map(v=>v.document))},transactions:[],reads:[],writes:[],failOpen:false,beforeTransaction:null};
  const keyRange={only:value=>({only:value}),bound:(lower,upper)=>({lower,upper})},matches=(value,range)=>range===undefined||('only'in range?value===range.only:value>=range.lower&&value<=range.upper);
  const pending=[];let running=false;
  const drain=()=>{if(running||!pending.length)return;running=true;queueMicrotask(()=>pending.shift()(()=>{running=false;drain();}));};
  const indexedDB={open(){const request={};queueMicrotask(()=>{if(state.failOpen){request.onerror?.();return;}request.result={close(){},transaction(names,mode){
    assert.ok(names.every(name=>Object.hasOwn(state.tables,name)));assert.ok(['readonly','readwrite'].includes(mode));
    const tasks=[],writes=[];let tables,finish,started=false,ended=false,scheduled=false;
    const tx={abort(){if(ended)return;ended=true;queueMicrotask(()=>{tx.onabort?.();finish?.();});}};
    const schedule=()=>{if(!started||ended||scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(ended)return;const task=tasks.shift();
      if(!task){ended=true;if(mode==='readwrite')state.tables=tables;state.writes.push(...writes);tx.oncomplete?.();finish();return;}
      try{task.request.result=structuredClone(task.work());task.request.onsuccess?.();}catch(error){task.request.error=error;task.request.onerror?.();tx.onerror?.();tx.abort();return;}schedule();
    });};
    const ask=(name,kind,work)=>{assert.equal(ended,false);const request={};state.reads.push({name,kind});tasks.push({request,work});schedule();return request;};
    tx.objectStore=name=>{assert.ok(names.includes(name));const all=(range,limit,index)=>tables[name].filter(row=>matches(row[index||'key'],range)).sort((a,b)=>a.key.localeCompare(b.key)).slice(0,limit);
      const write=(kind,value)=>ask(name,kind,()=>{assert.equal(mode,'readwrite');const at=tables[name].findIndex(row=>row.key===value.key);if(at>=0&&kind==='add')throw Error('ConstraintError');if(at>=0)tables[name][at]=structuredClone(value);else tables[name].push(structuredClone(value));writes.push({name,kind,key:value.key});return value.key;});
      return {get:key=>ask(name,'get',()=>tables[name].find(row=>row.key===key)),getAll:(range,limit)=>ask(name,'getAll',()=>all(range,limit)),getAllKeys:(range,limit)=>ask(name,'getAllKeys',()=>all(range,limit).map(row=>row.key)),
        add:value=>write('add',structuredClone(value)),put:value=>write('put',structuredClone(value)),index:index=>({getAll:(range,limit)=>ask(name,'index',()=>all(range,limit,index))})};};
    pending.push(done=>{finish=done;if(ended){done();return;}state.beforeTransaction?.({names,mode});tables=structuredClone(state.tables);state.transactions.push({names:[...names],mode});started=true;schedule();});drain();return tx;
  }};request.onsuccess?.();});return request;}};
  return {state,indexedDB,keyRange,open:options=>createLocalComfyWorkflowStore({indexedDB,keyRange,now:()=>10,...options})};
}
