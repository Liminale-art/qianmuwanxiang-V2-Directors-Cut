import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {resolveStoryboardMessageReference} from './qianmu-storyboard.js?v=1.59.336';
import {hasStoryboardStreamReference,storyboardStreamGeneration,storyboardStreamGenerationInput,storyboardStreamDigest,storyboardStreamFingerprint,normalizeStoryboardStreamReference,bindStoryboardStreamBudgetFamily} from './qianmu-storyboard-stream-reference.js?v=1.59.336';
import {readStoryboardContinuationLinks} from './qianmu-storyboard-continuation-proof.js?v=1.59.336';
import {readStoryboardStreamCoverage,bindStoryboardStreamShotReferences,storyboardStreamCoverageScope} from './qianmu-storyboard-stream-coverage.js?v=1.59.336';
import {createStoryboardStreamMessageReference} from './qianmu-storyboard-stream-source.js?v=1.59.336';
import {captureStoryboardContinuitySource} from './qianmu-storyboard-continuity-source.js';
import {STORYBOARD_CONTINUITY_EVENT_LIMITS} from './qianmu-storyboard-continuity-events.js';
import {createStoryboardContinuityStoreSession} from './qianmu-storyboard-continuity-store.js';
import {borrowStoryboardStreamFrame} from './qianmu-storyboard-stream-source.js?v=1.59.336';
import {bindStoryboardContinuityEvents} from './qianmu-storyboard-continuity-events.js';
import {beginStoryboardStreamAttempt} from './qianmu-storyboard-stream-attempt.js?v=1.59.336';
import {createStoryboardStreamCheckpointStorage} from './qianmu-storyboard-stream-checkpoint-storage.js?v=1.59.336';
import {captureEnsembleWindowHistory} from './qianmu-ensemble-history.js?v=1.59.336';
export {captureStoryboardStreamFrame,storyboardStableStreamBoundary,createStoryboardStreamMessageReference} from './qianmu-storyboard-stream-source.js?v=1.59.336';

const changed = () => Object.assign(new Error('取景来源已变化，旧结果未写回；请重新提取'), {code:'storyboard_input_changed'});
const windows = new WeakMap();
export async function captureStoryboardEnsembleHistory(window,rows){
  const scope=windows.get(window);if(!scope)throw changed();window.assertCurrent();
  const sources=window.sources.filter(source=>source.messageRef.lastKnownFloor<window.floor);
  // Dense selected-only view: even a resolver fallback cannot scan unselected
  // chat text. Map its temporary indices back to the real selected floors.
  const remap=value=>value&&({...value,floor:Number.isInteger(value.floor)?sources[value.floor]?.messageRef.lastKnownFloor:null,
    ...(value.family?{family:remap(value.family)}:{})});
  const resolve=ref=>{window.assertCurrent();return remap(resolveStoryboardMessageReference(ref,sources.map(source=>scope.getContext().chat[source.messageRef.lastKnownFloor]),
    {chatKey:window.current.messageRef.chatKey,namespace:scope.namespace,metadata:scope.getContext().chatMetadata}));};
  return captureEnsembleWindowHistory(window,rows,{namespace:scope.namespace,resolve});
}
export async function captureStoryboardStreamCoverage(window,rows,plans=[],pipelineLogs=[]){
  if(!Array.isArray(rows)||!Array.isArray(plans)||rows.length>2000||plans.length>300)throw changed();
  const scope=windows.get(window);if(!scope)throw changed();window.assertCurrent();
  const links=readStoryboardContinuationLinks(scope.getContext().chatMetadata?.story_director_liminale);
  if(links===undefined&&![...rows,...plans].some(row=>hasStoryboardStreamReference(row?.snapshot?.messageRef||row?.messageRef)))return null;
  return readStoryboardStreamCoverage(window,rows,{message:scope.getContext().chat[window.floor],namespace:scope.namespace,plans,pipelineLogs,
    continuationLinks:links,
    sourceParagraphs:length=>{window.assertCurrent();const message=scope.getContext().chat[window.floor];
      const paragraphs=scope.readParagraphs({...message,mes:message.mes.slice(0,length)},window.floor);window.assertCurrent();return paragraphs;},
    resolve:ref=>resolveStoryboardMessageReference(ref,scope.getContext().chat,{chatKey:window.current.messageRef.chatKey,namespace:scope.namespace,metadata:scope.getContext().chatMetadata})});
}
async function bindCoverageReference(reference,window,coverage){
  const scope=windows.get(window),family=storyboardStreamCoverageScope(coverage,window);
  if(!scope)throw changed();
  if(!family)return reference;
  if(family.namespace!==scope.namespace||family.chatKey!==reference.chatKey)throw changed();
  const result=await bindStoryboardStreamBudgetFamily(reference,family.reference,scope.namespace,
    ref=>resolveStoryboardMessageReference(ref,scope.getContext().chat,{chatKey:reference.chatKey,namespace:scope.namespace,metadata:scope.getContext().chatMetadata}));
  await window.guard();return Object.freeze({...result,stream:Object.freeze(result.stream)});
}
export async function prepareStoryboardStreamHandoff(result,context,frame){
  if(!windows.has(context.compilerSources))throw changed();
  const messageRef=result.shouldGenerate?(frame?await bindCoverageReference(await createStoryboardStreamMessageReference(frame),context.compilerSources,context.streamCoverage)
    :await createStoryboardFinalStreamReference(context.compilerSources,context.streamCoverage)):null;
  return {result,messageRef,shotReferences:bindStoryboardStreamShotReferences(messageRef,result,context.compilerSources)};
}
export async function createStoryboardStreamPlanReference(context,frame){
  if(!windows.has(context.compilerSources)||!frame)throw changed();
  return bindCoverageReference(await createStoryboardStreamMessageReference(frame),context.compilerSources,context.streamCoverage);
}
// Namespace is borrowed only from the authenticated compiler window, never
// from a form field or stream option. No storage is opened for ordinary work.
export async function beginStoryboardCompilerStreamAttempt(context,frame,d){
  const window=context.compilerSources,owner=windows.get(window);
  if(!owner)throw changed();window.assertCurrent();
  const reference=await createStoryboardStreamPlanReference(context,frame);
  return beginStoryboardStreamAttempt(reference,context.streamCoverage?.scope,{...d,
    openCheckpoint:({reference:root,planId,guard})=>createStoryboardStreamCheckpointStorage({
      scope:{namespace:owner.namespace,chatKey:root.chatKey,messageKey:root.messageKey,revisionId:root.revisionId,planId},
      guard:()=>{window.assertCurrent();return guard();},
    }),
  });
}
export async function createStoryboardFinalStreamReference(window,coverage=null){
  const scope=windows.get(window);
  if(!scope||window.stream)throw changed();
  storyboardStreamCoverageScope(coverage,window);
  await window.guard();
  const message=scope.getContext().chat[window.floor],raw=message?.mes,ref={...window.current.messageRef};
  if(typeof raw!=='string'||!raw.length||raw.length>200000)throw Object.assign(new Error('终稿正文超过可核对范围，未截断或提交'),{code:'storyboard_stream_source'});
  const generation=storyboardStreamGeneration(message);
  const [prefixDigest,generationKey]=await Promise.all([storyboardStreamDigest(raw),storyboardStreamDigest(storyboardStreamGenerationInput(ref,generation))]);
  await window.guard();
  if(scope.getContext().chat[window.floor]!==message||message.mes!==raw)throw changed();
  ref.revisionHash=storyboardStreamFingerprint(raw);ref.revisionId=`stream:${generationKey}`;
  ref.stream={version:1,generation:Object.freeze(generation),generationKey,prefixLength:raw.length,prefixHash:ref.revisionHash,prefixDigest,complete:true};
  if(normalizeStoryboardStreamReference(ref).invalid)throw Object.assign(new Error('当前终稿缺少稳定的生成身份，未提交补图'),{code:'storyboard_stream_source'});
  return bindCoverageReference(Object.freeze({...ref,stream:Object.freeze(ref.stream)}),window,coverage);
}
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key=>keys.includes(key));

export function openStoryboardCompilerContinuity(window,options={}) {
  const scope=windows.get(window);
  if(!scope)throw changed();
  window.assertCurrent();
  const session=createStoryboardContinuityStoreSession({...scope,window,timeoutMs:options.timeoutMs});
  if(!window.stream)return session;
  let closed=false;
  const check=()=>{if(closed)throw changed();window.assertCurrent();};
  return Object.freeze({read:session.read,close(){closed=true;session.close();},get pending(){return false;},async publish(proposals){
    check();
    if(!Array.isArray(proposals)||!proposals.length||proposals.length>window.sources.length)throw changed();
    const seen=new Set();
    for(const proposal of proposals){
      if(!exact(proposal,['floor','roster','events'])||!exact(proposal.roster,['branches','subjectIds']))throw changed();
      const source=window.sources.find(row=>row.messageRef.lastKnownFloor===proposal?.floor);
      if(!source||seen.has(proposal.floor))throw changed();seen.add(proposal.floor);
      bindStoryboardContinuityEvents(proposal.events,{messageRef:source.messageRef,chatKey:source.messageRef.chatKey,paragraphs:source.paragraphs,...proposal.roster});
    }
    await window.guard();check();return Object.freeze({status:'deferred',reason:'streaming_source'});
  }});
}

export async function captureStoryboardCompilerSources(options={}){
  if(options.streamFrame==null)return captureSources(options);
  const borrowed=borrowStoryboardStreamFrame(options.streamFrame,options);
  try{return await captureSources({...options,getContext:borrowed.getContext,isCurrent:()=>{borrowed.assertCurrent();return options.isCurrent();}},borrowed);}
  catch(error){borrowed.close();throw error;}
}

// One borrowed window for the actual compiler, not another history cache. Never
// scan outside the user's selected raw ST floor range or retain prose globally.
async function captureSources({floor,referenceFloors,getContext,epoch,resolveNamespace,isCurrent,readParagraphs,readText,signal}={},stream=null) {
  if (!Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(referenceFloors) || referenceFloors < 0 || referenceFloors > 20
    || typeof readText !== 'function' || typeof readParagraphs !== 'function' || typeof isCurrent !== 'function') {
    throw Object.assign(new Error('取景来源范围无效，未读取或发送正文'), {code:'storyboard_context_unavailable'});
  }
  const host = captureCurrentChatSource({getContext,epoch});
  const start = Math.max(0,floor-referenceFloors), slots = [], sources = [], messages = [], listeners = [];
  let emitter,remove;
  let closed = false, namespace, handle;
  const close = () => { closed = true; windows.delete(handle); host.close(); for (const source of sources) source.close(); signal?.removeEventListener('abort',close);stream?.close();
    for (const [type,handler] of listeners.splice(0)) { try { remove.call(emitter,type,handler); } catch (_) {} } };
  const assertCurrent = () => {
    try {
      if (closed || signal?.aborted || isCurrent() !== true) throw changed();
      host.assertCurrent();
      const chat = getContext().chat;
      for (const slot of slots) {
        const item = chat[slot.floor];
        if (item !== slot.message || item?.mes !== slot.raw || item?.is_system !== slot.system || item?.is_user !== slot.user
          || item?.swipe_id !== slot.swipe || item?.name !== slot.name || JSON.stringify(storyboardStreamGeneration(item||{}))!==slot.generation) throw changed();
      }
      for (const source of sources) source.assertCurrent();
      return true;
    } catch (_) { close(); throw changed(); }
  };
  try {
    emitter=getContext().eventSource;remove=typeof emitter?.removeListener==='function'?emitter.removeListener:emitter?.off;
    signal?.addEventListener('abort',close,{once:true});
    assertCurrent();
    const chat = getContext().chat;
    if (!chat[floor] || chat[floor].is_system) throw Object.assign(new Error('当前楼层没有可取景的正文'), {code:'storyboard_context_unavailable'});
    for (let index=start; index<=floor; index++) {
      const message = chat[index];
      slots.push({floor:index,message,raw:message?.mes,system:message?.is_system,user:message?.is_user,swipe:message?.swipe_id,name:message?.name,generation:JSON.stringify(storyboardStreamGeneration(message||{}))});
    }
    if (typeof emitter?.on === 'function' && typeof remove === 'function') {
      const types = getContext().eventTypes || {};
      for (const [name,fallback] of [['MESSAGE_EDITED','message_edited'],['MESSAGE_SWIPED','message_swiped'],['MESSAGE_DELETED','message_deleted']]) {
        const type = types[name] || fallback;
        const handler = value => { if (name === 'MESSAGE_DELETED' || !Number.isSafeInteger(value) || value >= start && value <= floor) close(); };
        listeners.push([type,handler]); emitter.on(type,handler);
      }
    }
    let lookup;
    const resolve = () => {
      // Share only an in-flight check, not a cached identity. Twenty selected
      // floors must not cause twenty simultaneous /api/users/me fallbacks.
      lookup ||= Promise.resolve().then(resolveNamespace).then(value=>{
        if (namespace === undefined) namespace = value;
        if (closed || namespace !== value) { close(); throw changed(); }
        return value;
      }).finally(()=>{lookup=null;});
      return lookup;
    };
    const paragraphsFor = (message,index) => {
      const rows = readParagraphs(message,index), limits = STORYBOARD_CONTINUITY_EVENT_LIMITS;
      if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('所选楼层没有可定位的正文段落，未发送不完整上下文'), {code:'storyboard_context_unavailable'});
      if (Array.isArray(rows) && (rows.length > limits.paragraphs || rows.reduce((sum,row)=>sum+(typeof row?.text==='string'?row.text.length:0),0) > limits.characters)) {
        throw Object.assign(new Error('所选正文超过变化追踪单次容量，未截断或发送，请减少参考范围或正文长度'), {code:'storyboard_input_capacity'});
      }
      return rows;
    };
    // Start every capture before awaiting any account lookup. This observes an
    // edit-and-restore in an earlier dependency even while another lookup waits.
    const pending = slots.filter(slot=>slot.message && !slot.system).map(async slot => {
      const text = readText(slot.message,slot.floor);
      if (typeof text !== 'string') throw Object.assign(new Error('正文读取失败，未发送不完整上下文'), {code:'storyboard_context_unavailable'});
      if (!text.trim()) return null; // Deliberately excluded tags / blank floors.
      const source = await captureStoryboardContinuitySource({floor:slot.floor,getContext,epoch,resolveNamespace:resolve,isCurrent:()=>!closed && isCurrent(),readParagraphs:paragraphsFor,signal});
      if (closed) { source.close(); throw changed(); }
      sources.push(source);
      return {source,message:Object.freeze({floor:slot.floor,role:slot.user?'user':'character',text})};
    });
    // Drain all started captures even on failure; a late success must not leak
    // listeners or resurrect an already cancelled compiler.
    const settled = await Promise.allSettled(pending);
    const failure = settled.find(result=>result.status==='rejected');
    if (failure) throw failure.reason;
    sources.sort((a,b)=>a.messageRef.lastKnownFloor-b.messageRef.lastKnownFloor);
    for (const result of settled) if (result.value) messages.push(result.value.message);
    assertCurrent();
    const current = sources.find(source=>source.messageRef.lastKnownFloor===floor);
    if (!current) throw Object.assign(new Error('当前正文经提取规则处理后为空，未调用模型'), {code:'storyboard_context_unavailable'});
    const guard = async () => {
      try { assertCurrent(); await current.guard(); assertCurrent(); return true; }
      catch (_) { close(); throw changed(); }
    };
    await guard();
    let streamScope;
    if(stream){
      const stable=stream.stableParagraphs(readParagraphs);
      if(Array.isArray(stable)&&!stable.length)throw Object.assign(new Error('等待完整可见段落'),{code:'storyboard_stream_wait'});
      if(!Array.isArray(stable)||stable.some((row,index)=>row.id!==current.paragraphs[index]?.id||row.text!==current.paragraphs[index]?.text))throw changed();
      await stream.guard();assertCurrent();streamScope=Object.freeze({...stream.proof,stableParagraphIds:Object.freeze(stable.map(row=>row.id))});
    }
    handle=Object.freeze({floor,referenceFloors,messages:Object.freeze(messages),sources:Object.freeze([...sources]),
      paragraphs:Object.freeze(current.paragraphs.map(row=>row.text)),current,guard,assertCurrent,close,...(streamScope?{stream:streamScope}:{})});
    windows.set(handle,{getContext,host,namespace,readParagraphs});
    return handle;
  } catch (error) {
    close();
    if (error?.code === 'storyboard_continuity_scope') throw Object.assign(new Error('所选正文超过变化追踪单次容量，未截断或发送，请减少参考范围或正文长度'), {code:'storyboard_input_capacity'});
    if (['storyboard_continuity_source','current_chat_source'].includes(error?.code)) throw changed();
    throw error;
  }
}
