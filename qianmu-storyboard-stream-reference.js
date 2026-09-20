// Persist only a bounded source proof, never a second copy of private prose.
// The cheap fingerprint is for synchronous UI linking. Paid dispatch verifies
// both SHA-256 proofs again against the actual selected ST message.
import {normalizeStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
import {storyboardContinuationPath} from './qianmu-storyboard-continuation-proof.js?v=1.59.230';
const fail=()=>{throw Object.assign(new Error('流式原文或回复身份已变化，未继续提交'),{code:'storyboard_stream_source'});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields=['sentAt','startedAt','id','activeSentAt','activeId'];
const scalar=value=>value instanceof Date?value.toISOString():String(value??'');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function normalizeStoryboardStreamFinalCapture(value){
  if(!plain(value)||value.version!==1||typeof value.sourceRevisionId!=='string'||!value.sourceRevisionId||value.sourceRevisionId.length>160
    ||typeof value.requestId!=='string'||!value.requestId||value.requestId.length>160
    ||!['preparing','complete','failed','cancelled'].includes(value.status)||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<1)return {version:1,invalid:true};
  return {version:1,sourceRevisionId:value.sourceRevisionId,requestId:value.requestId,status:value.status,updatedAt:value.updatedAt};
}
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
// A completed paragraph may lose only its trailing whitespace at host finish.
// If more content follows, it must remain a separate paragraph, not a newly
// joined continuation of the sentence whose visual meaning was already used.
export function storyboardStreamParagraphBoundary(text,length){
  if(typeof text!=='string'||!Number.isSafeInteger(length)||length<1||text.length<length)return false;
  const tail=text.slice(length);
  return /^\s*$/.test(tail)||/^[^\S\r\n]*\r?\n[^\S\r\n]*\r?\n/.test(tail);
}
export function normalizeStoryboardStreamReference(ref){
  const proof=ref?.stream,g=proof?.generation;
  if(!plain(proof)||proof.version!==1||!plain(g)||Object.keys(g).length!==fields.length
    ||fields.some(key=>typeof g[key]!=='string'||g[key].length>160||/[\u0000-\u001f\u007f]/.test(g[key]))
    ||!(g.startedAt||g.id||g.activeId)||!hex(proof.generationKey)||!hex(proof.prefixDigest)
    ||!Number.isSafeInteger(proof.prefixLength)||proof.prefixLength<1||proof.prefixLength>200000
    ||!/^[a-f0-9]{8}$/.test(proof.prefixHash||'')||ref.revisionHash!==proof.prefixHash
    ||ref.revisionId!==`stream:${proof.generationKey}`||!ref.chatKey||!ref.messageKey
    ||ref.role!=='assistant'||!(ref.baseSendDate||ref.baseGenerationId)
    ||!Number.isSafeInteger(ref.swipeId)||ref.swipeId<0||ref.swipeId>10000
    ||Object.hasOwn(proof,'complete')&&proof.complete!==true
    ||Object.hasOwn(proof,'closedParagraph')&&(proof.closedParagraph!==true||Object.hasOwn(proof,'complete'))
    ||Object.hasOwn(proof,'moment')&&!normalizeStoryboardStreamMoment(proof.moment))return {version:1,invalid:true};
  return {version:1,generation:Object.fromEntries(fields.map(key=>[key,g[key]])),generationKey:proof.generationKey,
    prefixLength:proof.prefixLength,prefixHash:proof.prefixHash,prefixDigest:proof.prefixDigest,
    ...(proof.complete===true?{complete:true}:{}),
    ...(proof.closedParagraph===true?{closedParagraph:true}:{}),
    ...(Object.hasOwn(proof,'moment')?{moment:normalizeStoryboardStreamMoment(proof.moment)}:{})};
}

export function resolveStoryboardStreamReference(reference,messages,createReference,options={}){
  const proof=normalizeStoryboardStreamReference(reference);
  const empty=state=>({state,floor:null,message:null,reference,relocated:false});
  if(proof.invalid)return empty('stale');
  let path=[];
  try{if(options.continuationLinks!==undefined)path=storyboardContinuationPath(reference,options.continuationLinks,{namespace:options.namespace});}catch{return empty('stale');}
  const keys=new Set([reference.messageKey,...path.map(link=>link.to.messageKey)]);
  const metadata=(message,floor)=>createReference({message:{mes:'',name:message.name,is_user:message.is_user,is_system:message.is_system,
    send_date:message.send_date,gen_started:message.gen_started,extra:message.extra,swipe_id:message.swipe_id,swipe_info:message.swipe_info},
    chatKey:reference.chatKey,floor,now:reference.updatedAt||1});
  const same=(message,floor)=>plain(message)&&keys.has(metadata(message,floor).messageKey);
  let floor=reference.lastKnownFloor;
  if(!Number.isInteger(floor)||!same(messages[floor],floor)){
    const candidates=[];for(let i=0;i<messages.length;i++)if(same(messages[i],i)){candidates.push(i);if(candidates.length>1)break;}
    if(candidates.length!==1)return empty(candidates.length?'stale':'orphaned');floor=candidates[0];
  }
  const message=messages[floor],meta=metadata(message,floor),generation=JSON.stringify(storyboardStreamGeneration(message));let state='active',bridges=[];
  if(generation!==JSON.stringify(proof.generation)||meta.messageKey!==reference.messageKey){
    const end=path.findIndex(link=>link.to.messageKey===meta.messageKey&&link.to.swipeId===meta.swipeId&&JSON.stringify(link.to.generation)===generation);
    if(end>=0)bridges=path.slice(0,end+1);
  }
  if(meta.swipeId!==reference.swipeId)state='inactive_swipe';
  else if(!bridges.length&&(generation!==JSON.stringify(proof.generation)||meta.messageKey!==reference.messageKey)
    ||typeof message.mes!=='string'||message.mes.length<proof.prefixLength
    ||proof.complete===true&&!bridges.length&&message.mes.length!==proof.prefixLength
    ||proof.closedParagraph===true&&!storyboardStreamParagraphBoundary(message.mes,proof.prefixLength)
    ||storyboardStreamFingerprint(message.mes.slice(0,proof.prefixLength))!==proof.prefixHash
    ||bridges.some(link=>message.mes.length<link.length||storyboardStreamFingerprint(message.mes.slice(0,link.length))!==link.hash))state='stale';
  return {state,floor,message,reference,current:{...reference,lastKnownFloor:floor},relocated:floor!==reference.lastKnownFloor,
    ...(bridges.length?{continuations:bridges}:{})};
}

export async function verifyStoryboardStreamReference(ref,resolve){
  if(!hasStoryboardStreamReference(ref))return true;
  const proof=normalizeStoryboardStreamReference(ref);if(proof.invalid||typeof resolve!=='function')fail();
  const before=resolve();if(before?.state!=='active'||typeof before.message?.mes!=='string')fail();
  const prefix=before.message.mes.slice(0,proof.prefixLength);
  const bridges=(before.continuations||[]).map(link=>({link,prefix:before.message.mes.slice(0,link.length)}));
  if(prefix.length!==proof.prefixLength||await storyboardStreamDigest(prefix)!==proof.prefixDigest
    ||await storyboardStreamDigest(storyboardStreamGenerationInput(ref,proof.generation))!==proof.generationKey)fail();
  for(const {link,prefix} of bridges){
    if(await storyboardStreamDigest(prefix)!==link.digest
      ||await storyboardStreamDigest(JSON.stringify([link.namespace,link.chatKey,link.from,link.to,link.digest]))!==link.id)fail();
  }
  const after=resolve();
  if(after?.state!=='active'||after.message!==before.message||after.floor!==before.floor||after.message.mes.slice(0,proof.prefixLength)!==prefix
    ||JSON.stringify(after.continuations||[])!==JSON.stringify(before.continuations||[])
    ||bridges.some(({link,prefix})=>after.message.mes.slice(0,link.length)!==prefix))fail();
  return true;
}
