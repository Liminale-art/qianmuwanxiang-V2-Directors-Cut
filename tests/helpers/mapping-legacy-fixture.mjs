import assert from 'node:assert/strict';
import {createStoryboardPackageJournal} from '../../qianmu-storyboard-package-journal.js';
import {mappingHead} from '../../qianmu-storyboard-mapping-contract.js';

// Existing IDB, read-only protocol double. Executes the real legacy journal;
// any write or deletion during native adoption is a test failure.
export function mappingLegacyFixture(rows=[],{indexed=true,checkpoints=[]}={}){
  const state={rows:structuredClone(rows),checkpoints:structuredClone(checkpoints),reads:[],indexed,error:false};
  const indexedDB={open(){const request={};queueMicrotask(()=>{
    if(state.error){request.onerror?.();return;}
    request.result={close(){},transaction(names,mode){
      assert.equal(mode,'readonly');state.reads.push(names);let pending=0,ended=false;
      const tx={abort(){ended=true;queueMicrotask(()=>tx.onabort?.());}};
      const ask=work=>{const req={};pending++;queueMicrotask(()=>{if(ended)return;try{req.result=structuredClone(work());req.onsuccess?.();}catch(error){req.error=error;tx.abort();throw error;}finally{if(--pending===0)queueMicrotask(()=>{if(!ended)tx.oncomplete?.();});}});return req;};
      const values=name=>name==='checkpoints'?state.checkpoints:name==='mappingHeads'?(state.indexed?state.rows.map(row=>mappingHead(row.kind,row.receipt)):[]):['environmentMaps','subjectMaps'].includes(name)?state.rows.filter(row=>row.kind===(name==='environmentMaps'?'environment':'subjects')).map(row=>row.receipt):[];
      tx.objectStore=name=>({get:key=>ask(()=>values(name).find(row=>row.key===key)),getKey:key=>ask(()=>{const row=values(name).find(row=>row.key===key||row.namespace===key);return row?(row.key??row.namespace):undefined;}),index:()=>({
        getAll:(ns,limit)=>ask(()=>values(name).filter(row=>row.namespace===ns).slice(0,limit)),
        getAllKeys:(ns,limit)=>ask(()=>values(name).filter(row=>row.namespace===ns).slice(0,limit).map(row=>row.key)),
        count:ns=>ask(()=>values(name).filter(row=>row.namespace===ns).length)
      })});return tx;
    }};request.onsuccess?.();
  });return request;}};
  const keyRange={only:value=>value};
  return {state,indexedDB,keyRange,open:()=>createStoryboardPackageJournal({native:false,indexedDB,keyRange})};
}
