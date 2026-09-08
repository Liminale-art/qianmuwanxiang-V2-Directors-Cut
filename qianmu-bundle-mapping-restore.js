import {inspectBundleMappingIndex,inspectBundleMappingReceipt} from './qianmu-bundle-mappings.js';
import {bundleMappingEntryId,validateBundleMappingHeads,sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';
import {mappingHead,mappingBytes} from './qianmu-storyboard-mapping-contract.js';
import {inspectStoryboardEnvironmentReview} from './qianmu-storyboard-environment-map.js';
import {inspectStoryboardSubjectMapReview} from './qianmu-storyboard-subject-map.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_mappings',submissionState:'not_submitted'});};
const ordered=heads=>[...heads].sort((a,b)=>a.key<b.key?-1:1);

async function reserveHeads(reservations,namespace){
  if(!Array.isArray(reservations)||reservations.length>2)fail('本次迁移凭据空间预留无效');
  const heads=[];
  for(const item of reservations){
    if(!item||Object.keys(item).length!==2||!['environment','subjects'].includes(item.kind))fail('本次迁移凭据空间预留无效');
    const review=item.kind==='environment'?await inspectStoryboardEnvironmentReview(item.review):await inspectStoryboardSubjectMapReview(item.review),bytes=mappingBytes(review);
    if(review.namespace!==namespace||item.kind==='environment'&&review.state!=='mapping-required')fail('本次迁移凭据预留范围不符');
    heads.push(mappingHead(item.kind,{key:item.kind==='environment'?review.digest:JSON.stringify([namespace,review.digest,bytes]),namespace,review,...(item.kind==='subjects'?{bytes}:{}),createdAt:Number.MAX_SAFE_INTEGER}));
  }
  validateBundleMappingHeads(heads,namespace);return heads;
}
export async function planBundleMappingRestore({index,opened,journal,reservations=[],guard=async()=>{},isCurrent=()=>true}){
  const {namespace}=index;await inspectBundleMappingIndex(index,namespace);await guard();
  if(typeof journal?.importMappingReceipt!=='function'||typeof journal?.listMappingHeads!=='function'||typeof journal?.loadMappingReceipt!=='function')fail('请更新前端以完整恢复历史迁移凭据');
  const before=structuredClone(await journal.listMappingHeads(namespace,{guard,isCurrent}));validateBundleMappingHeads(before,namespace);await guard();
  const byKey=new Map(before.map(head=>[head.key,head])),reserved=await reserveHeads(reservations,namespace);let added=0,addedBytes=0;
  for(const head of index.heads){
    const local=byKey.get(head.key);
    if(local){
      if(!sameBundleMappingHead(local,head))fail('历史迁移凭据与本机的首次记录不同，请保留两边原备份核对；未覆盖');
      const saved=await journal.loadMappingReceipt(namespace,head.kind,head.digest,{isCurrent}),incoming=await opened.readJson(bundleMappingEntryId(head));await guard();
      await inspectBundleMappingReceipt(saved,head,namespace);
      if(await digest(saved)!==await digest(incoming))fail('历史迁移凭据原文冲突，未覆盖或丢弃');
    }else{added++;addedBytes+=head.bytes;byKey.set(head.key,head);}
  }
  for(const head of reserved)if(!byKey.has(head.key))byKey.set(head.key,head);
  try{validateBundleMappingHeads([...byKey.values()],namespace);}catch(_){fail('迁移凭据总空间或名额不足（含本次新映射预留），未恢复；不会自动删除历史');}
  await guard();
  const after=await journal.listMappingHeads(namespace,{guard,isCurrent});
  if(await digest(ordered(before))!==await digest(ordered(after)))fail('核对期间本机迁移凭据已变化，请重新核对');
  const summary={version:1,indexDigest:index.digest,count:index.heads.length,added,existing:index.heads.length-added,addedBytes,restoreAuthorized:false};
  return {...summary,digest:await digest({index:index.digest,before:ordered(before),reserved:ordered(reserved)})};
}

// Records are append-only through the journal. Check each full readback once; stage guards use their immutable heads.
export async function verifyBundleMappingRestore({index,journal,guard=async()=>{},isCurrent=()=>true}){
  await guard();const heads=await journal.listMappingHeads(index.namespace,{guard,isCurrent});validateBundleMappingHeads(heads,index.namespace);
  const lookup=new Map(heads.map(head=>[head.key,head]));
  if(index.heads.some(head=>!sameBundleMappingHead(head,lookup.get(head.key))))fail('历史迁移凭据尚未完整保存或已变化，未继续恢复资源');await guard();
}
export async function restoreBundleMappings({index,opened,journal,confirmed=false,guard=async()=>{},isCurrent=()=>true}){
  if(confirmed!==true)fail('请单独确认保存历史迁移凭据；旧批准不授权本次恢复');
  for(const head of index.heads){
    await guard();const receipt=await opened.readJson(bundleMappingEntryId(head));
    await inspectBundleMappingReceipt(receipt,head,index.namespace);await guard();
    await journal.importMappingReceipt(receipt,{head,confirmed:true,isCurrent});await guard();
    const saved=await journal.loadMappingReceipt(index.namespace,head.kind,head.digest,{isCurrent});
    await inspectBundleMappingReceipt(saved,head,index.namespace);
    if(await digest(saved)!==await digest(receipt))fail('历史迁移凭据写入结果未确认，请保留原包重新核对');await guard();
  }
  await verifyBundleMappingRestore({index,journal,guard,isCurrent});
}
