// Old ordinary jobs retain their original revision and budget. A saved v2
// continue bridge may prove that exact completed revision remains a prefix;
// similar prose, matching names and a reused floor are never sufficient.
import {normalizeStoryboardContinuationLinks,storyboardContinuationPath,storyboardContinuationSourceMatches,storyboardContinuationIdentityInput} from './qianmu-storyboard-continuation-proof.js?v=1.59.347';
import {storyboardStreamGeneration,storyboardStreamFingerprint,storyboardStreamDigest} from './qianmu-storyboard-source-proof.js?v=1.59.347';
const fail=()=>{throw Object.assign(new Error('续写前的原正文无法完整核对，未继续提交'),{code:'storyboard_ordinary_continuation'});};

export function resolveStoryboardOrdinaryContinuation(reference,messages,createReference,{continuationLinks,namespace}={}){
  if(continuationLinks===undefined)return null;
  const empty=state=>({state,floor:null,message:null,reference,relocated:false,ordinaryContinuation:true});
  let rows;
  try{rows=normalizeStoryboardContinuationLinks(continuationLinks);}catch{return empty('stale');}
  const sources=rows.filter(row=>storyboardContinuationSourceMatches(reference,row));
  if(!sources.length)return null;
  if(sources.length!==1||namespace!==undefined&&sources[0].namespace!==namespace)return empty('stale');
  const source=sources[0];let path;
  try{path=storyboardContinuationPath({...reference,stream:{generation:source.from.generation,prefixLength:source.length}},rows,{namespace:source.namespace});}
  catch{return empty('stale');}
  if(!path.length||path[0].id!==source.id)return empty('stale');
  const keys=new Set([reference.messageKey,...path.map(row=>row.to.messageKey)]);
  const meta=(message,floor)=>createReference({message:{mes:'',name:message.name,is_user:message.is_user,is_system:message.is_system,
    send_date:message.send_date,gen_started:message.gen_started,extra:message.extra,swipe_id:message.swipe_id,swipe_info:message.swipe_info},chatKey:reference.chatKey,floor,now:1});
  const matches=(message,floor)=>message&&typeof message==='object'&&keys.has(meta(message,floor).messageKey);
  let floor=reference.lastKnownFloor;
  if(!Number.isSafeInteger(floor)||!matches(messages[floor],floor)){
    const candidates=[];for(let i=0;i<messages.length;i++)if(matches(messages[i],i)){candidates.push(i);if(candidates.length>1)break;}
    if(candidates.length!==1)return empty(candidates.length?'stale':'orphaned');floor=candidates[0];
  }
  const message=messages[floor],current=meta(message,floor),generation=JSON.stringify(storyboardStreamGeneration(message));
  const located=state=>({state,floor,message,reference,current,relocated:floor!==reference.lastKnownFloor,ordinaryContinuation:true});
  if(current.swipeId!==reference.swipeId)return located('inactive_swipe');
  const end=path.findIndex(row=>row.to.messageKey===current.messageKey&&row.to.swipeId===current.swipeId&&JSON.stringify(row.to.generation)===generation);
  if(end<0)return located('stale');
  const continuations=path.slice(0,end+1),raw=message.mes;
  if(typeof raw!=='string'||continuations.some(row=>raw.length<row.length||storyboardStreamFingerprint(raw.slice(0,row.length))!==row.hash))return located('stale');
  return {state:'active',floor,message,reference,current:createReference({message,chatKey:reference.chatKey,floor,now:reference.updatedAt||1}),
    relocated:floor!==reference.lastKnownFloor,ordinaryContinuation:true,continuations};
}

export async function verifyStoryboardOrdinaryContinuation(reference,resolve,{namespace,required=false}={}){
  if(typeof resolve!=='function'){if(required)fail();return false;}
  const signature=JSON.stringify(reference),before=resolve();
  if(before?.ordinaryContinuation!==true){if(required)fail();return false;}
  if(before.state!=='active'||!before.continuations?.length||typeof before.message?.mes!=='string')fail();
  const links=normalizeStoryboardContinuationLinks(before.continuations);
  if(!storyboardContinuationSourceMatches(reference,links[0])||namespace!==undefined&&links.some(row=>row.namespace!==namespace))fail();
  const captures=links.map(link=>({link,prefix:before.message.mes.slice(0,link.length)}));
  for(const {link,prefix} of captures){
    if(prefix.length!==link.length||await storyboardStreamDigest(prefix)!==link.digest
      ||await storyboardStreamDigest(storyboardContinuationIdentityInput(link))!==link.id)fail();
  }
  const after=resolve();
  if(JSON.stringify(reference)!==signature||after?.state!=='active'||after.ordinaryContinuation!==true||after.message!==before.message||after.floor!==before.floor
    ||JSON.stringify(after.continuations)!==JSON.stringify(before.continuations)
    ||captures.some(({link,prefix})=>after.message.mes.slice(0,link.length)!==prefix))fail();
  return true;
}
