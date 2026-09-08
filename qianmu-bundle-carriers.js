import {BUNDLE_CARRIERS_SCHEMA,bundleCarrierEntryId,isBundleCarrierEntry,isBundleCarrierOriginalEntry,validateBundleCarriersIndex,bundleCarriersSummary} from './qianmu-bundle-carriers-contract.js';
import {bundleCarrierHead,sameCarrierFields,summarizeBundleCarrierStorage,summarizeBundleCarrierOriginals} from './qianmu-bundle-carrier-storage-contract.js';
import {inspectBundleCarrierProof,inspectBundleCarrierOriginal} from './qianmu-bundle-carrier.js';
import {sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_carriers',submissionState:'not_submitted'});};
const file=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
const sorted=rows=>[...rows].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
function requireDeclaredCarriers(proof,ids){
  // Only explicit carrier IDs in the verified original manifest form these links; USER binding snapshots do not.
  for(const row of JSON.parse(proof.manifestText).entries)if(isBundleCarrierEntry(row.id)&&(row.id===`carrier:${proof.carrierDigest}`||!ids.has(row.id)))fail('原清单声明的旧载体来源缺失，未省略中间来源');
}
export async function inspectBundleCarriersIndex(value,namespace){
  validateBundleCarriersIndex(value,namespace);if(file(value).size>1048576)fail('来源关联目录超过1MiB');const {digest:expected,...core}=value;if(await digest(core)!==expected)fail('来源关联目录摘要不符');return value;
}
async function original(blob,head,namespace,mappings,guard){
  const derived=await inspectBundleCarrierOriginal(blob,head,{namespace,guard});
  const expected=mappings?.heads.find(row=>row.kind===derived.kind&&row.digest===derived.digest);
  if(!expected||!sameBundleMappingHead(expected,derived))fail('来源成员缺少同一完整历史记录，未丢弃旧资料');
  await guard();return expected;
}
function requireVerifiedMembers(proof,verified){
  // This private map is built only by full raw-SHA/receipt validation in this operation.
  // Retain scalar heads, never decoded receipts or a reusable cross-session approval.
  for(const member of proof.members)if(!sameBundleMappingHead(verified.get(member.sha256),member.head))fail('来源成员原文缺失或与原目录不符，未声明来源关联');
}

// Flat, deduplicated transport: old full packages are never nested. Standard raw members reuse mapping sections.
export async function captureBundleCarriers({namespace,store,mappings,guard=async()=>{},isCurrent=()=>true}){
  if(!store?.list||!store?.load||!store?.loadOriginal||!mappings?.index)fail('来源关联或原迁移凭据不可读取，未输出遗漏来源的备份');
  const check=async()=>{if(isCurrent()!==true)fail('来源关联备份页面已变化');await guard();if(isCurrent()!==true)fail('来源关联备份页面已变化');};
  const inventory=async()=>{await check();const value=structuredClone(await store.list(namespace,{guard:check,isCurrent}));summarizeBundleCarrierStorage(value.heads,namespace);summarizeBundleCarrierOriginals(value.originals,namespace);await check();return {heads:sorted(value.heads),originals:sorted(value.originals)};};
  const before=await inventory(),baseline=await digest(before),mappingFiles=new Map(),verified=new Map(),entries=[],originals=[];
  const carrierIds=new Set(before.heads.map(bundleCarrierEntryId));
  for(const entry of mappings.entries){if(entry.id==='mapping-receipts')continue;await check();const sha=await vibeDigest(new Uint8Array(await entry.file.arrayBuffer()));mappingFiles.set(sha,entry);}
  for(const head of before.originals){
    await check();const blob=await store.loadOriginal(namespace,head.sha256,{guard:check,isCurrent});verified.set(head.sha256,Object.freeze({...await original(blob,head,namespace,mappings.index,check)}));
    const reused=mappingFiles.get(head.sha256),entryId=reused?reused.id:`carrier-original:${head.sha256}`;
    originals.push({...head,entryId});if(!reused)entries.push({id:entryId,file:blob});
  }
  for(const head of before.heads){
    await check();const proof=await store.load(namespace,head.carrierDigest,{guard:check,isCurrent}),inspected=await inspectBundleCarrierProof(proof,{namespace,guard:check});
    if(!sameCarrierFields(head,bundleCarrierHead(inspected.summary)))fail('来源关联原文与目录不符');
    requireDeclaredCarriers(proof,carrierIds);
    requireVerifiedMembers(inspected,verified);entries.push({id:bundleCarrierEntryId(head),file:file(proof)});
  }
  const core={schema:BUNDLE_CARRIERS_SCHEMA,scope:'historical-carriers-only',namespace,heads:before.heads,originals:originals.sort((a,b)=>a.sha256<b.sha256?-1:1)},index=await inspectBundleCarriersIndex({...core,digest:await digest(core)},namespace);
  entries.unshift({id:'bundle-carriers',file:file(index)});
  const verify=async()=>{if(await digest(await inventory())!==baseline)fail('打包期间来源关联已变化，请重新导出');await check();};
  await verify();return {index,entries,summary:bundleCarriersSummary(index),verify};
}
export async function inspectBundleCarriers(opened,{mappings,guard=async()=>{}}={}){
  const {namespace,entries}=opened.manifest,indexEntry=entries.find(row=>row.id==='bundle-carriers'),proofs=entries.filter(row=>isBundleCarrierEntry(row.id)),raw=entries.filter(row=>isBundleCarrierOriginalEntry(row.id));
  if(!indexEntry){if(proofs.length||raw.length)fail('来源关联缺少清单');return null;}
  const index=await inspectBundleCarriersIndex(await opened.readJson('bundle-carriers'),namespace),expected=new Map(index.heads.map(head=>[bundleCarrierEntryId(head),head])),extras=index.originals.filter(row=>isBundleCarrierOriginalEntry(row.entryId));
  if(proofs.length!==expected.size||proofs.some(row=>!expected.has(row.id)||row.bytes!==expected.get(row.id).bytes)||raw.length!==extras.length||raw.some(row=>!extras.some(head=>head.entryId===row.id)))fail('来源关联分段缺失或多余');
  const verified=new Map();for(const row of index.originals){
    const {entryId,...head}=row,entry=entries.find(item=>item.id===entryId);if(!entry||entry.sha256!==head.sha256||entry.bytes!==head.bytes)fail('来源成员所指原始分段不符');
    const part=await opened.read(entryId);verified.set(head.sha256,Object.freeze({...await original(part.file,head,namespace,mappings?.index,guard)}));
  }
  for(const head of index.heads){
    const proof=await opened.readJson(bundleCarrierEntryId(head)),value=await inspectBundleCarrierProof(proof,{namespace,guard});
    if(!sameCarrierFields(head,bundleCarrierHead(value.summary)))fail('来源关联证明与清单不符');
    requireDeclaredCarriers(proof,new Set(expected.keys()));
    requireVerifiedMembers(value,verified);
  }
  await guard();return {index,summary:bundleCarriersSummary(index)};
}
