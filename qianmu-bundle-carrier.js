import {inspectStoryboardBundleManifestText} from './qianmu-storyboard-bundle.js';
import {parseStrictStoryboardJson} from './qianmu-storyboard-package-input.js';
import {BUNDLE_CARRIER_SCHEMA,BUNDLE_CARRIER_SCOPE,BUNDLE_CARRIER_LIMITS,validateBundleCarrierProofShape,validateBundleCarrierSummary} from './qianmu-bundle-carrier-contract.js';
import {bundleMappingEntryId,isBundleMappingEntry} from './qianmu-bundle-mapping-contract.js';
import {inspectBundleMappingIndex,inspectBundleMappingReceipt} from './qianmu-bundle-mappings.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {mappingHead} from './qianmu-storyboard-mapping-contract.js';
import {validateBundleCarrierOriginalHead} from './qianmu-bundle-carrier-storage-contract.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_carrier',submissionState:'not_submitted'});};
const bytes=value=>new TextEncoder().encode(value).byteLength;
const decode=value=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch(_){fail('来源关联文本不是完整UTF-8');}};

// Retain the exact original manifest text: re-serializing parsed JSON would change an otherwise valid carrier digest.
// This establishes declared section membership only, NOT authenticated ownership or successful resource restoration.
export async function inspectBundleCarrierProof(input,{namespace=input?.namespace,guard=async()=>{}}={}){
  await guard();
  validateBundleCarrierProofShape(input,namespace);const size=bytes(JSON.stringify(input));if(size>BUNDLE_CARRIER_LIMITS.proof)fail('来源关联凭据超过5MiB，未截断');
  const proof=structuredClone(input),{digest:expected,...core}=proof;
  const checked=await inspectStoryboardBundleManifestText(proof.manifestText,{guard});
  if(checked.manifest.namespace!==namespace||checked.fingerprint!==proof.carrierDigest||await digest(core)!==expected)fail('来源关联的原包指纹、账户或凭据摘要不符');await guard();
  const entries=checked.manifest.entries,indexEntry=entries.find(row=>row.id==='mapping-receipts'),parts=entries.filter(row=>isBundleMappingEntry(row.id));let index=null;
  if(Boolean(indexEntry)!==(proof.mappingIndexText!==null))fail('来源包历史目录的存在状态不符，不能用空目录代替未记录');
  if(indexEntry){
    const encoded=new TextEncoder().encode(proof.mappingIndexText);
    if(encoded.length>BUNDLE_CARRIER_LIMITS.index||encoded.length!==indexEntry.bytes||await vibeDigest(encoded)!==indexEntry.sha256)fail('历史目录不属于此原包，未拼接来源');await guard();
    index=await inspectBundleMappingIndex(parseStrictStoryboardJson(proof.mappingIndexText,{maxBytes:BUNDLE_CARRIER_LIMITS.index}),namespace);
    const required=new Map(index.heads.map(head=>[bundleMappingEntryId(head),head]));
    if(parts.length!==required.size||parts.some(row=>!required.has(row.id)||row.bytes!==required.get(row.id).bytes))fail('来源关联的历史分段缺失、多余或大小不符');
  }
  const byId=new Map(parts.map(row=>[row.id,row]));
  // local USER v2 sourceDigest is a binding snapshot, never a package-origin edge even if the strings happen to match.
  const members=(index?.heads||[]).map(head=>({head:structuredClone(head),id:bundleMappingEntryId(head),sha256:byId.get(bundleMappingEntryId(head)).sha256,originKind:head.version===2?'binding-snapshot':'declared-bundle'}));
  const summary=validateBundleCarrierSummary({version:1,namespace,carrierDigest:proof.carrierDigest,digest:proof.digest,chatHash:await vibeDigest(checked.manifest.chatKey),createdAt:checked.manifest.createdAt,fileBytes:checked.fileBytes,manifestBytes:checked.manifestBytes,
    indexBytes:indexEntry?.bytes||0,receiptCount:members.length,indexState:index?members.length?'recorded':'empty':'absent',bytes:size,identityVerified:false,restoreAuthorized:false},namespace);
  await guard();return {proof,summary,members};
}

async function verifyMember(member,content,namespace,guard){
  if(!(content instanceof Uint8Array)||content.byteLength!==member.head.bytes||await vibeDigest(content)!==member.sha256)fail('历史凭据原件与原包分段指纹不符，未声明来源关联');await guard();
  const receipt=parseStrictStoryboardJson(decode(content),{maxBytes:9*1048576});await inspectBundleMappingReceipt(receipt,member.head,namespace);await guard();
}
export async function createBundleCarrierProof(opened,{guard=async()=>{}}={}){
  await guard();const checked=await inspectStoryboardBundleManifestText(opened?.manifestText,{guard});
  if(checked.fingerprint!==opened.fingerprint||checked.fileBytes!==opened.fileBytes)fail('来源包在关联核对前已变化');
  const indexEntry=checked.manifest.entries.find(row=>row.id==='mapping-receipts');
  const core={schema:BUNDLE_CARRIER_SCHEMA,scope:BUNDLE_CARRIER_SCOPE,namespace:checked.manifest.namespace,carrierDigest:checked.fingerprint,manifestText:checked.manifestText,mappingIndexText:indexEntry?decode((await opened.read(indexEntry.id)).bytes):null};
  const value=await inspectBundleCarrierProof({...core,digest:await digest(core)},{guard});
  for(const member of value.members){await guard();const part=await opened.read(member.id);await verifyMember(member,part.bytes,core.namespace,guard);}
  await guard();return value.proof;
}

// The original receipts remain separate and deduplicated. A proof cannot replace missing receipt bodies.
export async function collectBundleCarrierMembers(input,{load,guard=async()=>{}}={}){
  if(typeof load!=='function')fail('缺少原迁移凭据读取接口');const value=await inspectBundleCarrierProof(input,{guard});
  const files=[];
  for(const member of value.members){
    await guard();const file=await load({kind:member.head.kind,digest:member.head.digest,sha256:member.sha256});await guard();
    if(!(file instanceof Blob)||file.size!==member.head.bytes)fail('来源关联缺少完整原迁移凭据');
    await verifyMember(member,new Uint8Array(await file.arrayBuffer()),value.proof.namespace,guard);
    files.push({sha256:member.sha256,bytes:file.size,file:file.slice(0,file.size,'application/json')});
  }
  return {summary:value.summary,files};
}
export async function verifyBundleCarrierMembers(input,options){
  return (await collectBundleCarrierMembers(input,options)).summary;
}
export async function inspectBundleCarrierOriginal(file,head,{namespace=head?.namespace,guard=async()=>{}}={}){
  await guard();validateBundleCarrierOriginalHead(head,namespace);
  if(!(file instanceof Blob)||file.size!==head.bytes)fail('来源成员原文缺失或大小不符');
  const content=new Uint8Array(await file.arrayBuffer());await guard();if(await vibeDigest(content)!==head.sha256)fail('来源成员原文指纹不符');
  const receipt=parseStrictStoryboardJson(decode(content),{maxBytes:9*1048576}),kind=receipt?.review?.schema==='qianmu.storyboard.environment-map.v1'?'environment':'subjects';
  let derived;try{derived=mappingHead(kind,receipt);}catch(_){fail('来源成员凭据结构不完整');}
  await inspectBundleMappingReceipt(receipt,derived,namespace);await guard();return derived;
}
