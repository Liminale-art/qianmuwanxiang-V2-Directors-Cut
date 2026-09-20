// Persist only a bounded source proof, never a second copy of private prose.
// The cheap fingerprint is for synchronous UI linking. Paid dispatch verifies
// both SHA-256 proofs again against the actual selected ST message.
const fail=()=>{throw Object.assign(new Error('流式原文或回复身份已变化，未继续提交'),{code:'storyboard_stream_source'});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields=['sentAt','startedAt','id','activeSentAt','activeId'];
const scalar=value=>value instanceof Date?value.toISOString():String(value??'');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const hasStoryboardStreamReference=ref=>plain(ref)&&(Object.hasOwn(ref,'stream')||String(ref.revisionId||'').startsWith('stream:'));
export function storyboardStreamGeneration(message){
  const active=message.swipe_info?.[message.swipe_id||0]||{};
  return {sentAt:scalar(message.send_date),startedAt:scalar(message.gen_started),id:scalar(message.extra?.gen_id),
    activeSentAt:scalar(active.send_date),activeId:scalar(active.extra?.gen_id)};
}
export function storyboardStreamFingerprint(text){let h=2166136261;for(const ch of text){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return(h>>>0).toString(16).padStart(8,'0');}
export async function storyboardStreamDigest(text){
  if(!globalThis.crypto?.subtle)fail();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export const storyboardStreamGenerationInput=(ref,generation)=>JSON.stringify([ref.chatKey,ref.messageKey,ref.swipeId,generation]);
export function normalizeStoryboardStreamReference(ref){
  const proof=ref?.stream,g=proof?.generation;
  if(!plain(proof)||proof.version!==1||!plain(g)||Object.keys(g).length!==fields.length
    ||fields.some(key=>typeof g[key]!=='string'||g[key].length>160||/[\u0000-\u001f\u007f]/.test(g[key]))
    ||!(g.startedAt||g.id||g.activeId)||!hex(proof.generationKey)||!hex(proof.prefixDigest)
    ||!Number.isSafeInteger(proof.prefixLength)||proof.prefixLength<1||proof.prefixLength>200000
    ||!/^[a-f0-9]{8}$/.test(proof.prefixHash||'')||ref.revisionHash!==proof.prefixHash
    ||ref.revisionId!==`stream:${proof.generationKey}`||!ref.chatKey||!ref.messageKey
    ||ref.role!=='assistant'||!(ref.baseSendDate||ref.baseGenerationId)
    ||!Number.isSafeInteger(ref.swipeId)||ref.swipeId<0||ref.swipeId>10000)return {version:1,invalid:true};
  return {version:1,generation:Object.fromEntries(fields.map(key=>[key,g[key]])),generationKey:proof.generationKey,
    prefixLength:proof.prefixLength,prefixHash:proof.prefixHash,prefixDigest:proof.prefixDigest};
}

export function resolveStoryboardStreamReference(reference,messages,createReference){
  const proof=normalizeStoryboardStreamReference(reference);
  const empty=state=>({state,floor:null,message:null,reference,relocated:false});
  if(proof.invalid)return empty('stale');
  const metadata=(message,floor)=>createReference({message:{mes:'',name:message.name,is_user:message.is_user,is_system:message.is_system,
    send_date:message.send_date,gen_started:message.gen_started,extra:message.extra,swipe_id:message.swipe_id,swipe_info:message.swipe_info},
    chatKey:reference.chatKey,floor,now:reference.updatedAt||1});
  const same=(message,floor)=>plain(message)&&metadata(message,floor).messageKey===reference.messageKey;
  let floor=reference.lastKnownFloor;
  if(!Number.isInteger(floor)||!same(messages[floor],floor)){
    const candidates=[];for(let i=0;i<messages.length;i++)if(same(messages[i],i)){candidates.push(i);if(candidates.length>1)break;}
    if(candidates.length!==1)return empty(candidates.length?'stale':'orphaned');floor=candidates[0];
  }
  const message=messages[floor],meta=metadata(message,floor);let state='active';
  if(meta.swipeId!==reference.swipeId)state='inactive_swipe';
  else if(JSON.stringify(storyboardStreamGeneration(message))!==JSON.stringify(proof.generation)
    ||typeof message.mes!=='string'||message.mes.length<proof.prefixLength
    ||storyboardStreamFingerprint(message.mes.slice(0,proof.prefixLength))!==proof.prefixHash)state='stale';
  return {state,floor,message,reference,current:{...reference,lastKnownFloor:floor},relocated:floor!==reference.lastKnownFloor};
}

export async function verifyStoryboardStreamReference(ref,resolve){
  if(!hasStoryboardStreamReference(ref))return true;
  const proof=normalizeStoryboardStreamReference(ref);if(proof.invalid||typeof resolve!=='function')fail();
  const before=resolve();if(before?.state!=='active'||typeof before.message?.mes!=='string')fail();
  const prefix=before.message.mes.slice(0,proof.prefixLength);
  if(prefix.length!==proof.prefixLength||await storyboardStreamDigest(prefix)!==proof.prefixDigest
    ||await storyboardStreamDigest(storyboardStreamGenerationInput(ref,proof.generation))!==proof.generationKey)fail();
  const after=resolve();
  if(after?.state!=='active'||after.message!==before.message||after.floor!==before.floor||after.message.mes.slice(0,proof.prefixLength)!==prefix)fail();
  return true;
}
