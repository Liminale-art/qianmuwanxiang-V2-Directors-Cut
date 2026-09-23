import assert from 'node:assert/strict';
import {createBundleCarrierStore} from '../../qianmu-bundle-carrier-store.js';

// Execute the actual old store against a readonly IDB protocol fixture. Any
// migration write/delete or full-body census is a test failure.
export function carrierLegacyFixture({heads=[],proofs=[],originals=[],rawFiles=new Map()}={}){
  const state={heads:structuredClone(heads),proofs:structuredClone(proofs),originals:structuredClone(originals),rawFiles:new Map(rawFiles),reads:[],error:false};
  const values=name=>name==='heads'?state.heads:name==='originalHeads'?state.originals:name==='proofs'?state.proofs.map(proof=>({key:JSON.stringify([proof.namespace,proof.carrierDigest]),namespace:proof.namespace,proof})):state.originals.filter(row=>state.rawFiles.has(row.sha256)).map(row=>({key:row.key,namespace:row.namespace,file:state.rawFiles.get(row.sha256)}));
  const indexedDB={open(){const request={};queueMicrotask(()=>{
    if(state.error){request.onerror?.();return;}
    request.result={close(){},transaction(names,mode){assert.equal(mode,'readonly');let pending=0,ended=false;
      const tx={abort(){ended=true;queueMicrotask(()=>tx.onabort?.());}};
      const ask=(name,kind,work)=>{const req={};pending++;state.reads.push({name,kind});queueMicrotask(()=>{if(ended)return;try{req.result=structuredClone(work());req.onsuccess?.();}catch(error){tx.abort();throw error;}finally{if(--pending===0)queueMicrotask(()=>{if(!ended)tx.oncomplete?.();});}});return req;};
      tx.objectStore=name=>({get:key=>ask(name,'get',()=>values(name).find(row=>row.key===key)),index:()=>({
        getAll:(ns,limit)=>{assert.ok(['heads','originalHeads'].includes(name));return ask(name,'getAll',()=>values(name).filter(row=>row.namespace===ns).slice(0,limit));},
        getAllKeys:(ns,limit)=>ask(name,'keys',()=>values(name).filter(row=>row.namespace===ns).slice(0,limit).map(row=>row.key))
      })});return tx;
    }};request.onsuccess?.();
  });return request;}};
  const keyRange={only:value=>value};return {state,indexedDB,keyRange,open:()=>createBundleCarrierStore({native:false,indexedDB,keyRange})};
}
