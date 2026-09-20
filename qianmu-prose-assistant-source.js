import {captureCurrentChatSource} from './qianmu-current-chat-source.js';

export const PROSE_ASSISTANT_SOURCE_LIMIT=200000;
const fail=message=>{throw Object.assign(new Error(message),{code:'prose_assistant_source'});};
const text=value=>typeof value==='string'&&value.length<=PROSE_ASSISTANT_SOURCE_LIMIT&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const split=(value,at)=>value.charCodeAt(at-1)>=0xd800&&value.charCodeAt(at-1)<=0xdbff&&value.charCodeAt(at)>=0xdc00&&value.charCodeAt(at)<=0xdfff;

export const isProseAssistantOffstage=context=>Boolean(context&&typeof context==='object'&&!Array.isArray(context)&&(context.chatId===undefined||context.chatId===null||context.chatId===''));
function captureOffstage({getContext,epoch}){
  if(typeof getContext!=='function'||typeof epoch!=='function'||!isProseAssistantOffstage(getContext()))fail('场外会话来源无效');
  const revision=epoch();if(!Number.isSafeInteger(revision)||revision<0)fail('场外会话来源无效');let closed=false;
  return {source:{ownerKey:'offstage'},target:null,integrity:null,
    assertCurrent(){if(closed||epoch()!==revision||!isProseAssistantOffstage(getContext())){closed=true;fail('场外会话来源已变化');}return true;},close(){closed=true;}};
}

// Host namespaces contain the exact account handle, not an already hashed ID.
// Match the existing collection account digest without trimming or guessing.
export async function proseAssistantAccountForNamespace(namespace,{cryptoImpl=globalThis.crypto}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||!text(namespace))fail('尚未确认场外特助账户');
  if(!cryptoImpl?.subtle?.digest)fail('助手历史需要通过 HTTPS 或本机 localhost 打开 ST');
  try{const bytes=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(namespace.slice(8))));if(bytes.length!==32)throw Error();return 'st-user:'+Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');}
  catch(_){fail('助手账户摘要未能确认，请稍后重试');}
}

// Panel/history lifetime follows the chat, not one rendered message. Opening a
// conversation does not read prose; each send captures its own bounded snapshot.
export async function captureProseAssistantChatSource({getContext,epoch,resolveNamespace,isCurrent,signal,cryptoImpl=globalThis.crypto}={}){
  if(typeof resolveNamespace!=='function'||typeof isCurrent!=='function')fail('场外特助聊天来源尚未就绪');
  const offstage=isProseAssistantOffstage(getContext()),source=offstage?captureOffstage({getContext,epoch}):captureCurrentChatSource({getContext,epoch});let closed=false,namespace;
  const close=()=>{closed=true;source.close();signal?.removeEventListener('abort',close);};
  function assertCurrent(){try{if(closed||signal?.aborted||isCurrent()!==true)fail('场外特助聊天已变化');return source.assertCurrent();}catch(cause){close();throw cause;}}
  async function guard(){try{assertCurrent();const actual=await resolveNamespace();assertCurrent();if(actual!==namespace)fail('场外特助账户已变化');return true;}catch(cause){close();throw cause;}}
  try{
    signal?.addEventListener('abort',close,{once:true});assertCurrent();namespace=await resolveNamespace();assertCurrent();
    const account=await proseAssistantAccountForNamespace(namespace,{cryptoImpl});await guard();
    const scope=Object.freeze({namespace:account,ownerKey:source.source.ownerKey,target:source.target,integrity:source.integrity,offstage});
    const key=JSON.stringify(offstage?['qianmu-prose-assistant-offstage-v1',account]:['qianmu-prose-assistant-v2',account,scope.ownerKey,scope.target,scope.integrity]);
    return Object.freeze({scope,key,guard,assertCurrent,close});
  }catch(cause){close();throw cause;}
}

// A borrowed source lifetime, not a permanent chat ID, an API choice, or authority
// to read other floors. The host supplies rendered plain text only on explicit use.
export async function captureProseAssistantSource({getContext,epoch,resolveNamespace,isCurrent,readText,floor,range,signal,cryptoImpl=globalThis.crypto}={}){
  if(typeof resolveNamespace!=='function'||typeof isCurrent!=='function'||typeof readText!=='function'||!Number.isSafeInteger(floor)||floor<0)fail('场外特助缺少明确的账户、楼层或页面来源');
  const source=captureCurrentChatSource({getContext,epoch});let closed=false,message,raw,swipe,namespace;
  const close=()=>{closed=true;source.close();signal?.removeEventListener('abort',close);message=null;raw=null;};
  function assertCurrent(){
    try{
      if(closed||signal?.aborted||isCurrent()!==true)fail('场外特助页面已关闭或切换');source.assertCurrent();
      if(message&&(getContext().chat[floor]!==message||message.mes!==raw||(message.swipe_id??0)!==swipe||message.is_system))fail('引用楼层已编辑、换回复或移除，请重新选择');
      return true;
    }catch(cause){close();throw cause;}
  }
  async function guard(){
    try{assertCurrent();const current=await resolveNamespace();assertCurrent();if(current!==namespace)fail('场外特助账户已变化，请重新打开');return true;}
    catch(cause){close();throw cause;}
  }
  try{
    signal?.addEventListener('abort',close,{once:true});
    assertCurrent();message=getContext().chat[floor];
    if(!message||message.is_system||typeof message.mes!=='string')fail('此楼层没有可引用的正文');
    raw=message.mes;swipe=message.swipe_id??0;if(!Number.isSafeInteger(swipe)||swipe<0)fail('当前回复编号无效');
    namespace=await resolveNamespace();assertCurrent();
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||!text(namespace))fail('尚未确认场外特助账户');
    const account=await proseAssistantAccountForNamespace(namespace,{cryptoImpl});await guard();
    const body=readText(message,floor);assertCurrent();if(!text(body)||!body.trim())fail('引用正文为空、过长或编码无效，未截断原文');
    const selected=range!==undefined;
    if(selected&&(!range||typeof range!=='object'||Array.isArray(range)||Object.keys(range).length!==2||!Object.hasOwn(range,'start')||!Object.hasOwn(range,'end')))fail('请选择明确的正文区间');
    const start=selected?range.start:0,end=selected?range.end:body.length;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>body.length||split(body,start)||split(body,end))fail('引用区间无效或截断完整字符');
    const quote=body.slice(start,end);if(!quote.trim())fail('引用区间没有正文');await guard();
    const scope=Object.freeze({namespace:account,ownerKey:source.source.ownerKey,target:source.target,integrity:source.integrity});
    const reference=Object.freeze({floor,replyId:`swipe:${swipe}`,mode:selected?'selection':'floor',range:Object.freeze({start,end}),text:quote});
    // Tuple encoding avoids delimiter collisions. Display names and floor numbers
    // do not merge/split the independent, account-and-chat-scoped conversation.
    // v1 could confuse a literal hex account handle with a digest. Leave those
    // records untouched; never automatically adopt their ambiguous ownership.
    const key=JSON.stringify(['qianmu-prose-assistant-v2',account,scope.ownerKey,scope.target,scope.integrity]);
    return Object.freeze({scope,key,reference,guard,assertCurrent,close});
  }catch(cause){close();throw cause;}
}
