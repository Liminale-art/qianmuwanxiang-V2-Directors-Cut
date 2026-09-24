import {STORYBOARD_PLAN_SCHEMA,normalizeStoryboardSceneFingerprint} from './qianmu-storyboard.js';
import {normalizeStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js';
import {normalizeNarrativeContext} from './qianmu-narrative-context.js';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=Object.freeze(['shotPlans','taskStates','logs','pipelineLogs']);
const fail=field=>{throw Object.assign(new Error(`分镜历史 ${field} 无法完整保留，未静默裁剪正文锚点、镜头顺序或任务记录`),{code:'storyboard_portable_history',submissionState:'not_submitted'});};
const runtimeFields=new Set(['status','stage','error','finishedAt','chatKey','manualReviewRequired','autoGenerate','requiresManualConfirmation','attempt','partialFailureCount']);
// Execution indexes are presentation-derived and may be re-sorted by the state normalizer.
// Creative plans, their shots, and pipeline stages are ordered authorial history and must stay
// positionally identical. Connection/parameter IDs may be cleared when the target has no local
// equivalent; that is an explicit environment migration difference, not creative data loss.
const executionArrays=new Set(['taskStates','logs','pipelineLogs']);
const identityArray=(field,path)=>path.length===0&&executionArrays.has(field);
const orderedArray=(field,path)=>field==='shotPlans'&&((path.length===0)||(path.at(-1)==='shots')) || field==='pipelineLogs'&&path.at(-1)==='stages';
const shotSpecKeys=new Set(['schema','id','sourceParagraphIds','source_paragraph_ids','insertAfter','insert_after','narrativeLayer','narrative_layer','narrativePurpose','narrative_purpose','purpose','shotPattern','shot_pattern','visualDuty','visual_duty','subjectKind','subject_kind','shotRole','shot_role','role','shotScale','shot_scale','shotType','subject','scene','sceneId','scene_id','sceneFingerprint','narrativeMoment','characters','primarySubjectId','characterReferenceDisabled','sharedRelations','shared_relations','composition','promptAtoms','prompt_atoms','promptRenderingPack','sensitive','safetyNotes','safety_notes','evidence','productionContext','production_context','directorDecision','director_decision','continuityUpdates','continuity_updates','decisions']);
// Only canonical fields written by the current shot normalizer are accepted.
// Compare recursively, ignoring object key order but preserving array order;
// malformed types or unknown nested fields must not be normalized away.
function canonicalEqual(left,right){
  if(left===right)return true;
  if(Array.isArray(left))return Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>canonicalEqual(value,right[index]));
  if(!object(left)||!object(right))return false;
  const keys=Object.keys(left);return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&canonicalEqual(left[key],right[key]));
}
function assertCanonicalShotFields(value,path){
  const invalid=key=>fail(`${path.join('.')}.${key} 格式无效`);
  if(Object.hasOwn(value,'schema')&&value.schema!==STORYBOARD_PLAN_SCHEMA)invalid('schema');
  if(Object.hasOwn(value,'sceneFingerprint')){
    const fingerprint=value.sceneFingerprint;
    if(!object(fingerprint)||!canonicalEqual(fingerprint,normalizeStoryboardSceneFingerprint(fingerprint)))invalid('sceneFingerprint');
    if(Object.hasOwn(fingerprint,'narrativeContext')){
      try{if(!canonicalEqual(fingerprint.narrativeContext,normalizeNarrativeContext(fingerprint.narrativeContext)))invalid('sceneFingerprint.narrativeContext');}
      catch{invalid('sceneFingerprint.narrativeContext');}
    }
  }
  if(Object.hasOwn(value,'narrativeMoment')&&(!object(value.narrativeMoment)||!canonicalEqual(value.narrativeMoment,normalizeStoryboardStreamMoment(value.narrativeMoment))))invalid('narrativeMoment');
}
function assertHistoryInput(value,path=[]){
  if(Array.isArray(value)){value.forEach((item,index)=>assertHistoryInput(item,[...path,index]));return;}
  if(!object(value))return;
  if(path.at(-1)==='shotSpec'){
    for(const key of Object.keys(value))if(!shotSpecKeys.has(key))fail(`${path.join('.')} 含未支持字段 ${key}`);
    assertCanonicalShotFields(value,path);
  }
  for(const [key,item] of Object.entries(value))assertHistoryInput(item,[...path,key]);
}
const rowId=value=>typeof value?.id==='string'&&value.id.trim()?value.id:'';

export function captureStoryboardHistoryData(state){
  if(state==null||typeof state!=='object'||Array.isArray(state))fail('目录');
  assertHistoryInput(state);
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(state,key)).map(key=>[key,structuredClone(state[key])]));
}

// Historical execution state is allowed to become cancelled/manual on import. Creative payload,
// order, anchors, output IDs and every source-owned field remain exact.
export function assertStoryboardHistoryRetained(before,after,{importedIds={},targetChatKey=''}={}){
  let nodes=0, mismatch='';
  const allowRuntime=(field,path,key,a,b)=>{
    if((key==='connectionPresetId'||key==='parameterPresetId')&&a && (b===''||b===null))return true;
    if(!runtimeFields.has(key))return false;
    if(key==='chatKey')return Boolean(targetChatKey&&path.includes('messageRef')) || Boolean(targetChatKey&&path.length===2);
    if(key==='status')return ['idle','screening','compiling','prompt_ready','queued','generating','running','ready','draft'].includes(a)&&['cancelled','failed','completed','queued','generating','running'].includes(b);
    if(key==='stage')return a==='queue'||a==='provider'||a==='compiler'||a==='screening'||a==='persistence'||a==='attachment'||a==='cancelled' || b==='cancelled';
    if(key==='error'||key==='finishedAt')return true;
    if(key==='manualReviewRequired'||key==='requiresManualConfirmation')return b===true||a===b;
    if(key==='autoGenerate')return a===true&&b===false;
    if(key==='attempt'||key==='partialFailureCount')return Number(b)>=Number(a);
    return false;
  };
  function same(a,b,field,path=[]){
    if(++nodes>500000||path.length>40)fail(field);
    if(a===b)return true;
    const key=typeof path.at(-1)==='string'?path.at(-1):'';
    if(allowRuntime(field,path,key,a,b))return true;
    if(Array.isArray(a)){
      if(!Array.isArray(b)){mismatch=path.join('.');return false;}
      const keyed=identityArray(field,path);
      if(keyed){
        const left=new Map(a.map(row=>[rowId(row),row])),right=new Map(b.map(row=>[rowId(row),row]));
        if(left.size!==a.length||right.size!==b.length||a.length!==b.length){mismatch=path.join('.');return false;}
        return a.every(row=>left.has(rowId(row))&&right.has(rowId(row))&&same(row,right.get(rowId(row)),field,[...path,rowId(row)]));
      }
      if(orderedArray(field,path)){
        return a.length===b.length&&a.every((row,i)=>same(row,b[i],field,[...path,i]));
      }
      return a.length===b.length&&a.every((row,i)=>same(row,b[i],field,[...path,i]));
    }
    if(object(a)){
      if(!object(b)){mismatch=path.join('.');return false;}
      for(const name of Object.keys(a)){if(!Object.hasOwn(b,name)){mismatch=[...path,name].join('.');return false;}if(!same(a[name],b[name],field,[...path,name]))return false;}
      return true;
    }
    mismatch=path.join('.');return false;
  }
  for(const field of fields)if(Object.hasOwn(before,field)){
    const source=before[field],target=after?.[field];
    if(!Array.isArray(source)||!Array.isArray(target))fail(field);
    const expectedIds=new Set((importedIds[field]||source.map(row=>rowId(row))).filter(Boolean));
    const targetRows=new Map(target.map(row=>[rowId(row),row]));
    for(const row of source){const id=rowId(row);if(!id||!expectedIds.has(id)||!targetRows.has(id)||!same(row,targetRows.get(id),field,[id]))fail(mismatch?`${field}（${mismatch}）`:field);}
  }
  return true;
}

export const STORYBOARD_HISTORY_FIELDS=fields;
