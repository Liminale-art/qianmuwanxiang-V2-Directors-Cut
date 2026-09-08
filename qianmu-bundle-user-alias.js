import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
import {projectAliasBindings,selectUserAliasBindings} from './qianmu-user-alias-bindings.js';
import {validateCharacterLibraryBackup} from './qianmu-character-library-backup.js';
import {inspectStoryboardSubjectEvidence,SUBJECT_EVIDENCE_SCHEMA} from './qianmu-storyboard-subject-evidence.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const BUNDLE_USER_ALIAS_SCHEMA='qianmu.storyboard.bundle-user-alias.v1';
const fields=['schema','scope','namespace','sourceDigest','sourceEvidence','sourceBindings','selections','projectedEvidenceDigest','projectedBindingsDigest','digest'];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
const key=row=>JSON.stringify([row.category,row.subjectKey]);
const order=(a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0;
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_user_alias',submissionState:'not_submitted'});};
const receiptSize=value=>new TextEncoder().encode(JSON.stringify(value)).length;

// This is a detached SOURCE projection, never a claim that a persona exists in the target ST.
// Every original evidence row survives in the receipt. Mixed snapshots are not promoted to a match.
async function projectEvidence(input,bindings){
  const original=await inspectStoryboardSubjectEvidence(input),sources=new Map(original.subjects.map(row=>[key(row),row]));
  if(bindings.some(row=>!sources.has(key(row))))fail('原包资料摘要缺少绑定来源，不能推测USER地址');
  const groups=new Map();
  for(const row of original.subjects){
    const canonical=row.category==='user'?canonicalUserSubjectKey(row.subjectKey):null;
    if(row.category==='user'&&/^user:\/User(?:%20| )Avatars\//.test(row.subjectKey)&&!canonical)fail('原包USER头像地址编码或路径无效，请保留原文件');
    const target={category:row.category,subjectKey:canonical||row.subjectKey},id=key(target);
    if(!groups.has(id))groups.set(id,{target,sources:[]});groups.get(id).sources.push(row);
  }
  const subjects=[],addresses=[];let unverified=0;
  for(const {target,sources:rows} of groups.values()){
    const first=rows[0],same=rows.every(row=>row.state===first.state&&row.sha256===first.sha256);
    subjects.push({...target,state:same?first.state:'unavailable',sha256:same?first.sha256:null});
    if(rows.length>1||first.subjectKey!==target.subjectKey){
      if(!same)unverified++;
      for(const row of rows)addresses.push({source:row,targetKey:target.subjectKey,consistent:same});
    }
  }
  subjects.sort(order);addresses.sort((a,b)=>order(a.source,b.source));
  const core={schema:SUBJECT_EVIDENCE_SCHEMA,scope:original.scope,subjects},evidence={...core,digest:await vibeDigest(JSON.stringify(core))};
  await inspectStoryboardSubjectEvidence(evidence);return {original,evidence,addresses,unverified};
}

async function projection({namespace,bindings,evidence,sourceDigest,choices={}}){
  if(!hash(sourceDigest))fail('来源地址整理缺少原包指纹');
  const before=projectAliasBindings(bindings,namespace),profiles=await projectEvidence(evidence,before);
  const selected=await selectUserAliasBindings({namespace,bindings:before,choices,origin:{sourceDigest,evidenceDigest:profiles.original.digest}});
  const ready=selected.unresolved===0,changed=profiles.addresses.length>0;
  let receipt=null;
  if(ready&&changed){
    const core={schema:BUNDLE_USER_ALIAS_SCHEMA,scope:'source-bindings-only',namespace,sourceDigest,sourceEvidence:profiles.original,sourceBindings:before,selections:selected.selections,
      projectedEvidenceDigest:profiles.evidence.digest,projectedBindingsDigest:await digest(selected.after)};
    receipt={...core,digest:await digest(core)};
    if(receiptSize(receipt)>8*1048576)fail('来源地址凭据超过8MiB，原关系未截断');
  }
  return {...selected,namespace,sourceDigest,evidence:profiles.evidence,sourceEvidence:profiles.original,addresses:profiles.addresses,unverified:profiles.unverified,ready,changed,receipt,
    digest:await digest({namespace,sourceDigest,evidence:profiles.original.digest,bindings:before,choices,receipt:receipt?.digest||null})};
}

// Worker-only domain primitive. Callers must retain the original package, explicitly review the
// projection, verify final ST targets and save its receipt before using value in any restore write.
export async function planBundleUserAliases({library,evidence,sourceDigest,choices={}}){
  validateCharacterLibraryBackup(library);
  const plan=await projection({namespace:library.namespace,bindings:library.bindings,evidence,sourceDigest,choices});
  const value=!plan.ready?null:plan.affected.length?{...library,bindings:plan.after,usage:{...library.usage,bindings:plan.after.length}}:library;
  if(value)validateCharacterLibraryBackup(value);
  const names=new Map(library.archives.map(row=>[row.head.id,row.head.name]));
  return {...plan,value,display:plan.display.map(row=>({...row,archiveName:names.get(row.archiveId)||''}))};
}

export async function replayBundleUserAliasReceipt(value,{namespace,sourceDigest,bindings,evidence}={}){
  if(!exact(value,fields)||value.schema!==BUNDLE_USER_ALIAS_SCHEMA||value.scope!=='source-bindings-only'||!hash(value.digest)||!hash(value.projectedEvidenceDigest)||!hash(value.projectedBindingsDigest)
    ||!Array.isArray(value.selections)||value.selections.length>2048||receiptSize(value)>8*1048576)fail('来源USER地址凭据格式无效');
  if(namespace!==undefined&&namespace!==value.namespace||sourceDigest!==undefined&&sourceDigest!==value.sourceDigest)fail('来源USER地址凭据不属于当前原包或账户');
  const choices={};for(const row of value.selections){
    if(!exact(row,['groupId','candidateId'])||!hash(row.groupId)||!hash(row.candidateId)||Object.hasOwn(choices,row.groupId))fail('来源USER地址选择重复或无效');choices[row.groupId]=row.candidateId;
  }
  if(bindings!==undefined&&await digest(projectAliasBindings(bindings,value.namespace))!==await digest(value.sourceBindings))fail('来源USER地址凭据与原包绑定不符');
  if(evidence!==undefined&&await digest(await inspectStoryboardSubjectEvidence(evidence))!==await digest(value.sourceEvidence))fail('来源USER地址凭据与原包资料不符');
  const plan=await projection({namespace:value.namespace,bindings:value.sourceBindings,evidence:value.sourceEvidence,sourceDigest:value.sourceDigest,choices});
  if(!plan.ready||!plan.receipt||await digest(plan.receipt)!==await digest(value))fail('来源USER地址凭据与原关系、选择或派生结果不符');
  return plan;
}

export async function inspectBundleUserAliasReceipt(value,expected){return structuredClone((await replayBundleUserAliasReceipt(value,expected)).receipt);}

// Main-thread views never include the full source snapshot, receipt, or archive documents.
export function bundleUserAliasPage(plan,offset=0){
  if(!Number.isSafeInteger(offset)||offset<0||offset%24||offset&&offset>=plan.display.length)fail('来源USER地址列表位置已变化');
  return {version:1,sourceDigest:plan.sourceDigest,digest:plan.digest,offset,total:plan.display.length,groups:plan.groups,unresolved:plan.unresolved,
    evidenceChanges:plan.addresses.length,unverified:plan.unverified,changed:plan.changed,ready:plan.ready,rows:structuredClone(plan.display.slice(offset,offset+24))};
}
export function bundleUserAliasSummary(plan,targetsReady=null){
  const {rows,offset,...summary}=bundleUserAliasPage(plan);return {...summary,receiptDigest:plan.receipt?.digest||null,targetsReady};
}
