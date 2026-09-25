import {chatCharacterReceiptError} from './qianmu-chat-character-receipt.js';
import {chatGalleryEvidenceRequest} from './qianmu-chat-gallery-evidence.js';
import {chatGalleryReceiptSummary,CHAT_GALLERY_STREAM_LIMITS} from './qianmu-chat-gallery-receipt.js';
import {projectChatGalleryState} from './qianmu-chat-gallery-state.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {GALLERY_SUPPLEMENT_FIELDS,GALLERY_CONTINUITY_FIELDS,projectGalleryContinuity} from './qianmu-gallery-continuity.js?v=1.59.382';
import {parseBoundedJson} from './qianmu-json-input.js';

// The gallery bodies are already preserved as separate immutable records. This
// endpoint carries only original ordering and the chat-owned companion fields.
// Old /state remains unchanged; neither endpoint claims durable preservation.
// Response budget also covers 10k existing IDs of 240 UTF-16 units (including
// non-ASCII IDs), plus the separate 2 MiB supplement. It contains no image bodies.
export const CHAT_GALLERY_SUPPLEMENT_LIMITS=Object.freeze({bytes:2*1048576,responseBytes:10*1048576,headerBytes:64*1048576,records:CHAT_GALLERY_STREAM_LIMITS.records});
const fields=GALLERY_SUPPLEMENT_FIELDS;
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw chatCharacterReceiptError('supplement_content','分镜补充资料、画面顺序或来源不兼容，未截断或猜补');};
export const chatGallerySupplementRequest=chatGalleryEvidenceRequest;
export async function projectChatGallerySupplement(value,owner){
  if(!object(value)||Object.keys(value).some(key=>!fields.includes(key)))fail();
  try{
    // Reuse the existing ownership, portability and unknown-field validation,
    // without embedding another copy of every image record in the response.
    const captured=parseBoundedJson(JSON.stringify(value),{maxBytes:CHAT_GALLERY_SUPPLEMENT_LIMITS.bytes,maxDepth:40,maxNodes:100000,label:'分镜补充资料'});
    const {storyboardImages,...saved}=await projectChatGalleryState({storyboardImages:[],...captured},owner);
    const continuity=await projectGalleryContinuity(Object.fromEntries(GALLERY_CONTINUITY_FIELDS.filter(key=>Object.hasOwn(captured,key)).map(key=>[key,captured[key]])),owner);
    return {...saved,...continuity};
  }catch{fail();}
}
export function chatGallerySupplementOrder(value,count){
  if(!Array.isArray(value)||!Number.isSafeInteger(count)||count<0||count>CHAT_GALLERY_SUPPLEMENT_LIMITS.records||value.length!==count
    ||value.some(id=>typeof id!=='string'||!id||id.length>240||/[\u0000-\u001f\u007f]/.test(id))||new Set(value).size!==count)fail();
  return [...value];
}
export const chatGallerySupplementDigest=async(order,saved)=>vibeDigest(JSON.stringify({order,saved}));
export async function chatGallerySupplementResponse(value,{namespace}={}){
  if(!exact(value,['ok','version','expectedAccount','target','gallery','source','saved','order','sha256','proof'])||value.ok!==true||value.proof!=='read-only-chat-supplement'
    ||!exact(value.source,['kind','bytes','sha256'])||value.source.kind!=='jsonl-header'||!Number.isSafeInteger(value.source.bytes)||value.source.bytes<1
    ||value.source.bytes>CHAT_GALLERY_SUPPLEMENT_LIMITS.headerBytes||!hash(value.source.sha256)||!hash(value.sha256)
    ||typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail();
  if(![1,2].includes(value.version)||value.version===1&&GALLERY_CONTINUITY_FIELDS.some(key=>Object.hasOwn(value.saved||{},key)))fail();
  const gallery=chatGalleryReceiptSummary(value.gallery),request=chatGallerySupplementRequest({version:1,expectedAccount:value.expectedAccount,target:value.target,gallerySha256:gallery.sha256});
  if('st-user:'+await vibeDigest(namespace.slice(8))!==request.expectedAccount)fail();
  const order=chatGallerySupplementOrder(value.order,gallery.count),saved=await projectChatGallerySupplement(value.saved,{namespace,chatKey:request.target.chatId});
  if(await chatGallerySupplementDigest(order,saved)!==value.sha256||new TextEncoder().encode(JSON.stringify(value)).length>CHAT_GALLERY_SUPPLEMENT_LIMITS.responseBytes)fail();
  return {...value,target:request.target,gallery,source:{...value.source},saved,order};
}
