import {bindStoryboardContinuityEvents} from './qianmu-storyboard-continuity-events.js';
import {acquireChatSaveLock,releaseChatSaveLock} from './qianmu-chat-save-lock.js';
import {normalizeStoryboardMessageReference,STORYBOARD_NARRATIVE_LAYERS,STORYBOARD_CONTINUITY_FACT_CATEGORIES,STORYBOARD_CONTINUITY_FACT_PERSISTENCE} from './qianmu-storyboard.js';

export const STORYBOARD_CONTINUITY_STORE_SCHEMA = 'qianmu.storyboard.continuity-store.v1';
export const STORYBOARD_CONTINUITY_STORE_LIMITS = Object.freeze({records:21,bytes:524288});
const FIELD = 'storyboardContinuity';
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && Object.keys(value).every(key=>keys.includes(key));
const plain = value => value && typeof value==='object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const fail = message => { throw Object.assign(new Error(message),{code:'storyboard_continuity_storage'}); };
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const frozen = value => { if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value; };
const sourceKey = ref => JSON.stringify([ref.chatKey,ref.lastKnownFloor,ref.messageKey,ref.revisionId,ref.revisionHash,ref.swipeId,ref.role,ref.name]);
const text = (value,max) => typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');
function envelope(record) {
  if(!plain(record?.messageRef))return false;
  const ref=normalizeStoryboardMessageReference(record.messageRef);
  if(!exact(record.messageRef,Object.keys(ref))||Object.keys(ref).some(key=>record.messageRef[key]!==ref[key]))return false;
  if(record.roster.branches.some(row=>!exact(row,['id','layer'])||!text(row.id,160)||!STORYBOARD_NARRATIVE_LAYERS.includes(row.layer))
    ||record.roster.subjectIds.some(value=>!text(value,160)))return false;
  return record.events.every(row=>exact(row,['id','branchId','paragraphId','subjectId','category','key','value','persistence','evidence'])
    &&['id','branchId','paragraphId','subjectId'].every(key=>text(row[key],160))&&text(row.key,120)&&text(row.value,1000)&&text(row.evidence,1000)
    &&STORYBOARD_CONTINUITY_FACT_CATEGORIES.includes(row.category)&&STORYBOARD_CONTINUITY_FACT_PERSISTENCE.includes(row.persistence));
}
async function digest(paragraphs) {
  if (!globalThis.crypto?.subtle) fail('当前环境不能核对变化来源，未复用旧状态');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(paragraphs)));
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}

// Called only by the authentic compiler-window factory. This is derived state,
// not a new original/story archive. It travels with ST's existing chat metadata.
export function createStoryboardContinuityStoreSession({window,getContext,host,namespace,timeoutMs=10000}={}) {
  window.assertCurrent();host.assertCurrent();
  const context=getContext(),metadata=context.chatMetadata,store=metadata?.story_director_liminale,saveHost=context.saveMetadata;
  const owner=frozen({namespace,ownerKey:host.source.ownerKey,target:clone(host.target),integrity:host.integrity});
  const sources=new Map(window.sources.map(source=>[source.messageRef.lastKnownFloor,source])),fingerprints=new Map();
  let closed=false,busy=false,pending=false;
  const token={};
  const check=()=>{
    if(closed)fail('变化记录会话已结束');window.assertCurrent();host.assertCurrent();
    const current=getContext();
    if(current.chatMetadata!==metadata||current.chatMetadata?.story_director_liminale!==store)fail('变化记录所在聊天已变化');
  };
  const guard=async()=>{check();await window.guard();check();};
  const fingerprint=async source=>{
    if(!fingerprints.has(source))fingerprints.set(source,digest(source.paragraphs));
    return fingerprints.get(source);
  };
  const referenceMatches=(a,b)=>sourceKey(a)===sourceKey(b);

  // Strict shape/bounds before cloning or serializing. Unknown future or damaged
  // stores remain untouched; a cache problem must not destroy a user's archive.
  function inspect() {
    check();
    if(!plain(store))return {status:'unavailable',reason:'chat_store_unavailable',records:[]};
    if(!Object.hasOwn(store,FIELD))return {status:'ready',revision:0,records:[]};
    const value=store[FIELD];
    if(!exact(value,['schema','owner','revision','records'])||value.schema!==STORYBOARD_CONTINUITY_STORE_SCHEMA
      ||!Number.isSafeInteger(value.revision)||value.revision<1||!Array.isArray(value.records)||value.records.length>STORYBOARD_CONTINUITY_STORE_LIMITS.records) {
      return {status:'unavailable',reason:'unsupported_store',records:[]};
    }
    if(!exact(value.owner,Object.keys(owner))||['namespace','ownerKey','integrity'].some(key=>value.owner[key]!==owner[key])
      ||!exact(value.owner.target,Object.keys(owner.target))||Object.keys(owner.target).some(key=>value.owner.target[key]!==owner.target[key]))return {status:'unavailable',reason:'owner_mismatch',records:[]};
    const seen=new Set();
    for(const record of value.records){
      if(!exact(record,['messageRef','paragraphDigest','roster','events'])||!plain(record.messageRef)
        ||!Number.isSafeInteger(record.messageRef.lastKnownFloor)||record.messageRef.lastKnownFloor<0
        ||typeof record.paragraphDigest!=='string'||! /^[a-f0-9]{64}$/.test(record.paragraphDigest)
        ||!exact(record.roster,['branches','subjectIds'])||!Array.isArray(record.roster.branches)||record.roster.branches.length>40
        ||!Array.isArray(record.roster.subjectIds)||record.roster.subjectIds.length>80||!Array.isArray(record.events)||record.events.length>80) {
        return {status:'unavailable',reason:'invalid_record',records:[]};
      }
      if(!envelope(record))return {status:'unavailable',reason:'invalid_record',records:[]};
      const floor=record.messageRef.lastKnownFloor;if(seen.has(floor))return {status:'unavailable',reason:'duplicate_floor',records:[]};seen.add(floor);
    }
    // Bound the serialized cache as well as the number of records. Never put
    // whole prose, image payloads, API keys or arbitrary model fields here.
    try{if(bytes(value)>STORYBOARD_CONTINUITY_STORE_LIMITS.bytes)return {status:'unavailable',reason:'storage_capacity',records:[]};}
    catch(_){return {status:'unavailable',reason:'invalid_record',records:[]};}
    return {status:'ready',revision:value.revision,records:value.records};
  }

  async function read() {
    check();const initial=inspect();
    if(initial.status!=='ready')return frozen({...initial,records:[]});
    if(!initial.records.length)return frozen({status:'ready',revision:initial.revision,records:[],invalidFloors:[]});
    const baseline=store?.[FIELD],baselineText=JSON.stringify(baseline),records=[],invalid=[];
    for(const source of window.sources){
      const record=initial.records.find(row=>row.messageRef.lastKnownFloor===source.messageRef.lastKnownFloor);
      if(!record)continue;
      const floor=source.messageRef.lastKnownFloor;
      if(!referenceMatches(record.messageRef,source.messageRef)||record.paragraphDigest!==await fingerprint(source)){invalid.push(floor);continue;}
      check();
      try{
        bindStoryboardContinuityEvents(record.events,{messageRef:source.messageRef,chatKey:source.messageRef.chatKey,paragraphs:source.paragraphs,...record.roster});
        records.push(clone(record));
      }catch(_){invalid.push(floor);}
    }
    await guard();
    if(store?.[FIELD]!==baseline||JSON.stringify(store?.[FIELD])!==baselineText)fail('读取期间变化记录已更新，请重新取景');
    return frozen({status:'ready',revision:initial.revision,records,invalidFloors:invalid});
  }

  async function publish(proposals) {
    check();
    if(busy||pending)fail('上一项变化保存尚未结束，未重复保存');
    if(!Array.isArray(proposals)||!proposals.length||proposals.length>sources.size)fail('变化保存数量无效');
    // Detach model fields synchronously, before any await. Only raw events and
    // declared rosters are accepted, never model-provided ownership or offsets.
    const seen=new Set(),prepared=proposals.map(proposal=>{
      if(!exact(proposal,['floor','roster','events'])||!sources.has(proposal.floor)||seen.has(proposal.floor))fail('变化保存来源重复或超出取景范围');
      if(!exact(proposal.roster,['branches','subjectIds']))fail('变化人物与分支字段无效');
      seen.add(proposal.floor);const source=sources.get(proposal.floor);
      const bound=bindStoryboardContinuityEvents(proposal.events,{messageRef:source.messageRef,chatKey:source.messageRef.chatKey,paragraphs:source.paragraphs,branches:proposal.roster.branches,subjectIds:proposal.roster.subjectIds});
      return {source,messageRef:clone(bound.messageRef),roster:clone(proposal.roster),events:clone(proposal.events)};
    });
    if(!plain(store)||typeof saveHost!=='function')return {status:'unavailable',reason:'host_save_unavailable'};
    if(!acquireChatSaveLock(store,token))return {status:'unavailable',reason:'host_save_busy'};
    busy=true;
    const release=()=>{if(!pending)releaseChatSaveLock(store,token);};
    try{
      await guard();const initial=inspect();
      if(initial.status!=='ready')return {status:'unavailable',reason:initial.reason};
      const baseline=store[FIELD],baselineText=JSON.stringify(baseline);
      const records=await Promise.all(prepared.map(async row=>({messageRef:row.messageRef,paragraphDigest:await fingerprint(row.source),roster:row.roster,events:row.events})));
      await guard();
      if(store[FIELD]!==baseline||JSON.stringify(store[FIELD])!==baselineText)fail('保存期间变化记录已更新，未覆盖新内容');
      for(let index=0;index<records.length;index++){
        const row=records[index],prior=initial.records.find(value=>referenceMatches(value.messageRef,row.messageRef));
        if(prior&&prior.paragraphDigest===row.paragraphDigest&&equal(prior.roster,row.roster)&&equal(prior.events,row.events))records[index]=clone(prior);
      }
      const replaced=new Set(records.map(row=>row.messageRef.lastKnownFloor));
      const merged=[...records.sort((a,b)=>b.messageRef.lastKnownFloor-a.messageRef.lastKnownFloor),...initial.records.filter(record=>!replaced.has(record.messageRef.lastKnownFloor))]
        .slice(0,STORYBOARD_CONTINUITY_STORE_LIMITS.records);
      const next={schema:STORYBOARD_CONTINUITY_STORE_SCHEMA,owner:clone(owner),revision:initial.revision+1,records:merged};
      while(merged.length>records.length&&bytes(next)>STORYBOARD_CONTINUITY_STORE_LIMITS.bytes)merged.pop();
      if(!Number.isSafeInteger(next.revision)||bytes(next)>STORYBOARD_CONTINUITY_STORE_LIMITS.bytes)return {status:'unavailable',reason:'storage_capacity'};
      if(initial.revision&&equal(initial.records,merged))return {status:'unchanged',revision:initial.revision};
      check();if(getContext().saveMetadata!==saveHost)fail('ST 保存接口已变化，未写入变化记录');
      const expectedText=JSON.stringify(next);
      // No await between final source check, captured field assignment and host
      // call. Never direct-write /api/chats/save or replace the whole ST store.
      store[FIELD]=next;pending=true;
      let operation;
      try{operation=Promise.resolve(saveHost.call(context));}catch(error){operation=Promise.reject(error);}
      const settled=operation.then(()=>({status:'host_returned',revision:next.revision}),()=>({status:'unconfirmed',reason:'host_failed',revision:next.revision}))
        .finally(()=>{pending=false;release();});
      let timer;
      const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'unconfirmed',reason:'host_pending',revision:next.revision}),Math.max(100,Math.min(30000,Number(timeoutMs)||10000)));});
      const result=await Promise.race([settled,deadline]);clearTimeout(timer);
      // A settled host callback is NOT a server readback receipt. On failure or
      // switching, preserve the derived local field; do not issue a blind retry
      // or roll back a possibly committed write into another current chat.
      try{await guard();}catch(_){return {status:'unconfirmed',reason:'source_changed',revision:next.revision};}
      if(store[FIELD]!==next||JSON.stringify(store[FIELD])!==expectedText)return {status:'unconfirmed',reason:'local_changed',revision:next.revision};
      return result;
    } finally {busy=false;release();}
  }
  return Object.freeze({read,publish,close(){closed=true;fingerprints.clear();if(!pending)releaseChatSaveLock(store,token);},get pending(){return pending;}});
}
