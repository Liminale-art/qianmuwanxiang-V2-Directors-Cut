import {storyboardStreamGeneration,storyboardStreamGenerationInput,storyboardStreamDigest} from './qianmu-storyboard-stream-reference.js?v=1.59.385';
import {createStoryboardStreamCheckpointStorage} from './qianmu-storyboard-stream-checkpoint-storage.js?v=1.59.385';
import {createStoryboardStreamFinalStorage} from './qianmu-storyboard-stream-final-storage.js?v=1.59.385';
const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_stream_checkpoint'});};

// Missing settings/plan/logs are not evidence that this generation never ran.
// Two deterministic, bounded reads immediately before ordinary automatic
// extraction check only this generation; never scan chat prose, list account
// files, warm UI, poll tokens, or restore/replay paid work from a marker.
export async function probeStoryboardStreamRecovery({reference,message,resolveNamespace,guard,createStorage}={}){
  if(typeof guard!=='function'||typeof resolveNamespace!=='function')fail('取景恢复核对环境未就绪');
  const check=()=>{if(guard()!==true)fail('取景来源已变化，未继续恢复核对');return true;};
  check();const generation=storyboardStreamGeneration(message),generationInput=storyboardStreamGenerationInput(reference,generation);
  // A source without these host identities could never have opened a valid
  // streaming frame. Preserve that ordinary legacy path without file traffic.
  if(!(generation.startedAt||generation.id||generation.activeId))return false;
  if(Object.values(generation).some(value=>value.length>160||/[\u0000-\u001f\u007f]/.test(value))||reference?.role!=='assistant'
    ||!Number.isSafeInteger(reference.swipeId)||reference.swipeId<0||reference.swipeId>10000)fail('回复身份不完整，未自动重新取景');
  const namespace=await resolveNamespace();check();
  const key=await storyboardStreamDigest(generationInput);check();
  if(storyboardStreamGenerationInput(reference,storyboardStreamGeneration(message))!==generationInput)fail('回复身份已变化，未继续恢复核对');
  const scope={namespace,chatKey:reference.chatKey,messageKey:reference.messageKey,revisionId:`stream:${key}`,planId:`stream-${key}`};
  let partial,final;
  try{
    partial=await createStoryboardStreamCheckpointStorage({scope,guard:check,...(createStorage?{createStorage}:{})});
    final=await createStoryboardStreamFinalStorage({scope:{...scope,sourceRevisionId:reference.revisionId},guard:check,...(createStorage?{createStorage}:{})});
    const records=await Promise.all([partial.read(),final.read()]);check();
    if(storyboardStreamGenerationInput(reference,storyboardStreamGeneration(message))!==generationInput)fail('回复身份已变化，未继续恢复核对');
    return records.some(Boolean);
  }finally{try{partial?.close();}finally{final?.close();}}
}
