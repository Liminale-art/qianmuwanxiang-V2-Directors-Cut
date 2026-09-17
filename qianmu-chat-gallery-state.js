import {chatCharacterReceiptError,chatCharacterCollectionReceiptText} from './qianmu-chat-character-receipt.js';
import {chatGalleryEvidenceRequest} from './qianmu-chat-gallery-evidence.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {parseBoundedJson} from './qianmu-json-input.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const CHAT_GALLERY_STATE_LIMITS=Object.freeze({bytes:2*1048576,responseBytes:2*1048576+16384});
const fields=['storyboardImages','storyboardCollections','characterDrafts'];
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const exact=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw chatCharacterReceiptError('state_content','原聊天分镜资料不兼容、含连接凭据或超过读取范围，未截断或猜补资料');};
export const chatGalleryStateRequest=chatGalleryEvidenceRequest;

// Only these fields really live in this saved chat. Global imagegen settings,
// model defaults, shared libraries and host CHAR/USER cards are NOT historical originals.
// Missing fields stay missing, and future fields inside an original are retained.
export async function projectChatGalleryState(store,owner){
  if(!object(store)||!Object.hasOwn(store,'storyboardImages'))fail();
  const selected=Object.fromEntries(fields.filter(name=>Object.hasOwn(store,name)).map(name=>[name,store[name]]));
  let saved;
  try{
    saved=parseBoundedJson(JSON.stringify(selected),{maxBytes:CHAT_GALLERY_STATE_LIMITS.bytes,maxDepth:40,maxNodes:100000,label:'聊天分镜原件'});
    chatGalleryReceiptText(saved.storyboardImages);
    if(Object.hasOwn(saved,'storyboardCollections'))chatGalleryReceiptText(saved.storyboardCollections);
    if(Object.hasOwn(saved,'characterDrafts'))chatCharacterCollectionReceiptText(saved.characterDrafts,owner);
    await assertPortableStoryboardData(saved);
  }catch{fail();}
  return saved;
}

export async function chatGalleryStateResponse(value,{namespace}={}){
  if(!exact(value,['ok','version','expectedAccount','target','gallerySha256','source','saved','sha256','proof'])||value.ok!==true||value.proof!=='read-only-chat-state'
    ||!exact(value.source,['kind','bytes','sha256'])||value.source.kind!=='jsonl-header'||!Number.isSafeInteger(value.source.bytes)||value.source.bytes<1||value.source.bytes>CHAT_GALLERY_STATE_LIMITS.bytes
    ||!hash(value.source.sha256)||!hash(value.sha256)||!object(value.saved)||Object.keys(value.saved).some(name=>!fields.includes(name))
    ||typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail();
  const request=chatGalleryStateRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,gallerySha256:value.gallerySha256});
  if('st-user:'+await vibeDigest(namespace.slice(8))!==value.expectedAccount)fail();
  const saved=await projectChatGalleryState(value.saved,{namespace,chatKey:request.target.chatId});
  if(await vibeDigest(chatGalleryReceiptText(saved.storyboardImages).text)!==request.gallerySha256
    ||await vibeDigest(JSON.stringify(saved))!==value.sha256
    ||new TextEncoder().encode(JSON.stringify(value)).byteLength>CHAT_GALLERY_STATE_LIMITS.responseBytes)fail();
  return {...value,target:request.target,source:{...value.source},saved};
}
