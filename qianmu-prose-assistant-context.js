import {captureProseAssistantSource,captureProseAssistantChatSource,isProseAssistantOffstage,PROSE_ASSISTANT_SOURCE_LIMIT} from './qianmu-prose-assistant-source.js';

// UTF-16 character budgets, not token estimates or promises about any model's window.
export const PROSE_ASSISTANT_CONTEXT_LIMITS=Object.freeze({defaultPreviousFloors:2,maxPreviousFloors:8,previousCharacters:16000,historyPairs:6,historyCharacters:12000});
const fail=message=>{throw Object.assign(new Error(message),{code:'prose_assistant_context'});};
const validText=value=>typeof value==='string'&&value.length<=PROSE_ASSISTANT_SOURCE_LIMIT&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;

// Data only. Prompts/API routing belong to later consumers, never to source capture.
export async function captureProseAssistantContext(options={}){
  const {previousFloors=PROSE_ASSISTANT_CONTEXT_LIMITS.defaultPreviousFloors,history,getContext,readText}=options;
  const limits=PROSE_ASSISTANT_CONTEXT_LIMITS;
  if(options.referenceFloors!==undefined&&(!Number.isSafeInteger(options.referenceFloors)||options.referenceFloors<0||options.referenceFloors>limits.maxPreviousFloors+1))fail('场外特助参考范围无效');
  const noReference=options.referenceFloors===0||isProseAssistantOffstage(getContext());
  if(!Number.isSafeInteger(previousFloors)||previousFloors<0||previousFloors>limits.maxPreviousFloors)fail('场外特助前文范围无效');
  const source=await (noReference?captureProseAssistantChatSource(options):captureProseAssistantSource(options)),tracked=[];let closed=false;
  const close=()=>{closed=true;tracked.length=0;source.close();};
  function assertCurrent(){
    try{
      if(closed)fail('场外特助引用已关闭');source.assertCurrent();
      for(const row of tracked){const current=getContext().chat[row.floor];
        if(current!==row.message||current.mes!==row.raw||(current.swipe_id??0)!==row.swipe||Boolean(current.is_user)!==row.user||Boolean(current.is_system)!==row.system)fail('参考前文已变化，请重新打开助手');
      }return true;
    }catch(cause){close();throw cause;}
  }
  async function guard(){try{assertCurrent();await source.guard();assertCurrent();return true;}catch(cause){close();throw cause;}}
  try{
    const previous=[],omitted=[];let previousCharacters=0,historyCharacters=0;const first=noReference?0:Math.max(0,source.reference.floor-previousFloors);
    // Inspect at most the explicit preceding window, never search older floors to fill gaps.
    for(let floor=noReference?-1:source.reference.floor-1;floor>=first;floor--){
      assertCurrent();const message=getContext().chat[floor];if(!message||typeof message.mes!=='string')fail('参考前文来源无效');
      const row={floor,message,raw:message.mes,swipe:message.swipe_id??0,user:Boolean(message.is_user),system:Boolean(message.is_system)};
      tracked.push(row);if(!Number.isSafeInteger(row.swipe)||row.swipe<0)fail('参考前文回复编号无效');
      if(row.system){omitted.push(Object.freeze({floor,reason:'system'}));continue;}
      const text=readText(message,floor);assertCurrent();if(!validText(text))fail('参考前文编码无效或过长，未截断原文');
      const reason=!text.trim()?'empty':previousCharacters+text.length>limits.previousCharacters?'budget':null;
      if(reason){omitted.push(Object.freeze({floor,reason}));continue;}
      previousCharacters+=text.length;previous.push(Object.freeze({floor,replyId:`swipe:${row.swipe}`,role:row.user?'user':'character',text}));
    }
    previous.reverse();omitted.reverse();const pairs=[];let historyCount=0;
    if(history!==undefined){
      if(!history||history.key!==source.key||!Array.isArray(history.turns)||history.turns.length>10000)fail('场外特助历史不属于当前会话或超出容量');
      historyCount=history.turns.length;
      for(let index=historyCount-1;index>=Math.max(0,historyCount-limits.historyPairs);index--){
        const pair=history.turns[index];if(!pair||!validText(pair.user)||!pair.user.trim()||!validText(pair.assistant)||!pair.assistant.trim())fail('场外特助历史须为完整的问答');
        const size=pair.user.length+pair.assistant.length;if(historyCharacters+size>limits.historyCharacters)break;
        historyCharacters+=size;pairs.push(Object.freeze({user:pair.user,assistant:pair.assistant}));
      }
    }
    pairs.reverse();await guard();
    const summary=Object.freeze({referenceFloor:source.reference?.floor??null,referenceMode:source.reference?.mode??'none',referenceCharacters:source.reference?.text.length??0,
      previousWindow:Object.freeze({start:first,end:source.reference?.floor??0}),previousIncluded:Object.freeze(previous.map(row=>row.floor)),previousOmitted:Object.freeze(omitted),previousCharacters,
      historyPairs:pairs.length,historyOmitted:historyCount-pairs.length,historyCharacters});
    return Object.freeze({key:source.key,scope:source.scope,reference:source.reference??null,previous:Object.freeze(previous),history:Object.freeze(pairs),summary,guard,assertCurrent,close});
  }catch(cause){close();throw cause;}
}
