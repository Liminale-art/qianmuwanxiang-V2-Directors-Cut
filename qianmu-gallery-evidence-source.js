import {sha256} from './vendor/noble-hashes-2.4.0/sha2.js';
import {projectStoryboardChatMessages,STORYBOARD_CHAT_EVIDENCE_SCHEMA} from './qianmu-storyboard-chat-evidence.js';
import {createStoryboardMessageReference} from './qianmu-storyboard.js';
import {hashText} from './qianmu-storyboard-utils.js';
const utf8=new TextEncoder(),hex=bytes=>Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_evidence_source',writeState:'not_started'});};
const fields=['mes','name','is_user','is_system','swipe_id','original_avatar','send_date'];
function project(rows,index){
  const property=Object.getOwnPropertyDescriptor(rows,String(index));
  if(!property?.enumerable||!Object.hasOwn(property,'value')||!property.value||typeof property.value!=='object'||Array.isArray(property.value))fail('正文依据楼层缺失或为访问器');
  const raw=property.value,copy={};
  for(const key of fields){const field=Object.getOwnPropertyDescriptor(raw,key);
    if(field){if(!Object.hasOwn(field,'value'))fail('正文依据字段不能包含访问器');copy[key]=field.value;}
    else if(key in raw)fail('正文依据字段不能借用继承属性');
  }
  if(typeof copy.mes!=='string')fail('正文依据缺少完整正文，未按空楼层处理');
  return projectStoryboardChatMessages([copy])[0];
}
// Same digest as the existing v1 evidence capture, without keeping every row or
// projecting/copying all narrative text. Bound work by rows and bytes per yield.
export async function scanGalleryEvidenceSource(messages,chatKey,{guard=()=>true,yieldWork=async()=>{}}={}){
  if(!Array.isArray(messages)||messages.length>100000||typeof chatKey!=='string'||!chatKey||chatKey.length>1024||/[\u0000-\u001f\u007f]/.test(chatKey))fail('正文依据范围无效或超过十万层');
  const count=messages.length,state=sha256.create();let bytes=0,workBytes=0;
  function check(){const current=guard();if(current&&typeof current.then==='function')void Promise.resolve(current).catch(()=>{});
    if(current!==true||messages.length!==count)fail('正文依据读取时来源已变化');}
  try{
    check();state.update(utf8.encode(JSON.stringify({schema:STORYBOARD_CHAT_EVIDENCE_SCHEMA,chatKey}).slice(0,-1)+',"messages":['));
    for(let floor=0;floor<count;floor++){
      if(floor%32===0||workBytes>=128*1024){check();await new Promise(resolve=>setTimeout(resolve,0));check();await yieldWork();check();workBytes=0;}
      const message=project(messages,floor),text=JSON.stringify(message),encoded=utf8.encode(text);bytes+=encoded.length;workBytes+=encoded.length;
      if(bytes>128*1048576||encoded.length>2*1048576)fail('正文依据超过完整读取上限，未截断');
      if(new TextDecoder().decode(encoded)!==text)fail('正文依据编码无效');
      const row={floor,sha256:hex(sha256(encoded)),messageHash:hashText(message.mes),revisionHash:createStoryboardMessageReference({message,floor,chatKey,now:1}).revisionHash,swipeId:message.swipe_id};
      // No awaits or caller callbacks within a batch. The yielding boundaries
      // recheck host identity; rescanning every character owner per row is wasteful.
      if(floor)state.update(utf8.encode(','));state.update(utf8.encode(JSON.stringify(row)));
    }
    check();state.update(utf8.encode(']}'));return {count,digest:hex(state.digest())};
  }finally{state.destroy();}
}
