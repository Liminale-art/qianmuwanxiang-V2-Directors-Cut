import {createBundleCarrierProof,inspectBundleCarrierProof} from './qianmu-bundle-carrier.js';
import {inspectBundleCarriersIndex} from './qianmu-bundle-carriers.js';
import {bundleCarrierEntryId} from './qianmu-bundle-carriers-contract.js';
import {bundleCarrierHead,bundleCarrierOriginalHead,summarizeBundleCarrierStorage,summarizeBundleCarrierOriginals,sameCarrierFields} from './qianmu-bundle-carrier-storage-contract.js';
import {validateBundleCarrierRestoreSummary,validateBundleCarrierPageInput} from './qianmu-bundle-carrier-restore-contract.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_carrier_restore',submissionState:'not_submitted'});};
const ordered=rows=>[...rows].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);

// Frozen source descriptor stays in the restore worker. Only heads/counts/pages leave it.
export async function createBundleCarrierRestore({opened,store,guard=async()=>{},isCurrent=()=>true}){
  if(!store?.list||!store?.load||!store?.loadOriginal||!store?.saveBatch)fail('来源恢复存储不可用，请更新前端');
  const check=async()=>{if(isCurrent()!==true)fail('来源恢复页面已变化');await guard();if(isCurrent()!==true)fail('来源恢复页面已变化');};
  const {namespace}=opened.manifest,sourceDigest=opened.fingerprint;
  const index=opened.manifest.entries.some(row=>row.id==='bundle-carriers')?await inspectBundleCarriersIndex(await opened.readJson('bundle-carriers'),namespace):null;
  const current=await createBundleCarrierProof(opened,{guard:check}),checked=await inspectBundleCarrierProof(current,{namespace,guard:check}),currentHead=bundleCarrierHead(checked.summary);
  const heads=new Map((index?.heads||[]).map(head=>[head.key,head])),originals=new Map(),entries=new Map();
  if(heads.has(currentHead.key))fail('本次载体不能作为自己的旧来源');heads.set(currentHead.key,currentHead);
  for(const row of index?.originals||[]){const {entryId,...head}=row;originals.set(head.key,head);entries.set(head.sha256,entryId);}
  for(const member of checked.members){const head=bundleCarrierOriginalHead(namespace,member.sha256,member.head.bytes),old=originals.get(head.key);if(old&&!sameCarrierFields(old,head))fail('本次成员原文与旧来源冲突');originals.set(head.key,head);entries.set(head.sha256,member.id);}
  const desired={heads:ordered([...heads.values()]),originals:ordered([...originals.values()])};
  const descriptorDigest=await digest({sourceDigest,...desired}),getProof=async head=>head.carrierDigest===sourceDigest?current:opened.readJson(bundleCarrierEntryId(head));
  const getOriginal=async sha256=>{const id=entries.get(sha256);if(!id)fail('缺少来源成员原始分段');return (await opened.read(id)).file;};
  const inventory=async()=>{await check();const value=await store.list(namespace,{guard:check,isCurrent});summarizeBundleCarrierStorage(value.heads,namespace);summarizeBundleCarrierOriginals(value.originals,namespace);await check();return {heads:ordered(value.heads),originals:ordered(value.originals)};};
  async function preview(){
    const before=await inventory(),mergedHeads=new Map(before.heads.map(row=>[row.key,row])),mergedOriginals=new Map(before.originals.map(row=>[row.key,row]));let added=0,addedOriginals=0;
    for(const head of desired.heads){
      const existing=mergedHeads.get(head.key);if(existing){
        if(!sameCarrierFields(existing,head))fail('同一载体的本机来源证明不同，未覆盖');
        const proof=await store.load(namespace,head.carrierDigest,{guard:check,isCurrent});if(!sameCarrierFields(proof,await getProof(head)))fail('来源证明完整原文冲突');
      }else{added++;mergedHeads.set(head.key,head);}await check();
    }
    for(const head of desired.originals){
      const existing=mergedOriginals.get(head.key);if(existing){if(!sameCarrierFields(existing,head)||!(await store.loadOriginal(namespace,head.sha256,{guard:check,isCurrent})))fail('来源成员原文冲突或缺失');}
      else{addedOriginals++;mergedOriginals.set(head.key,head);}await check();
    }
    let metadata,raw;try{metadata=summarizeBundleCarrierStorage([...mergedHeads.values()],namespace);raw=summarizeBundleCarrierOriginals([...mergedOriginals.values()],namespace);}catch(_){fail('来源关联总空间或名额不足（含本次载体与原成员），未恢复；不会自动清理');}
    const beforeBytes=summarizeBundleCarrierStorage(before.heads,namespace).bytes+summarizeBundleCarrierOriginals(before.originals,namespace).bytes;
    if(await digest(before)!==await digest(await inventory()))fail('核对期间来源记录已变化，请重新核对');
    return validateBundleCarrierRestoreSummary({version:1,namespace,sourceDigest,descriptorDigest,count:desired.heads.length,added,existing:desired.heads.length-added,originalCount:desired.originals.length,addedOriginals,existingOriginals:desired.originals.length-addedOriginals,
      addedBytes:metadata.bytes+raw.bytes-beforeBytes,totalBytes:metadata.bytes+raw.bytes,digest:await digest({descriptorDigest,before}),restoreAuthorized:false},namespace,sourceDigest);
  }
  async function verify(){
    const saved=await inventory(),local=new Map(saved.heads.map(row=>[row.key,row])),raw=new Map(saved.originals.map(row=>[row.key,row]));
    if(desired.heads.some(head=>!sameCarrierFields(local.get(head.key),head))||desired.originals.some(head=>!sameCarrierFields(raw.get(head.key),head)))fail('来源关联或原成员尚未完整保存，未继续恢复资源');await check();
  }
  async function restore(approved,{confirmed=false}={}){
    if(confirmed!==true)fail('请单独确认保全全部来源记录及原成员');validateBundleCarrierRestoreSummary(approved,namespace,sourceDigest);
    if((await preview()).digest!==approved.digest)fail('确认后来源库已变化，请重新核对');
    // The store owns unique-original validation and full byte readback for this batch.
    // Preserve orphan originals too, then historic proofs, then this carrier; partial progress stays inspectable.
    await store.saveBatch(namespace,{heads:[...desired.heads.filter(row=>row.carrierDigest!==sourceDigest),currentHead],originals:desired.originals},
      {confirmed:true,loadProof:getProof,loadOriginal:getOriginal,guard:check,isCurrent});
    await verify();
  }
  return Object.freeze({preview,restore,verify,async page(input){validateBundleCarrierPageInput(input);await check();const rows=[currentHead,...desired.heads.filter(row=>row.carrierDigest!==sourceDigest)];if(input.offset&&input.offset>=rows.length)fail('来源目录页已变化');return {version:1,namespace,sourceDigest,descriptorDigest,offset:input.offset,total:rows.length,rows:rows.slice(input.offset,input.offset+24).map(head=>({...head,current:head.carrierDigest===sourceDigest}))};}});
}
