import {BUNDLE_MAPPING_SCHEMA,BUNDLE_MAPPING_LIMITS,bundleMappingEntryId,isBundleMappingEntry,validateBundleMappingHeads,validateBundleMappingIndex,bundleMappingSummary} from './qianmu-bundle-mapping-contract.js';
import {mappingHead,mappingBytes} from './qianmu-storyboard-mapping-contract.js';
import {inspectStoryboardEnvironmentReview,validateStoryboardEnvironmentReceipt} from './qianmu-storyboard-environment-map.js';
import {inspectStoryboardSubjectMapReview} from './qianmu-storyboard-subject-map.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_mappings',submissionState:'not_submitted'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const jsonFile=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
const ordered=heads=>[...heads].sort((a,b)=>bundleMappingEntryId(a)<bundleMappingEntryId(b)?-1:1);

// Validate the complete original proof, not just its small directory entry. Never execute its historic choices.
export async function inspectBundleMappingReceipt(receipt,head,namespace){
  validateBundleMappingHeads([head],namespace);
  if(!receipt||mappingBytes(receipt)>BUNDLE_MAPPING_LIMITS.receipt)fail('迁移凭据原文缺失或超限');
  if(head.kind==='environment'){
    validateStoryboardEnvironmentReceipt(receipt);await inspectStoryboardEnvironmentReview(receipt.review);
  }else{
    if(!exact(receipt,['key','namespace','review','bytes','createdAt'])||!Number.isSafeInteger(receipt.createdAt)||receipt.createdAt<0)fail('角色映射原凭据不完整');
    const review=await inspectStoryboardSubjectMapReview(receipt.review),bytes=mappingBytes(receipt.review);
    if(review.namespace!==namespace||receipt.bytes!==bytes||receipt.key!==JSON.stringify([namespace,review.digest,bytes]))fail('角色映射原文与索引不符');
  }
  if(receipt.namespace!==namespace||await digest(mappingHead(head.kind,receipt))!==await digest(head))fail('迁移凭据与目录不符，未改写原时间或来源');
  return receipt;
}

export async function inspectBundleMappingIndex(input,namespace){
  validateBundleMappingIndex(input,namespace);
  if(mappingBytes(input)>BUNDLE_MAPPING_LIMITS.index)fail('迁移凭据目录超过1MiB');
  const {digest:expected,...core}=input;
  if(await digest(core)!==expected)fail('迁移凭据目录摘要不符');
  return input;
}

// Worker-only: retain Blob handles plus small heads, never a second array of all full receipt bodies.
export async function captureBundleMappings({namespace,journal,guard=async()=>{},isCurrent=()=>true}){
  if(typeof journal?.listMappingHeads!=='function'||typeof journal?.loadMappingReceipt!=='function')fail('迁移凭据库不可读取，未输出遗漏历史来源的备份');
  const check=async()=>{if(isCurrent()!==true)fail('迁移凭据备份页面已变化');await guard();if(isCurrent()!==true)fail('迁移凭据备份页面已变化');};
  const list=async()=>{await check();const heads=structuredClone(await journal.listMappingHeads(namespace,{guard:check,isCurrent}));validateBundleMappingHeads(heads,namespace);await check();return ordered(heads);};
  const heads=await list(),baseline=await digest(heads),core={schema:BUNDLE_MAPPING_SCHEMA,scope:'historical-records-only',namespace,heads};
  const index=await inspectBundleMappingIndex({...core,digest:await digest(core)},namespace),entries=[{id:'mapping-receipts',file:jsonFile(index)}];
  for(const head of heads){
    await check();const receipt=await journal.loadMappingReceipt(namespace,head.kind,head.digest,{isCurrent});
    await inspectBundleMappingReceipt(receipt,head,namespace);await check();
    entries.push({id:bundleMappingEntryId(head),file:jsonFile(receipt)});
  }
  const verify=async()=>{if(await digest(await list())!==baseline)fail('打包期间迁移凭据已变化，请重新导出；未输出缺件包');await check();};
  await verify();return {entries,index,summary:bundleMappingSummary(index),verify};
}

export async function inspectBundleMappings(opened,{guard=async()=>{}}={}){
  const {namespace,entries}=opened.manifest,recorded=entries.some(row=>row.id==='mapping-receipts'),parts=entries.filter(row=>isBundleMappingEntry(row.id));
  if(!recorded){if(parts.length)fail('迁移凭据缺少目录，不能作为未知分段丢弃');return null;}
  const index=await inspectBundleMappingIndex(await opened.readJson('mapping-receipts'),namespace);await guard();
  const expected=new Map(index.heads.map(head=>[bundleMappingEntryId(head),head]));
  if(parts.length!==expected.size||parts.some(part=>!expected.has(part.id)||part.bytes!==expected.get(part.id).bytes))fail('迁移凭据分段缺失、多余或大小不符');
  for(const head of index.heads){
    const receipt=await opened.readJson(bundleMappingEntryId(head));await guard();
    await inspectBundleMappingReceipt(receipt,head,namespace);await guard();
  }
  return {index,summary:bundleMappingSummary(index)};
}
