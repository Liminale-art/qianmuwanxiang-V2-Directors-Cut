import {sha256} from './vendor/noble-hashes-2.4.0/sha2.js';
import {chatGalleryReceiptRecordText,CHAT_GALLERY_STREAM_LIMITS as LIMIT} from './qianmu-chat-gallery-receipt.js';
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS} from './qianmu-gallery-page-index.js';
const utf8=new TextEncoder(),hex=bytes=>Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
const fail=message=>{throw Object.assign(Error(message),{code:'chat_gallery_digest'});};
export function galleryDigestRecord(raw){
  const value=captureGalleryArchiveJson(raw,GALLERY_PAGE_INDEX_LIMITS.recordBytes),summary=chatGalleryReceiptRecordText(value);
  const encoded=utf8.encode(summary.text);
  return {value,...summary,sha256:hex(sha256(encoded)),encoded};
}
export function galleryDigestRows(rows){
  if(!Array.isArray(rows)||rows.length>LIMIT.records)fail('聊天图库不是完整数组或数量超限');
  const keys=Reflect.ownKeys(rows);
  if(keys.length!==rows.length+1||keys.some((key,index)=>index===rows.length?key!=='length':key!==String(index)))fail('聊天图库包含空项或额外字段');
  return rows.length;
}
export function galleryDigestRow(rows,index){
  const descriptor=Object.getOwnPropertyDescriptor(rows,String(index));
  if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))fail('聊天图库含隐藏项或访问器，未读取');
  return descriptor.value;
}
export function createChatGalleryDigest(){
  const hash=sha256.create();hash.update(utf8.encode('['));let count=0,bytes=2,nodes=1,closed=false;
  function close(){closed=true;hash.destroy();}
  return Object.freeze({
    append(raw){
      if(closed)fail('图库摘要已结束');
      try{
        const record=galleryDigestRecord(raw);bytes+=record.bytes+(count?1:0);nodes+=record.nodes;
        if(count>=LIMIT.records||bytes>LIMIT.bytes||nodes>LIMIT.nodes)fail('图库超过分批核验范围，未裁剪原件');
        if(count)hash.update(utf8.encode(','));hash.update(record.encoded);count++;return record;
      }catch(error){close();throw error;}
    },
    finish(){if(closed)fail('图库摘要已结束');try{hash.update(utf8.encode(']'));return {count,bytes,sha256:hex(hash.digest())};}finally{close();}},close,
  });
}
// For legacy synchronous guards: still bounded per record, never a full-gallery
// string/clone. Idle preservation uses the yielding scanner below instead.
export function chatGalleryDigest(rows){
  if(rows===undefined)return null;const length=galleryDigestRows(rows),state=createChatGalleryDigest();
  try{for(let i=0;i<length;i++)state.append(galleryDigestRow(rows,i));return state.finish();}finally{state.close();}
}
export async function scanChatGallery(rows,{guard=()=>{},yieldWork=async()=>{},visit=()=>{}}={}){
  const length=galleryDigestRows(rows),state=createChatGalleryDigest();let workBytes=0;
  function check(){guard();if(rows.length!==length)fail('图库条数在核验时变化');}
  try{
    check();for(let index=0;index<length;index++){
      if(index%16===0||workBytes>=128*1024){check();await new Promise(resolve=>setTimeout(resolve,0));check();await yieldWork();check();workBytes=0;}
      const record=state.append(galleryDigestRow(rows,index));workBytes+=record.bytes;visit(record,index);check();
    }
    galleryDigestRows(rows);check();return state.finish();
  }finally{state.close();}
}
