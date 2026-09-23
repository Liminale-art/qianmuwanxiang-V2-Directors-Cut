// Read-only navigation to an existing log. This is not an archive proof,
// provider query, execution receipt or authority to release a scene holder.
import {comfySceneScope,comfySceneLockError} from './qianmu-comfy-scene-lock.js';
import {normalizeComfySceneLock} from './qianmu-comfy-selection.js';
import {normalizeComfySceneOrigin} from './qianmu-comfy-route-contract.js';
import {sameComfySceneSnapshot as same} from './qianmu-comfy-scene-backup.js';

const fail=message=>{throw comfySceneLockError('task_navigation',message);};
function capture(request,namespace,chatKey){
  const scope=comfySceneScope(request?.scope),lock=normalizeComfySceneLock(request?.lock,namespace),attemptId=request?.attemptId;
  if(scope.namespace!==namespace||scope.chatKey!==chatKey||!same(scope,lock.scope)||!same(scope,request.scope)||!same(lock,request.lock)
    ||typeof attemptId!=='string'||!attemptId||attemptId.length>160||/[\u0000-\u001f\u007f]/.test(attemptId))fail('原任务不属于当前账户、聊天或风格来源');
  return {scope,lock,attemptId};
}
function matchingLog(log,target){
  const snapshot=log?.snapshot,admission=snapshot?.imageAdmission;
  if(log?.source!=='comfy'||snapshot?.source!=='comfy'||snapshot.originalOnly||snapshot.chatKey!==target.scope.chatKey
    ||admission?.version!==1||admission.namespace!==target.scope.namespace||admission.attemptId!==target.attemptId
    ||typeof log.id!=='string'||!log.id)return false;
  try{const origin=normalizeComfySceneOrigin(snapshot.comfySceneOrigin);
    return origin.mode==='scene'&&same(origin.scope,target.scope)&&origin.poolKey===target.lock.poolKey
      &&origin.candidateId===target.lock.candidateId&&origin.executionKey===target.lock.executionKey;
  }catch{return false;}
}
function select(logs,target){
  if(!Array.isArray(logs))fail('当前日志尚未就绪，请稍后重试');
  const matches=logs.filter(log=>matchingLog(log,target));
  if(!matches.length)fail('未找到准确原日志，可能尚未加载或已清理。请在 Comfy 收片管理核查原任务；续场保护保持不变');
  if(matches.length!==1||logs.filter(log=>log?.id===matches[0].id).length!==1)fail('原任务对应多份日志，请在分镜日志核对；未自动选择');
  return matches[0];
}
const binding=log=>JSON.stringify([log.id,log.source,log.snapshot?.source,log.snapshot?.chatKey,log.snapshot?.originalOnly,log.snapshot?.imageAdmission,log.snapshot?.comfySceneOrigin]);
export async function navigateComfySceneTask(request,{namespace,chatKey,getLogs,guard,present}){
  const target=capture(request,namespace,chatKey),check=async()=>{if(await guard()===false)fail('续场页面已切换');};
  await check();const log=select(getLogs(),target),before=binding(log);
  await check();if(select(getLogs(),target)!==log||binding(log)!==before)fail('原日志在定位期间变化，请重新核对');
  // The host synchronously opens its existing log page; it must not retrieve,
  // retry, load a generation configuration or mutate task state here.
  present(log.id);return {logId:log.id};
}
