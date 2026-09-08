import {replayBundleUserAliasReceipt} from './qianmu-bundle-user-alias.js';
import {inspectStoryboardSubjectEvidence} from './qianmu-storyboard-subject-evidence.js';
import {subjectMapKey,normalizeStoryboardSubjectMappings,mappedStoryboardSubjectTargets,deriveStoryboardBindingRows,compareMappedStoryboardSubjects} from './qianmu-storyboard-subject-map.js';
import {characterBackupBindingKey} from './qianmu-character-library-backup.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
export const BUNDLE_SUBJECT_MAP_SCHEMA='qianmu.storyboard.subject-map.v3';
export const BUNDLE_SUBJECT_MAP_SCOPE='bundle-user-alias-resolution';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_bundle_subject_map',submissionState:'not_submitted'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

export function bundleAliasTargetsReady(plan,targetEvidence,mappings){
  const targets=new Map(targetEvidence.subjects.map(row=>[subjectMapKey(row),row]));
  const sources=new Set(plan.writes.map(subjectMapKey)),desired=mappedStoryboardSubjectTargets(plan.writes,mappings.filter(row=>sources.has(subjectMapKey({category:row.category,subjectKey:row.sourceKey}))));
  return desired.every(row=>targets.get(subjectMapKey(row))?.state==='present');
}

async function materialize({namespace,chatHash,sourceDigest,environmentDigest=null,projection,targetEvidence,mappings}){
  if(!hash(chatHash)||!hash(sourceDigest)||environmentDigest!==null&&!hash(environmentDigest))fail('来源组合映射缺少环境范围');
  const plan=await replayBundleUserAliasReceipt(projection,{namespace,sourceDigest}),target=await inspectStoryboardSubjectEvidence(targetEvidence);
  const selected=normalizeStoryboardSubjectMappings(mappings,plan.evidence.subjects),mapped=await deriveStoryboardBindingRows(plan.after,selected,sourceDigest);
  const compared=await compareMappedStoryboardSubjects(plan.evidence,target,[],selected);
  if(!compared.ready||!bundleAliasTargetsReady(plan,target,selected))fail('来源地址整理后的目标未完整载入，请先在ST核对');
  const core={schema:BUNDLE_SUBJECT_MAP_SCHEMA,scope:BUNDLE_SUBJECT_MAP_SCOPE,namespace,chatHash,sourceDigest,environmentDigest,projection:plan.receipt,targetEvidence:target,mappings:selected,bindingsDigest:await digest(mapped.bindings)};
  const review={...core,digest:await digest(core)};if(new TextEncoder().encode(JSON.stringify(review)).length>8*1048576)fail('来源及目标组合凭据超过8MiB，原关系未截断');
  return {review,plan,mapped};
}
export async function createBundleSubjectMapReview(input){return (await materialize(input)).review;}
async function verified(value){
  if(!exact(value,['schema','scope','namespace','chatHash','sourceDigest','environmentDigest','projection','targetEvidence','mappings','bindingsDigest','digest'])||value.schema!==BUNDLE_SUBJECT_MAP_SCHEMA||value.scope!==BUNDLE_SUBJECT_MAP_SCOPE||!hash(value.digest)||!hash(value.bindingsDigest))fail('来源组合映射凭据格式无效');
  const result=await materialize(value);if(await digest(result.review)!==await digest(value))fail('来源组合映射与原包或最终绑定不符');return result;
}
export async function inspectBundleSubjectMapReview(value){return structuredClone((await verified(value)).review);}

// Reconstruct the complete original -> canonical -> selected-target chain in the Worker only.
export async function bundleSubjectMapDetailRows(input,offset=0){
  const {review,plan,mapped}=await verified(input);
  const canonical=new Map(plan.lineage.map(pair=>[characterBackupBindingKey(pair.source),pair.target]));
  const final=new Map(mapped.lineage.map(pair=>[characterBackupBindingKey(pair.source),pair.target]));
  const sources=new Map(plan.sourceEvidence.subjects.map(row=>[subjectMapKey(row),row])),targets=new Map(review.targetEvidence.subjects.map(row=>[subjectMapKey(row),row]));
  return plan.before.slice(offset,offset+24).map(source=>{
    const middle=canonical.get(characterBackupBindingKey(source))||source,target=final.get(characterBackupBindingKey(middle))||middle;
    const from=sources.get(subjectMapKey(source)),to=targets.get(subjectMapKey(target));
    return {source,canonical:middle,target,sourceState:from.state,sourceHash:from.sha256,targetState:to.state,targetHash:to.sha256};
  });
}
