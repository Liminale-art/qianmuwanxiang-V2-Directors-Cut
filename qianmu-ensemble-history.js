// Cross-floor descriptive style anchors, confined to the compiler's borrowed
// source window. No model/storage/admission call and no whole-chat lookup.
import {hasStoryboardStreamReference,normalizeStoryboardStreamReference,verifyStoryboardStreamReference,storyboardStreamBudgetReference} from './qianmu-storyboard-stream-reference.js?v=1.59.278';
import {verifyStoryboardOrdinaryContinuation} from './qianmu-storyboard-ordinary-continuation.js?v=1.59.278';
import {readStoryboardOrdinaryMoment,assertStoryboardOrdinaryMomentSpec} from './qianmu-storyboard-ordinary-moment.js?v=1.59.278';
import {assertStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
import {captureEnsembleSceneAnchor} from './qianmu-ensemble-continuation.js';
import {storyboardHistoryOccupiesImageSlot} from './qianmu-storyboard-stream-coverage.js?v=1.59.278';
const histories=new WeakMap();
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=()=>{throw Object.assign(Error('所选楼层的镜组历史来源无法完整核对'),{code:'ensemble_history_source',submissionState:'not_submitted'});};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export async function captureEnsembleWindowHistory(window,rows,{namespace,resolve}={}){
  window.assertCurrent();
  if(histories.has(window)||!Array.isArray(rows)||rows.length>2000||typeof resolve!=='function')fail();
  const sources=window.sources.filter(source=>source.messageRef.lastKnownFloor<window.floor),floors=new Set(sources.map(source=>source.messageRef.lastKnownFloor));
  const keys=new Set(sources.map(source=>source.messageRef.messageKey)),byFloor=new Map(sources.map(source=>[source.messageRef.lastKnownFloor,source]));
  const selected=[],signatures=new Set(),counts=new Map();let guarded=false;
  for(const row of rows){
    const job=row?.snapshot||row,ref=job?.messageRef||row?.messageRef,admission=job?.imageAdmission||row?.imageAdmission;
    if(!job||!Object.hasOwn(job,'ensembleStyleOrigin')||!storyboardHistoryOccupiesImageSlot(row)||ref?.chatKey!==window.current.messageRef.chatKey
      ||admission?.namespace!==namespace||admission?.automaticSlot===false||job.automatic===false&&admission?.automaticSlot!==true
      ||!keys.has(ref.messageKey)&&!floors.has(ref.lastKnownFloor))continue;
    if(!guarded){await window.guard();guarded=true;}window.assertCurrent();
    const sourceState=resolve(ref),source=byFloor.get(sourceState?.floor);
    if(!source||sourceState.state!=='active')continue;
    if(sources.filter(item=>item.messageRef.messageKey===source.messageRef.messageKey).length!==1)fail();
    const stream=hasStoryboardStreamReference(ref),root=stream?storyboardStreamBudgetReference(ref,namespace):ref;
    if(!stream&&!sourceState.ordinaryContinuation&&(sourceState.current?.messageKey!==ref.messageKey||sourceState.current?.revisionId!==ref.revisionId))continue;
    if(admission?.version!==1||admission.automaticSlot!==true||admission.chatKey!==root.chatKey||admission.messageKey!==root.messageKey
      ||admission.revisionId!==root.revisionId||!hash(admission.logicalShotId)||!admission.attemptId)fail();
    if(stream)await verifyStoryboardStreamReference(ref,()=>resolve(ref));
    else if(sourceState.ordinaryContinuation)await verifyStoryboardOrdinaryContinuation(ref,()=>resolve(ref),{namespace,required:true});
    window.assertCurrent();const after=resolve(ref);
    if(after?.state!=='active'||after.floor!==sourceState.floor||after.message!==sourceState.message)fail();
    const oldWindow={current:source},moment=stream?assertStoryboardStreamMoment(normalizeStoryboardStreamReference(ref).moment,oldWindow):readStoryboardOrdinaryMoment(job,oldWindow);
    if(!moment)fail();assertStoryboardOrdinaryMomentSpec(moment,job.shotSpec);
    const anchor=captureEnsembleSceneAnchor(job,moment);if(!anchor||anchor.invalid)fail();
    const owner=source.messageRef;
    const entry={id:JSON.stringify([owner.lastKnownFloor,admission.logicalShotId]),source:{floor:owner.lastKnownFloor,messageKey:owner.messageKey,revisionId:owner.revisionId},anchor};
    const signature=JSON.stringify(entry);if(signatures.has(signature))continue;
    signatures.add(signature);selected.push(entry);const n=(counts.get(owner.lastKnownFloor)||0)+1;counts.set(owner.lastKnownFloor,n);
    if(n>8||selected.length>160)fail();
  }
  if(guarded)await window.guard();window.assertCurrent();
  const result=freeze({namespace,rows:selected});histories.set(window,result);return result.rows.length;
}

export function readEnsembleWindowHistory(window){window.assertCurrent();return histories.get(window)||null;}
