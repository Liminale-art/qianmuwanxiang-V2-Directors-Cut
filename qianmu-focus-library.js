// Dedicated focus recordings, not narration favorites or chat identity.
import {cleanFocusVoice} from './qianmu-focus-voice.js';

export const FOCUS_LIBRARY_MOMENTS = Object.freeze(['focus:mid', 'focus:complete', 'shortBreak:complete', 'longBreak:complete']);
export const FOCUS_LIBRARY_LIMITS = Object.freeze({clips:512, bytes:256*1024*1024, audioBytes:8*1024*1024});
export function focusLibraryError(code, message) { return Object.assign(new Error(message), {code:`focus_library_${code}`}); }
const fail = (code, message) => { throw focusLibraryError(code, message); };
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function focusLibraryNamespace(value) {
  if (typeof value !== 'string' || !/^st-user:.+/.test(value) || value.length>512 || /[\u0000-\u001f\u007f]/.test(value)) fail('scope', '无法确认当前账户');
  return value;
}
export function focusLibraryScope(value) {
  const namespace=focusLibraryNamespace(value?.namespace), characterKey=value?.characterKey;
  if (typeof characterKey!=='string' || !/^character:.+/.test(characterKey) || characterKey.length>4096 || /[\u0000-\u001f\u007f]/.test(characterKey)) fail('scope','请先选择角色');
  return {namespace,characterKey};
}
export function focusLibraryClipKey(scope, id) {
  const {namespace,characterKey}=focusLibraryScope(scope);
  if (typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) fail('id','语音条标识无效');
  return JSON.stringify([namespace,characterKey,id]);
}
export function normalizeFocusLibraryClip(value, scope) {
  const owner=focusLibraryScope(scope);
  focusLibraryClipKey(owner,value?.id);
  if (value.schemaVersion!==undefined && value.schemaVersion!==1) fail('schema','语音条版本暂不支持');
  if ((value.namespace!==undefined && value.namespace!==owner.namespace) || (value.characterKey!==undefined && value.characterKey!==owner.characterKey)) fail('scope','语音条不属于当前角色');
  const content=text(value.text,2000),speaker=text(value.speaker,160),title=text(value.title,120);
  const moments=[...new Set(Array.isArray(value.moments)?value.moments:[])];
  if (!content || !moments.length || moments.some(moment=>!FOCUS_LIBRARY_MOMENTS.includes(moment))) fail('content','请填写内容并选择适用阶段');
  const providerId=['minimax','doubao','elevenlabs'].includes(value.providerId)?value.providerId:'';
  return {schemaVersion:1,...owner,id:value.id,title,speaker,text:content,moments,
    providerId,voice:cleanFocusVoice(value.voice)};
}

// Missing/deleted recordings may be skipped. Storage errors are not an empty library.
// This component intentionally has no generator, provider credentials or fallback voice.
export function createFocusLibraryPicker({list, readAudio, random=Math.random}) {
  return async function pick(scope, moment, {previousId='', isCurrent=()=>true}={}) {
    const owner=focusLibraryScope(scope);
    if (!FOCUS_LIBRARY_MOMENTS.includes(moment)) fail('moment','语音使用时机无效');
    const stale=()=>({status:'stale'});
    if (!isCurrent()) return stale();
    try {
      const rows=await list(owner.namespace);
      if (!isCurrent()) return stale();
      const candidates=rows.filter(row=>row.namespace===owner.namespace && row.characterKey===owner.characterKey && row.moments.includes(moment)).map(row=>{
        if(!Number.isSafeInteger(row.revision)||row.revision<1) fail('revision','语音条版本无效');
        return {...normalizeFocusLibraryClip(row,owner),revision:row.revision,mimeType:row.mimeType||'',audioBytes:row.audioBytes||0,createdAt:row.createdAt||0,updatedAt:row.updatedAt||0};
      });
      const unique=[...new Map(candidates.map(row=>[row.id,row])).values()];
      for (let i=unique.length-1;i>0;i--) {
        const sample=random();
        if (!Number.isFinite(sample) || sample<0 || sample>=1) fail('random','抽取状态无效');
        const j=Math.floor(sample*(i+1)); [unique[i],unique[j]]=[unique[j],unique[i]];
      }
      // Prefer a different usable recording; the last one is still valid if alternatives expired.
      const ordered=[...unique.filter(row=>row.id!==previousId),...unique.filter(row=>row.id===previousId)];
      for (const clip of ordered) {
        if (!isCurrent()) return stale();
        const result=await readAudio(owner,clip.id,clip.revision);
        if (!isCurrent()) return stale();
        if (result.status==='ready') return {status:'ready',clip,blob:result.blob};
        if (!['missing','conflict'].includes(result.status)) throw focusLibraryError('storage','语音条暂不可读取');
      }
      return {status:'empty'};
    } catch(error) {
      if (!isCurrent()) return stale();
      return {status:'failed',code:error?.code||'focus_library_storage'};
    }
  };
}
