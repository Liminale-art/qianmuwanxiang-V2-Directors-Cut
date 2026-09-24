// Descriptive style provenance, not an admission receipt or scene-continuity
// proof. A future consumer must verify the accepted job, its source window and
// fresh bindings independently. Never infer this identity from a route/name.
import {assertStoryboardStructureBytes} from './qianmu-storyboard-limits.js';
export const ENSEMBLE_STYLE_ORIGIN_SCHEMA='qianmu.ensemble.style-origin.v1';
const keys=['schema','namespace','chatKey','preparationId','selectionRevision','shotId','schemeId','revision','bindingKey','executionAuthorized'];
const fail=()=>{throw Object.assign(Error('镜组风格来源记录无效'),{code:'ensemble_style_origin',submissionState:'not_submitted'});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
export const isEnsembleShotId=value=>typeof value==='string'&&/^S[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value.slice(1)));

export function normalizeEnsembleStyleOrigin(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key))
    ||value.schema!==ENSEMBLE_STYLE_ORIGIN_SCHEMA||value.executionAuthorized!==false
    ||!text(value.namespace,512)||!/^st-user:\S/.test(value.namespace)||!text(value.chatKey,1024)
    ||!['preparationId','selectionRevision','schemeId','revision'].every(key=>id(value[key]))
    ||!isEnsembleShotId(value.shotId)
    ||typeof value.bindingKey!=='string'||!/^[a-f0-9]{64}$/.test(value.bindingKey))fail();
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,value[key]])));
}

// Called only after the handoff/recovery host has resolved the exact receipt.
// The projection carries no prompt, narrative, API address, key or workflow.
export function ensembleStyleOrigins(receipt,shotIds){
  if(receipt?.executionAuthorized!==false||!Array.isArray(receipt.assignments)||!Array.isArray(shotIds)||!shotIds.length
    ||new Set(shotIds).size!==shotIds.length)fail();
  assertStoryboardStructureBytes([receipt,shotIds],undefined,'镜组风格来源');
  const assignments=new Map();
  for(const row of receipt.assignments){const key=row?.shotId;assignments.set(key,assignments.has(key)?null:row);}
  return Object.freeze(shotIds.map(shotId=>{
    const row=assignments.get(shotId);if(!row)fail();
    return normalizeEnsembleStyleOrigin({schema:ENSEMBLE_STYLE_ORIGIN_SCHEMA,namespace:receipt.namespace,chatKey:receipt.chatKey,
      preparationId:receipt.preparationId,selectionRevision:receipt.selectionRevision,shotId,schemeId:row.schemeId,revision:row.revision,
      bindingKey:row.bindingKey,executionAuthorized:false});
  }));
}

// Preserve malformed/future data as explicitly invalid, not plausible partial
// provenance. Keep this contract bounded separately from generic snapshot data.
export function retainEnsembleStyleOrigin(value){
  try{return normalizeEnsembleStyleOrigin(value);}
  catch{return Object.freeze({schema:ENSEMBLE_STYLE_ORIGIN_SCHEMA,invalid:true,executionAuthorized:false});}
}
