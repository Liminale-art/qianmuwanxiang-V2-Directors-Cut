import {captureProseAssistantChatSource} from './qianmu-prose-assistant-source.js';
import {chatFileTarget} from './qianmu-chat-file-target.js';
import {parseBoundedJson} from './qianmu-json-input.js';

const fail=()=>{throw Error('助手历史改名接续未确认，原记录保留。');};
const route='/api/files/sanitize-filename';
// This utility reads ST's canonical filename only; it never renames a file.
async function canonicalName(value,{headers,fetchImpl,signal,guard}){
 if(typeof value!=='string'||!value.endsWith('.jsonl')||value.length>4096||/[\u0000-\u001f\u007f]/.test(value))fail();
 const supplied=new Headers(await headers?.());await guard();
 const requestHeaders={'Content-Type':'application/json',Accept:'application/json'};
 if(supplied.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=supplied.get('x-csrf-token');
 const response=await fetchImpl(route,{method:'POST',headers:requestHeaders,body:JSON.stringify({fileName:value}),credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 let reader,cancel;
 try{
  await guard();if(!response.ok||response.redirected||response.type==='opaqueredirect'||!/^application\/json\b/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>4096)fail();
  if(response.url){const url=new URL(response.url);if(url.pathname!==route||url.search||url.hash||url.username||url.password||!['http:','https:'].includes(url.protocol)||globalThis.location?.origin&&url.origin!==globalThis.location.origin)fail();}
  reader=response.body?.getReader();if(!reader)fail();cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});let raw='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
  while(true){const part=await reader.read();await guard();if(part.done)break;size+=part.value.byteLength;if(size>4096)fail();raw+=decoder.decode(part.value,{stream:true});}
  raw+=decoder.decode();const data=parseBoundedJson(raw,{maxBytes:4096,maxDepth:2,maxNodes:8,label:'聊天名称'});
  if(!data||Object.keys(data).length!==1||typeof data.fileName!=='string'||!data.fileName.endsWith('.jsonl'))fail();return data.fileName.slice(0,-6);
 }finally{if(reader){signal.removeEventListener('abort',cancel);try{void reader.cancel().catch(()=>{});reader.releaseLock();}catch{}}else try{void response.body?.cancel().catch(()=>{});}catch{}}
}

// Listen to completed ST renames, not guessed name similarities or chat changes.
// Only the exact currently reloaded destination is eligible. Foreign/unopened
// chats are untouched. No scans, model requests, metadata writes or alias IDs.
export function createProseAssistantRenameCoordinator({getContext,resolveNamespace,isCurrent,headers,notify,fetchImpl=globalThis.fetch,
 copy=async options=>(await import('./qianmu-prose-assistant-native.js?v=1.59.369')).copyRenamedProseAssistantHistory(options),timeoutMs=15000}={}){
 let eventSource=null,eventType=null,remove=null,closed=false,epoch=0,pending=null,controller=null,failed=null;
 const current=()=>!closed&&isCurrent()===true;
 async function renamed(event,expectedKey){
  if(!current())return;
  const context=getContext(),group=event?.groupId!==undefined&&event.groupId!==null&&event.groupId!=='';
  if(!event||typeof event.oldFileName!=='string'||!event.oldFileName.endsWith('.jsonl')||typeof event.newFileName!=='string')return;
  if(group?String(context.groupId)!==String(event.groupId):context.groupId!==undefined&&context.groupId!==null&&context.groupId!==''||context.characters?.[context.characterId]?.avatar!==event.avatarId)return;
  // A foreign chat renamed from the history list leaves the current chat alone.
  if(event.oldFileName===context.chatId+'.jsonl')return;
  if(pending){notify?.('助手历史改名接续尚未结束；原记录保留，请先核对。','warning');return;}
  const revision=epoch,aborter=new AbortController();controller=aborter;
  const live=()=>current()&&epoch===revision&&!aborter.signal.aborted;
  let source,timer,eligible=event.newFileName===context.chatId+'.jsonl';
  const work=async()=>{
   source=await captureProseAssistantChatSource({getContext,epoch:()=>epoch,resolveNamespace,isCurrent:live,signal:aborter.signal});
   if(expectedKey!==undefined&&source.key!==expectedKey)fail();
   const guard=async()=>{if(!live()||source.assertCurrent()!==true||await source.guard()!==true||!live())fail();return true;};
   const target=source.scope.target;if(!target||target.kind!==(group?'group':'character'))return;
   const oldChatId=event.oldFileName.slice(0,-6);chatFileTarget({...target,chatId:oldChatId});
   const exact=event.newFileName===target.chatId+'.jsonl';
   if(!exact){let alreadyCanonical=false;try{alreadyCanonical=event.newFileName.endsWith('.jsonl')&&Boolean(chatFileTarget({...target,chatId:event.newFileName.slice(0,-6)}));}catch{}if(alreadyCanonical)return;}
   const newChatId=exact?target.chatId:await canonicalName(event.newFileName,{headers,fetchImpl,signal:aborter.signal,guard});
   await guard();if(newChatId!==target.chatId||oldChatId===newChatId)return;
   eligible=true;
   const result=await copy({source,oldChatId,isCurrent:live});await guard();
   if(failed?.key===source.key)failed=null;
   if(result.status==='existing')notify?.('改名后的聊天已有特助记录，已保留双方记录，未自动合并。','warning');
  };
  let rejectTimeout;const stopped=new Promise((_,reject)=>{rejectTimeout=reject;});
  const onAbort=()=>rejectTimeout(Error('助手改名接续停止'));aborter.signal.addEventListener('abort',onAbort,{once:true});
  const abort=()=>aborter.abort();
  timer=setTimeout(abort,Number.isFinite(timeoutMs)?Math.max(100,Math.min(30000,timeoutMs)):15000);
  const task=Promise.race([work(),stopped]).catch(()=>{if(current()&&epoch===revision){if(eligible&&source)failed={key:source.key,event:{avatarId:event.avatarId,groupId:event.groupId,oldFileName:event.oldFileName,newFileName:event.newFileName}};notify?.('助手历史改名接续未确认，原记录保留；请勿清理旧文件。','warning');}})
   .finally(()=>{clearTimeout(timer);aborter.abort();aborter.signal.removeEventListener('abort',onAbort);source?.close();if(pending===task)pending=null;if(controller===aborter)controller=null;});
  pending=task;await task;
 }
 const handler=event=>renamed(event).catch(()=>{if(current())notify?.('助手历史改名接续未确认，原记录保留。','warning');});
 return Object.freeze({refresh(){
  if(!current()||typeof getContext!=='function')return;const context=getContext(),next=context?.eventSource,type=context?.eventTypes?.CHAT_RENAMED||'chat_renamed';
  if(next===eventSource&&type===eventType)return;
  if(eventSource)remove?.call(eventSource,eventType,handler);epoch++;controller?.abort();eventSource=null;
  const off=next?.removeListener||next?.off;if(typeof next?.on!=='function'||typeof off!=='function')return;
  eventSource=next;eventType=type;remove=off;next.on(type,handler);
 },async settled(source){
  if(pending)await pending;
  else if(source&&failed?.key===source.key){source.assertCurrent();await source.guard();await renamed(failed.event,source.key);}
  if(source&&failed?.key===source.key)throw Object.assign(Error('改名后的特助记录尚未接续，原记录保留。请点重新读取重试。'),{code:'prose_assistant_history_rename'});
 },close(){closed=true;epoch++;controller?.abort();failed=null;if(eventSource)remove?.call(eventSource,eventType,handler);eventSource=null;}});
}
