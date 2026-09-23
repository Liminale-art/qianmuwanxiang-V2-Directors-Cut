import {createStoryboardMessageReference} from './qianmu-storyboard.js?v=1.59.352';
import {createStoryboardStreamLineage} from './qianmu-storyboard-stream-lineage.js?v=1.59.352';
import {readStoryboardContinuationLinks,storyboardContinuationSavePending,storyboardContinuationIdentityInput} from './qianmu-storyboard-continuation-proof.js?v=1.59.352';
import {storyboardStreamDigest,storyboardStreamFingerprint,storyboardStreamGeneration} from './qianmu-storyboard-stream-reference.js?v=1.59.352';
const fail=()=>{throw Object.assign(new Error('续写前后的原图归属无法核对，未开始整层重拍'),{code:'storyboard_retake_source'});};

// Only the explicit retake action uses this bounded strong check. It reads one
// target message and compact chat metadata, never scans prose or edits old jobs.
export async function readStoryboardFloorTakeSourceKeys(floor,message,api,namespace,current){
  if(!current())fail();
  const reference=createStoryboardMessageReference({message,chatKey:api.chatKey(),floor}),text=message.mes,metadata=api.metadata?.();
  if(storyboardContinuationSavePending(metadata?.story_director_liminale))fail();
  const generation=JSON.stringify(storyboardStreamGeneration(message));
  const read=()=>createStoryboardStreamLineage(reference,message,readStoryboardContinuationLinks(api.metadata?.()?.story_director_liminale),namespace).links;
  const links=read(),signature=JSON.stringify(links);
  if(!links.length)return [reference.messageKey];
  if(typeof text!=='string'||text.length>200000)fail();
  const check=()=>{
    if(!current()||api.metadata?.()!==metadata||storyboardContinuationSavePending(metadata?.story_director_liminale)
      ||message.mes!==text||JSON.stringify(storyboardStreamGeneration(message))!==generation||JSON.stringify(read())!==signature)fail();
  };
  for(const link of links){
    check();const prefix=text.slice(0,link.length);
    if(prefix.length!==link.length||storyboardStreamFingerprint(prefix)!==link.hash||await storyboardStreamDigest(prefix)!==link.digest)fail();
    check();if(await storyboardStreamDigest(storyboardContinuationIdentityInput(link))!==link.id)fail();check();
  }
  if(namespace!==await api.namespace())fail();check();
  return [...new Set([reference.messageKey,...links.flatMap(row=>[row.from.messageKey,row.to.messageKey])])];
}
