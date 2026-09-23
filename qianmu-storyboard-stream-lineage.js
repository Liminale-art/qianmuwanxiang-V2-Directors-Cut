import {normalizeStoryboardContinuationLinks,storyboardContinuationSignature as signature,storyboardContinuationSourceMatches} from './qianmu-storyboard-continuation-proof.js?v=1.59.358';
import {hasStoryboardStreamReference,normalizeStoryboardStreamReference,storyboardStreamGeneration} from './qianmu-storyboard-stream-reference.js?v=1.59.358';
const fail=()=>{throw Object.assign(new Error('续写任务的原始归属无法唯一核对，未新增自动生成'),{code:'storyboard_stream_lineage'});};

// A bounded metadata-only candidate index. This is deliberately not source or
// paid-generation authority: every selected reference must still be verified.
export function createStoryboardStreamLineage(current,message,links,namespace){
  const rows=links===undefined?[]:normalizeStoryboardContinuationLinks(links);
  let endpoint={messageKey:current.messageKey,swipeId:current.swipeId,generation:storyboardStreamGeneration(message)};
  const endpoints=new Set([signature(endpoint)]),keys=new Set([current.messageKey]),path=[];let following=null,count=0;
  while(true){
    const incoming=rows.filter(row=>row.chatKey===current.chatKey&&row.name===current.name&&signature(row.to)===signature(endpoint));
    const matches=incoming.filter(row=>namespace===undefined||row.namespace===namespace);
    if(incoming.length&&!matches.length)fail();
    if(!matches.length)break;
    if(matches.length!==1||count++===32)fail();
    const row=matches[0];namespace??=row.namespace;
    if(following&&row.length>following.length||endpoints.has(signature(row.from)))fail();
    endpoint=row.from;following=row;path.push(row);endpoints.add(signature(endpoint));keys.add(endpoint.messageKey);
  }
  return Object.freeze({namespace,links:Object.freeze(path.reverse()),matchesOrdinary:ref=>path.some(row=>storyboardContinuationSourceMatches(ref,row)),matches(ref){
    if(!hasStoryboardStreamReference(ref)||ref.chatKey!==current.chatKey||ref.name!==current.name||ref.role!=='assistant'||!keys.has(ref.messageKey))return false;
    const proof=normalizeStoryboardStreamReference(ref);if(proof.invalid)fail();
    return endpoints.has(signature({messageKey:ref.messageKey,swipeId:ref.swipeId,generation:proof.generation}));
  }});
}
