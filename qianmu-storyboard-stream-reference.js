// Persist only a bounded source proof, never a second copy of private prose.
// The cheap fingerprint is for synchronous UI linking. Paid dispatch verifies
// both SHA-256 proofs again against the actual selected ST message.
import {normalizeStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
import {storyboardContinuationPath,storyboardContinuationIdentityInput,storyboardContinuationSource} from './qianmu-storyboard-continuation-proof.js?v=1.59.265';
import {storyboardStreamGeneration,storyboardStreamFingerprint,storyboardStreamDigest} from './qianmu-storyboard-source-proof.js?v=1.59.265';
import {resolveStoryboardOrdinaryContinuation,verifyStoryboardOrdinaryContinuation} from './qianmu-storyboard-ordinary-continuation.js?v=1.59.265';
export {storyboardStreamGeneration,storyboardStreamFingerprint,storyboardStreamDigest};
const fail=()=>{throw Object.assign(new Error('流式原文或回复身份已变化，未继续提交'),{code:'storyboard_stream_source'});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields=['sentAt','startedAt','id','activeSentAt','activeId'];
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function normalizeStoryboardStreamFinalCapture(value){
  if(!plain(value)||value.version!==1||typeof value.sourceRevisionId!=='string'||!value.sourceRevisionId||value.sourceRevisionId.length>160
    ||typeof value.requestId!=='string'||!value.requestId||value.requestId.length>160
    ||!['preparing','complete','failed','cancelled'].includes(value.status)||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<1)return {version:1,invalid:true};
  return {version:1,sourceRevisionId:value.sourceRevisionId,requestId:value.requestId,status:value.status,updatedAt:value.updatedAt};
}
export const hasStoryboardStreamReference=ref=>plain(ref)&&(Object.hasOwn(ref,'stream')||String(ref.revisionId||'').startsWith('stream:'));
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
  if(!plain(proof)||![1,2,3].includes(proof.version)||!plain(g)||Object.keys(g).length!==fields.length
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
  let family;
  if(proof.version===1&&Object.hasOwn(proof,'family'))return {version:1,invalid:true};
  if(proof.version===2||proof.version===3){
    const value=proof.family,root=value?.reference;
    const ordinary=proof.version===3;
    if(!plain(value)||value.version!==(ordinary?2:1)||typeof value.namespace!=='string'||!/^st-user:.+/.test(value.namespace)||!value.namespace.slice(8).trim()
      ||value.namespace.length>512||/[\u0000-\u001f\u007f]/.test(value.namespace)
      ||!plain(root)||root.version!==1||(!ordinary&&root.stream?.version!==1)
      ||!['chatKey','messageKey','name','baseSendDate','baseGenerationId','revisionHash','revisionId'].every(key=>typeof root[key]==='string'&&root[key].length<=(key==='chatKey'?512:160))
      ||!['createdAt','updatedAt'].every(key=>Number.isSafeInteger(root[key])&&root[key]>=0)
      ||root.lastKnownFloor!==null&&(!Number.isSafeInteger(root.lastKnownFloor)||root.lastKnownFloor<0)
      ||(ordinary?!storyboardOrdinaryBudgetRoot(root):normalizeStoryboardStreamReference(root).invalid)
      ||root.chatKey!==ref.chatKey||root.role!==ref.role||root.name!==ref.name||root.swipeId!==ref.swipeId
      ||!ordinary&&(root.stream.generationKey===proof.generationKey||root.stream.prefixLength>proof.prefixLength))return {version:1,invalid:true};
    // A single original root, never recursively nested copies of every continue.
    // Whitelist the compact reference so arbitrary imported payloads are not saved.
    family={version:ordinary?2:1,namespace:value.namespace,reference:storyboardStreamCompactRoot(root)};
  }
  return {version:proof.version,generation:Object.fromEntries(fields.map(key=>[key,g[key]])),generationKey:proof.generationKey,
    prefixLength:proof.prefixLength,prefixHash:proof.prefixHash,prefixDigest:proof.prefixDigest,
    ...(proof.complete===true?{complete:true}:{}),
    ...(proof.closedParagraph===true?{closedParagraph:true}:{}),
    ...(Object.hasOwn(proof,'moment')?{moment:normalizeStoryboardStreamMoment(proof.moment)}:{}),...(family?{family}:{})};
}

function storyboardStreamCompactRoot(ref){
  const root={};
  for(const key of ['version','chatKey','messageKey','role','name','baseSendDate','baseGenerationId','swipeId','revisionHash','revisionId','lastKnownFloor','createdAt','updatedAt']){
    if(Object.hasOwn(ref,key))root[key]=ref[key];
  }
  if(hasStoryboardStreamReference(ref)){const proof=normalizeStoryboardStreamReference(ref);delete proof.moment;root.stream=proof;}
  return root;
}

function storyboardOrdinaryBudgetRoot(ref){
  if(hasStoryboardStreamReference(ref)||ref?.role!=='assistant')return false;
  try{storyboardContinuationSource(ref);return true;}catch{return false;}
}

// Budget provenance is separate from the fresh source prefix. This is a compact
// identity projection, not permission to submit; admission still verifies both
// source proofs and the explicitly saved append path before claiming a slot.
export function storyboardStreamBudgetReference(ref,namespace){
  const proof=normalizeStoryboardStreamReference(ref);if(proof.invalid)fail();
  if(proof.family&&namespace!==undefined&&namespace!==proof.family.namespace)fail();
  return proof.family?.reference||ref;
}

export async function bindStoryboardStreamBudgetFamily(reference,root,namespace,resolve){
  const proof=normalizeStoryboardStreamReference(reference);if(proof.invalid||proof.version!==1)fail();
  if(hasStoryboardStreamReference(root))root=storyboardStreamBudgetReference(root,namespace);
  else if(!storyboardOrdinaryBudgetRoot(root))fail();
  if(root.chatKey===reference.chatKey&&root.messageKey===reference.messageKey&&root.revisionId===reference.revisionId)return reference;
  const ordinary=!hasStoryboardStreamReference(root);
  const result={...reference,stream:{...proof,version:ordinary?3:2,family:{version:ordinary?2:1,namespace,reference:storyboardStreamCompactRoot(root)}}};
  if(normalizeStoryboardStreamReference(result).invalid||typeof resolve!=='function')fail();
  await verifyStoryboardStreamReference(result,()=>resolve(result));
  return result;
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
  let family;
  if(state==='active'&&proof.family){
    if(options.namespace!==undefined&&options.namespace!==proof.family.namespace)return empty('stale');
    family=(proof.version===3?resolveStoryboardOrdinaryContinuation:resolveStoryboardStreamReference)(proof.family.reference,messages,createReference,{...options,namespace:proof.family.namespace});
    // Both roots resolving somewhere in this chat is not enough: the recorded
    // original path must pass through this new source's exact reply generation.
    const target=(family?.continuations||[]).find(link=>link.to.messageKey===reference.messageKey&&link.to.swipeId===reference.swipeId
      &&JSON.stringify(link.to.generation)===JSON.stringify(proof.generation));
    if(family?.state!=='active'||family.message!==message||family.floor!==floor||!target||proof.version===3&&family.continuations[0].length>proof.prefixLength)state='stale';
  }
  return {state,floor,message,reference,current:{...reference,lastKnownFloor:floor},relocated:floor!==reference.lastKnownFloor,
    ...(bridges.length?{continuations:bridges}:{}),...(state==='active'&&family?{family}:{})};
}

export async function verifyStoryboardStreamReference(ref,resolve){
  if(!hasStoryboardStreamReference(ref))return true;
  const signature=JSON.stringify(ref);
  const proof=normalizeStoryboardStreamReference(ref);if(proof.invalid||typeof resolve!=='function')fail();
  const before=resolve();if(before?.state!=='active'||typeof before.message?.mes!=='string')fail();
  const familySignature=JSON.stringify([before.family?.reference,before.family?.continuations]);
  const prefix=before.message.mes.slice(0,proof.prefixLength);
  const bridges=(before.continuations||[]).map(link=>({link,prefix:before.message.mes.slice(0,link.length)}));
  if(prefix.length!==proof.prefixLength||await storyboardStreamDigest(prefix)!==proof.prefixDigest
    ||await storyboardStreamDigest(storyboardStreamGenerationInput(ref,proof.generation))!==proof.generationKey)fail();
  for(const {link,prefix} of bridges){
    if(await storyboardStreamDigest(prefix)!==link.digest
      ||await storyboardStreamDigest(storyboardContinuationIdentityInput(link))!==link.id)fail();
  }
  if(proof.family){
    if(proof.version===3)await verifyStoryboardOrdinaryContinuation(proof.family.reference,()=>resolve()?.family,{namespace:proof.family.namespace,required:true});
    else await verifyStoryboardStreamReference(proof.family.reference,()=>resolve()?.family);
  }
  const after=resolve();
  if(JSON.stringify(ref)!==signature||after?.state!=='active'||after.message!==before.message||after.floor!==before.floor||after.message.mes.slice(0,proof.prefixLength)!==prefix
    ||JSON.stringify([after.family?.reference,after.family?.continuations])!==familySignature
    ||JSON.stringify(after.continuations||[])!==JSON.stringify(before.continuations||[])
    ||bridges.some(({link,prefix})=>after.message.mes.slice(0,link.length)!==prefix))fail();
  return true;
}
