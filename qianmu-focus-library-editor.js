import {normalizeFocusLibraryClip,focusLibraryError} from './qianmu-focus-library.js';
// Draft audio is invalidated on wording/voice changes, but not on title or stage edits.
export function createFocusLibraryEditor({scope,initial,blob=null,generate,save,isCurrent=()=>true}) {
  let draft={...initial,moments:[...(initial.moments||[])]},audio=blob,epoch=0,busy=false,closed=false;
  const current=()=>!closed&&isCurrent();
  const requireCurrent=()=>{if(!current())throw focusLibraryError('stale','页面已变化，操作取消');};
  function update(patch){requireCurrent();if(busy)throw focusLibraryError('busy','请等待当前操作完成');
    if(Object.hasOwn(patch,'text')&&patch.text!==draft.text||Object.hasOwn(patch,'voice')&&JSON.stringify(patch.voice)!==JSON.stringify(draft.voice))audio=null;
    draft={...draft,...patch};if(patch.moments)draft.moments=[...patch.moments];epoch++;return snapshot();}
  function snapshot(){return {draft:structuredClone(draft),audio,busy,closed};}
  async function run(kind){
    requireCurrent();if(busy)throw focusLibraryError('busy','请等待当前操作完成');
    const clip=normalizeFocusLibraryClip(draft,scope),ticket=++epoch;busy=true;
    const valid=()=>current()&&epoch===ticket;
    try {
      if(kind==='generate'){const result=await generate(clip,{isCurrent:valid});if(!valid())return {status:'stale'};
        if(!(result instanceof Blob)||!result.size||!/^audio\//i.test(result.type))throw focusLibraryError('audio','未获得有效音频');audio=result;return {status:'generated'};}
      if(!audio)throw focusLibraryError('audio','文字或音色已变化，请先生成并试听');
      const result=await save(scope,clip,audio,{expectedRevision:initial.revision||0,isCurrent:valid});
      if(result.status==='saved'){initial=result.clip;draft={...result.clip};}return result;
    }finally{if(ticket===epoch)busy=false;}
  }
  return {snapshot,update,generate:()=>run('generate'),save:()=>run('save'),close(){closed=true;epoch++;audio=null;}};
}
