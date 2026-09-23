import {captureComfySceneAction,changeComfySceneRecord,comfySceneLockError} from './qianmu-comfy-scene-lock.js';
import {sameComfySceneSnapshot as same} from './qianmu-comfy-scene-backup.js';

const fail=message=>{throw comfySceneLockError('branch_result',message);};
export function captureComfyBranchResult(action,scope){
  if(!action||Object.keys(action).length!==3||!Object.hasOwn(action,'type')||!Object.hasOwn(action,'operation')||!Object.hasOwn(action,'heads')||action.type!=='branch_result'
    ||!Array.isArray(action.heads)||!action.heads.length||action.heads.length>256||new Set(action.heads).size!==action.heads.length||action.heads.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))
    ||!['settle','confirm_result'].includes(action.operation?.type))fail('分支仅可接收原任务结果，不得预留、提交或选择风格');
  const operation=captureComfySceneAction(action.operation,scope);if(!same(operation,action.operation))fail('分支结果字段不完整');
  return {type:'branch_result',operation,heads:[...action.heads]};
}
export function changeComfyBranchResult(before,scope,action,at){
  const captured=captureComfyBranchResult(action,scope);
  return changeComfySceneRecord(before,scope,captured.operation,at);
}
