import {mappingReceiptsFixture} from './storyboard-mapping-receipts.mjs';
import {mappingHead} from '../../qianmu-storyboard-mapping-contract.js';
import {captureBundleMappings} from '../../qianmu-bundle-mappings.js';
import {buildStoryboardBundle,openStoryboardBundle} from '../../qianmu-storyboard-bundle.js';
import {createBundleCarrierProof,inspectBundleCarrierProof,inspectBundleCarrierOriginal,collectBundleCarrierMembers} from '../../qianmu-bundle-carrier.js';
import {bundleCarrierHead,bundleCarrierOriginalHead} from '../../qianmu-bundle-carrier-storage-contract.js';
import {vibeDigest} from '../../qianmu-vibe-file.js';
export const namespace='st-user:carrier-transport';
export const carrierFile=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
export async function carrierPack(entries=[],createdAt=1){return buildStoryboardBundle({namespace,chatKey:'carrier-chat',createdAt,entries:[...['storyboard','workflows','pools','characters'].map(id=>({id,file:carrierFile({})})),...entries]});}
export async function carrierFixture({variant=true}={}){
  const records=await mappingReceiptsFixture({namespace});records[0].receipt.createdAt=1000;records[0].head=mappingHead(records[0].kind,records[0].receipt);
  const journal={listMappingHeads:async()=>records.map(row=>row.head),loadMappingReceipt:async(ns,kind,id)=>records.find(row=>row.kind===kind&&row.head.digest===id)?.receipt||null},mappings=await captureBundleMappings({namespace,journal});
  const rawEntries=await Promise.all(mappings.entries.map(async row=>({...row,file:variant&&row.id.startsWith('mapping:environment:')?new Blob([(await row.file.text()).replace('"createdAt":1000','"createdAt":1e+3')],{type:'application/json'}):row.file})));
  const proofs=[],heads=[],originals=[],rawFiles=new Map();
  for(const entry of rawEntries.filter(row=>row.id!=='mapping-receipts')){const sha=await vibeDigest(new Uint8Array(await entry.file.arrayBuffer()));rawFiles.set(sha,entry.file);originals.push(bundleCarrierOriginalHead(namespace,sha,entry.file.size));}
  for(const stamp of [21,22]){const built=await carrierPack(rawEntries,stamp),proof=await createBundleCarrierProof(await openStoryboardBundle(built.file));proofs.push(proof);heads.push(bundleCarrierHead((await inspectBundleCarrierProof(proof)).summary));}
  const store={list:async()=>structuredClone({heads,originals}),load:async(ns,id)=>structuredClone(proofs.find(row=>row.carrierDigest===id)||null),loadOriginal:async(ns,sha)=>rawFiles.get(sha)||null};
  return {records,journal,mappings,rawEntries,proofs,heads,originals,rawFiles,store};
}
export function memoryCarrierStore(){
  const state={heads:[],originals:[],proofs:new Map(),files:new Map(),events:[]};
  const store={
    list:async()=>{if(state.heads.some(row=>!state.proofs.has(row.carrierDigest))||state.originals.some(row=>!state.files.has(row.sha256)))throw Error('missing original');return structuredClone({heads:state.heads,originals:state.originals});},
    load:async(ns,id)=>structuredClone(state.proofs.get(id)||null),
    loadOriginal:async(ns,sha)=>{const file=state.files.get(sha);if(file&&await vibeDigest(new Uint8Array(await file.arrayBuffer()))!==sha)throw Error('original changed');return file||null;},
    saveOriginal:async(ns,file,{head,confirmed})=>{
      if(confirmed!==true)throw Error('consent');await inspectBundleCarrierOriginal(file,head,{namespace:ns});
      if(!state.files.has(head.sha256)){if(state.failRawAt===state.originals.length)throw Error('raw interrupted');state.files.set(head.sha256,file);state.originals.push(structuredClone(head));state.events.push('raw');}return head;
    },
    save:async(ns,proof,{confirmed,load})=>{
      if(confirmed!==true)throw Error('consent');const collected=await collectBundleCarrierMembers(proof,{load}),head=bundleCarrierHead(collected.summary);
      if(!state.proofs.has(proof.carrierDigest)){if(state.failProofAt===state.heads.length)throw Error('proof interrupted');state.proofs.set(proof.carrierDigest,structuredClone(proof));state.heads.push(head);state.events.push('proof');}return head;
    },
  };return {store,state};
}
