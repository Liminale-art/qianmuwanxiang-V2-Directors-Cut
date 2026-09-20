import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {captureStoryboardContinuitySource} from './qianmu-storyboard-continuity-source.js';
import {STORYBOARD_CONTINUITY_EVENT_LIMITS} from './qianmu-storyboard-continuity-events.js';

const changed = () => Object.assign(new Error('取景来源已变化，旧结果未写回；请重新提取'), {code:'storyboard_input_changed'});

// One borrowed window for the actual compiler, not another history cache. Never
// scan outside the user's selected raw ST floor range or retain prose globally.
export async function captureStoryboardCompilerSources({floor,referenceFloors,getContext,epoch,resolveNamespace,isCurrent,readParagraphs,readText,signal}={}) {
  if (!Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(referenceFloors) || referenceFloors < 0 || referenceFloors > 20
    || typeof readText !== 'function' || typeof readParagraphs !== 'function' || typeof isCurrent !== 'function') {
    throw Object.assign(new Error('取景来源范围无效，未读取或发送正文'), {code:'storyboard_context_unavailable'});
  }
  const host = captureCurrentChatSource({getContext,epoch});
  const start = Math.max(0,floor-referenceFloors), slots = [], sources = [], messages = [], listeners = [];
  const emitter = getContext().eventSource, remove = typeof emitter?.removeListener === 'function' ? emitter.removeListener : emitter?.off;
  let closed = false, namespace;
  const close = () => { closed = true; host.close(); for (const source of sources) source.close(); signal?.removeEventListener('abort',close);
    for (const [type,handler] of listeners.splice(0)) { try { remove.call(emitter,type,handler); } catch (_) {} } };
  const assertCurrent = () => {
    try {
      if (closed || signal?.aborted || isCurrent() !== true) throw changed();
      host.assertCurrent();
      const chat = getContext().chat;
      for (const slot of slots) {
        const item = chat[slot.floor];
        if (item !== slot.message || item?.mes !== slot.raw || item?.is_system !== slot.system || item?.is_user !== slot.user
          || item?.swipe_id !== slot.swipe || item?.name !== slot.name) throw changed();
      }
      for (const source of sources) source.assertCurrent();
      return true;
    } catch (_) { close(); throw changed(); }
  };
  try {
    signal?.addEventListener('abort',close,{once:true});
    assertCurrent();
    const chat = getContext().chat;
    if (!chat[floor] || chat[floor].is_system) throw Object.assign(new Error('当前楼层没有可取景的正文'), {code:'storyboard_context_unavailable'});
    for (let index=start; index<=floor; index++) {
      const message = chat[index];
      slots.push({floor:index,message,raw:message?.mes,system:message?.is_system,user:message?.is_user,swipe:message?.swipe_id,name:message?.name});
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
    return Object.freeze({floor,referenceFloors,messages:Object.freeze(messages),sources:Object.freeze([...sources]),
      paragraphs:Object.freeze(current.paragraphs.map(row=>row.text)),current,guard,assertCurrent,close});
  } catch (error) {
    close();
    if (error?.code === 'storyboard_continuity_scope') throw Object.assign(new Error('所选正文超过变化追踪单次容量，未截断或发送，请减少参考范围或正文长度'), {code:'storyboard_input_capacity'});
    if (['storyboard_continuity_source','current_chat_source'].includes(error?.code)) throw changed();
    throw error;
  }
}
