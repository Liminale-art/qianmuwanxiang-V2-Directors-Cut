import assert from 'node:assert/strict';
import {createComfySceneLockStore} from '../../qianmu-comfy-lock-store.js';

// Actual production two-table code over serialized atomic IDB protocol double.
// Deliberately no browser/network emulation or real-user database access.
export function comfySceneIdbFixture(snapshot){
  const state={tables:{scopes:new Map(snapshot?.rows.map(row=>[row.key,structuredClone(row.value)])||[]),usage:new Map(snapshot?.usage?[[snapshot.namespace,structuredClone(snapshot.usage)]]:[])},transactions:[],writes:[],reads:[],failOpen:false,beforeTransaction:null};
  const cmp=(a,b)=>{if(Array.isArray(a)&&Array.isArray(b)){for(let i=0;i<Math.min(a.length,b.length);i++){const c=cmp(a[i],b[i]);if(c)return c;}return a.length-b.length;}if(Array.isArray(a))return 1;if(Array.isArray(b))return -1;return a<b?-1:a>b?1:0;};
  const match=(key,range)=>range===undefined||range?.bound?range===undefined||cmp(key,range.lower)>=0&&cmp(key,range.upper)<=0:cmp(key,range)===0;
  const keyRange={bound:(lower,upper)=>({bound:true,lower,upper})},pending=[];let running=false;
  const drain=()=>{if(running||!pending.length)return;running=true;queueMicrotask(()=>pending.shift()(()=>{running=false;drain();}));};
  const indexedDB={open(){const request={};queueMicrotask(()=>{if(state.failOpen){request.onerror?.();return;}request.result={close(){},transaction(names,mode){
    assert.deepEqual([...names].sort(),['scopes','usage']);assert.ok(['readonly','readwrite'].includes(mode));let started=false,ended=false,scheduled=false,tables,done;const tasks=[],writes=[];
    const tx={abort(){if(ended)return;ended=true;queueMicrotask(()=>{tx.onabort?.();done?.();});}};
    const schedule=()=>{if(!started||ended||scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(ended)return;const task=tasks.shift();
      if(!task){ended=true;if(mode==='readwrite')state.tables=tables;state.writes.push(...writes);tx.oncomplete?.();done();return;}
      try{task();}catch(error){tx.error=error;tx.onerror?.();tx.abort();return;}schedule();
    });};
    const ask=(name,kind,work)=>{assert.equal(ended,false);state.reads.push({name,kind});const req={};tasks.push(()=>{req.result=structuredClone(work());req.onsuccess?.();});schedule();return req;};
    tx.objectStore=name=>{
      const entries=(range,index)=>[...tables[name]].filter(([key,value])=>match(index?[value.namespace,value.chatKey]:key,range)).sort((a,b)=>cmp(index?[a[1].namespace,a[1].chatKey]:a[0],index?[b[1].namespace,b[1].chatKey]:b[0])||cmp(a[0],b[0]));
      const cursor=(range,index)=>{const req={};let rows,at=0;const step=()=>{state.reads.push({name,kind:'cursor'});tasks.push(()=>{
        rows??=entries(range,index);const row=rows[at++];req.result=row?{primaryKey:row[0],value:structuredClone(row[1]),continue:step,delete:()=>ask(name,'delete',()=>{assert.equal(mode,'readwrite');tables[name].delete(row[0]);writes.push({name,key:row[0],kind:'delete'});})}:null;req.onsuccess?.();
      });schedule();};step();return req;};
      return {get:key=>ask(name,'get',()=>tables[name].get(key)),getAllKeys:(range,limit)=>ask(name,'keys',()=>entries(range).slice(0,limit).map(row=>row[0])),
        put:(value,key)=>{const captured=structuredClone(value);return ask(name,'put',()=>{assert.equal(mode,'readwrite');tables[name].set(key,captured);writes.push({name,key,kind:'put'});return key;});},
        index:index=>{assert.equal(index,'chat');return {openCursor:range=>cursor(range,index)};}};
    };
    pending.push(finish=>{done=finish;if(ended){done();return;}state.beforeTransaction?.({names,mode});tables=structuredClone(state.tables);state.transactions.push({names:[...names],mode});started=true;schedule();});drain();return tx;
  }};request.onsuccess?.();});return request;}};
  return {state,indexedDB,keyRange,open:options=>createComfySceneLockStore({indexedDB,keyRange,now:()=>100,...options})};
}
