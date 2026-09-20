import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {createStoryboardMessageReference} from './qianmu-storyboard.js';
import {bindStoryboardContinuityEvents,replayStoryboardContinuityAt} from './qianmu-storyboard-continuity-events.js';
import {replayStoryboardContinuityChain,STORYBOARD_CONTINUITY_CHAIN_LIMIT} from './qianmu-storyboard-continuity-link.js';

const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_continuity_source'});};
const namespaceValid=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const liveSources=new WeakMap();
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));

// A borrowed live extraction scope, not persisted ownership or permission to
// relocate old state to a similar floor. Host filtering supplies full paragraphs.
export async function captureStoryboardContinuitySource({getContext,epoch,resolveNamespace,isCurrent,readParagraphs,floor,signal}={}){
  if(typeof resolveNamespace!=='function'||typeof isCurrent!=='function'||typeof readParagraphs!=='function'||!Number.isSafeInteger(floor)||floor<0)fail('变化来源缺少明确楼层与保护');
  const source=captureCurrentChatSource({getContext,epoch}),bindings=[];
  let closed=false,message,raw,reference,namespace,paragraphs,emitter,remove,handle;
  const close=()=>{closed=true;source.close();liveSources.delete(handle);signal?.removeEventListener('abort',close);for(const [type,handler] of bindings.splice(0)){try{remove.call(emitter,type,handler);}catch(_){/* Already invalid. */}}message=null;raw=null;paragraphs=null;};
  function assertCurrent(){
    try{
      if(closed||signal?.aborted||isCurrent()!==true)fail('变化来源页面已关闭或切换');source.assertCurrent();
      if(message){
        const current=getContext().chat[floor];
        if(current!==message||current.mes!==raw||current.is_system)fail('变化来源楼层已编辑、替换或移除');
        const now=createStoryboardMessageReference({message:current,chatKey:source.source.chatKey,floor,now:reference.updatedAt});
        if(['messageKey','revisionId','revisionHash','swipeId','role','name'].some(key=>now[key]!==reference[key]))fail('变化来源回复版本已改变');
      }
      return true;
    }catch(error){close();throw error;}
  }
  async function guard(){
    try{assertCurrent();const current=await resolveNamespace();assertCurrent();if(current!==namespace)fail('变化来源账户已切换');return true;}
    catch(error){close();throw error;}
  }
  try{
    signal?.addEventListener('abort',close,{once:true});assertCurrent();
    emitter=getContext().eventSource;remove=typeof emitter?.removeListener==='function'?emitter.removeListener:emitter?.off;
    message=getContext().chat[floor];
    if(!message||message.is_system||typeof message.mes!=='string')fail('当前楼层没有可提取的正文');
    if(!Number.isSafeInteger(message.swipe_id??0)||(message.swipe_id??0)<0)fail('当前回复编号无效');
    raw=message.mes;reference=Object.freeze(createStoryboardMessageReference({message,chatKey:source.source.chatKey,floor}));
    if(typeof emitter?.on==='function'&&typeof remove==='function'){
      const types=getContext().eventTypes||{};
      for(const [name,fallback] of [['MESSAGE_EDITED','message_edited'],['MESSAGE_SWIPED','message_swiped'],['MESSAGE_DELETED','message_deleted']]){
        const handler=value=>{if(name==='MESSAGE_DELETED'||!Number.isSafeInteger(value)||value===floor)close();};
        const type=types[name]||fallback;bindings.push([type,handler]);emitter.on(type,handler);assertCurrent();
      }
    }
    namespace=await resolveNamespace();assertCurrent();if(!namespaceValid(namespace))fail('尚未确认变化来源账户');
    const read=readParagraphs(message,floor);assertCurrent();
    bindStoryboardContinuityEvents([],{messageRef:reference,chatKey:source.source.chatKey,paragraphs:read,branches:[],subjectIds:[]});
    paragraphs=Object.freeze(read.map(value=>Object.freeze({...value})));await guard();
    const options=roster=>({messageRef:reference,chatKey:source.source.chatKey,paragraphs,branches:roster?.branches,subjectIds:roster?.subjectIds});
    // Validate before and after each result handoff. No caller-supplied ref,
    // paragraph order, account or offsets can replace this captured source.
    async function operation(run){await guard();const result=run();await guard();return result;}
    handle=Object.freeze({messageRef:reference,paragraphs,guard,assertCurrent,close,
      bind:(events,roster)=>operation(()=>bindStoryboardContinuityEvents(events,options(roster))),
      replay:(events,roster,target)=>operation(()=>replayStoryboardContinuityAt(events,options(roster),target))});
    const context=getContext();assertCurrent();
    liveSources.set(handle,{options,getContext,resolveNamespace,messages:context.chat,metadata:context.chatMetadata,
      identity:JSON.stringify([namespace,source.source.ownerKey,source.target,source.integrity])});
    return handle;
  }catch(error){close();throw error;}
}

// Borrow only handles captured by this module. No scan, new capture, storage or
// model request occurs. Caller closes successful scopes after its batch; a
// changed dependency closes the whole borrowed chain, not just the last floor.
export async function replayLiveStoryboardContinuity(steps,target,{referenceFloors}={}){
  if(!Array.isArray(steps)||!steps.length||steps.length>STORYBOARD_CONTINUITY_CHAIN_LIMIT||!Number.isSafeInteger(referenceFloors)||referenceFloors<0||referenceFloors>20)fail('请提供明确且有界的参考层数');
  const entries=[],handles=new Set();
  for(const step of steps){
    if(!exact(step,['source','events','roster','branchId','link'])||handles.has(step.source))fail('连续来源步骤无效或重复');
    const entry=liveSources.get(step.source);if(!entry){for(const candidate of steps)if(liveSources.has(candidate?.source))candidate.source.close();fail('连续来源会话已失效或未经过宿主核对');}
    entries.push(entry);handles.add(step.source);
  }
  const last=steps.at(-1).source,base=entries.at(-1),floor=last.messageRef.lastKnownFloor;
  for(let index=0;index<steps.length;index++){
    const entry=entries[index],sourceFloor=steps[index].source.messageRef.lastKnownFloor;
    if(entry.identity!==base.identity||entry.getContext!==base.getContext||entry.resolveNamespace!==base.resolveNamespace||entry.messages!==base.messages||entry.metadata!==base.metadata)fail('连续来源不属于同一账户与聊天会话');
    if(sourceFloor<floor-referenceFloors||sourceFloor>floor)fail('连续来源超出当前设置的参考楼层范围');
  }
  const check=()=>{try{for(const handle of handles)handle.assertCurrent();}catch(error){for(const handle of handles)handle.close();throw error;}};
  check();
  // Pure replay detaches/freeze-validates model fields synchronously, before any
  // await. Later caller edits cannot change this result. Format errors may retry.
  const result=replayStoryboardContinuityChain(steps.map((step,index)=>({source:{events:step.events,options:entries[index].options(step.roster)},branchId:step.branchId,link:step.link})),target);
  try{await last.guard();check();return result;}catch(error){for(const handle of handles)handle.close();throw error;}
}
