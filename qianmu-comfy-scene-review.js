import {normalizeComfySceneRecord,comfySceneScope,comfySceneScopeKey,comfySceneLockError} from './qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA,validateComfySceneSnapshot,comfySceneSnapshotBytes as bytes,sameComfySceneSnapshot as same} from './qianmu-comfy-scene-backup.js';

const fail=message=>{throw comfySceneLockError('review',message);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function resolveReviewedComfyScene(before,scope,action,at){
  scope=comfySceneScope(scope);
  if(!exact(action,['type','selected','acknowledged'])||action.type!=='resolve'||action.acknowledged!==true||typeof action.selected!=='string'||!/^[a-f0-9]{64}$/.test(action.selected)
    ||!Array.isArray(before)||!before.length||before.length>256)fail('请明确选择本次核对的完整续场来源');
  const seen=new Set();let revision=0,selected;
  for(const branch of before){
    if(!exact(branch,['digest','record'])||typeof branch.digest!=='string'||!/^[a-f0-9]{64}$/.test(branch.digest)||seen.has(branch.digest))fail('续场核对来源重复或不完整');seen.add(branch.digest);
    if(branch.record!==null){const record=branch.record,size=bytes(record);validateComfySceneSnapshot({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace:scope.namespace,usage:{count:1,bytes:size,generation:0},rows:[{key:comfySceneScopeKey(scope),value:{namespace:scope.namespace,chatKey:scope.chatKey,bytes:size,record}}]});
      if(!same(record.scope,scope))fail('续场来源范围不符');
      // Even an expired reservation remains evidence here. A review is not
      // proof that the originating device or provider has stopped working.
      if(record.holders.length)fail('来源仍含原任务票据，请先核查原任务；未选择或解除任何分支');revision=Math.max(revision,record.revision);
    }
    if(branch.digest===action.selected)selected=branch;
  }
  if(!selected||revision===Number.MAX_SAFE_INTEGER)fail('所选续场来源失效或版本已满');
  const row=normalizeComfySceneRecord(selected.record,scope);row.revision=revision+1;row.lockRevision=row.revision;row.updatedAt=at;
  return {row:normalizeComfySceneRecord(row,scope)};
}
