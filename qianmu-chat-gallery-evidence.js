import {chatCharacterReceiptRequest,chatCharacterReceiptError} from './qianmu-chat-character-receipt.js';
import {inspectStoryboardChatEvidence} from './qianmu-storyboard-chat-evidence.js';

export const CHAT_GALLERY_EVIDENCE_LIMITS=Object.freeze({fileBytes:128*1048576,headerBytes:64*1048576,lineBytes:2*1048576,responseBytes:24*1048576,messages:100000,durationMs:30000});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw chatCharacterReceiptError('evidence_contract','历史正文来源请求或返回不完整，未采用猜测的楼层',400);};
export function chatGalleryEvidenceRequest(value){
  if(!exact(value,['version','expectedAccount','target','gallerySha256'])||!hash(value.gallerySha256))fail();
  const base=chatCharacterReceiptRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target});
  return {...base,gallerySha256:value.gallerySha256};
}
export async function chatGalleryEvidenceResponse(value){
  if(!exact(value,['ok','version','expectedAccount','target','gallerySha256','source','chatEvidence','proof'])||value.ok!==true||value.proof!=='read-only-chat-evidence'
    ||!exact(value.source,['bytes','sha256'])||!Number.isSafeInteger(value.source.bytes)||value.source.bytes<1||value.source.bytes>CHAT_GALLERY_EVIDENCE_LIMITS.fileBytes||!hash(value.source.sha256))fail();
  const base=chatGalleryEvidenceRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,gallerySha256:value.gallerySha256});
  const chatEvidence=await inspectStoryboardChatEvidence(value.chatEvidence,base.target.chatId);
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>CHAT_GALLERY_EVIDENCE_LIMITS.responseBytes)fail();
  return {...value,target:base.target,source:{...value.source},chatEvidence};
}
// Separate endpoint keeps the old v1 wire response unchanged. This optional
// exact first-line digest binds independently saved companion data to evidence.
export async function chatGalleryEvidenceSourceResponse(value){
  if(!exact(value,['ok','version','expectedAccount','target','gallerySha256','source','header','chatEvidence','proof'])
    ||!exact(value.header,['bytes','sha256'])||!Number.isSafeInteger(value.header.bytes)||value.header.bytes<1
    ||value.header.bytes>CHAT_GALLERY_EVIDENCE_LIMITS.headerBytes||!hash(value.header.sha256)||value.header.bytes>value.source?.bytes)fail();
  const {header,...raw}=value,checked=await chatGalleryEvidenceResponse(raw);
  if(new TextEncoder().encode(JSON.stringify(value)).length>CHAT_GALLERY_EVIDENCE_LIMITS.responseBytes)fail();return {...checked,header:{...header}};
}
