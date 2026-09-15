import {normalizeChatCharacterCollection,CHAT_CHARACTER_COLLECTION_LIMITS} from './qianmu-character-chat-batch.js';

export const CHAT_CHARACTER_RECEIPT_LIMITS=Object.freeze({headerBytes:2*1024*1024,responseBytes:2048,pending:4});
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const keys=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&Object.keys(value).every(key=>fields.includes(key));
const account=value=>typeof value==='string'&&/^st-user:[a-f0-9]{64}$/.test(value);
export const chatCharacterReceiptError=(code,message,status=409)=>Object.assign(new Error(message),{code:`chat_character_receipt_${code}`,status});
const fail=message=>{throw chatCharacterReceiptError('contract',message,400);};
function basename(value,max=250){
  if(typeof value!=='string'||!value||value!==value.trim()||/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value)||/[. ]$/.test(value)
    ||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)||new TextEncoder().encode(value).byteLength>max
    ||new TextDecoder().decode(new TextEncoder().encode(value))!==value)fail('聊天定位无效，请重新打开目标聊天');
  return value;
}
export function chatCharacterReceiptTarget(value){
  if(!object(value)||!['character','group'].includes(value.kind)||!keys(value,value.kind==='character'?['kind','chatId','avatar']:['kind','chatId']))fail('请指定准确的单聊或群聊');
  const target={kind:value.kind,chatId:basename(value.chatId,249)};
  if(value.kind==='character'){
    target.avatar=basename(value.avatar);
    if(!target.avatar.endsWith('.png'))fail('角色文件格式不兼容，请重新核对聊天');
    basename(target.avatar.replace('.png','')); // Match ST's exact folder rule; never sanitize into a different chat.
  }
  return target;
}
export function chatCharacterReceiptRequest(value){
  if(!keys(value,['version','expectedAccount','target'])||value.version!==1||!account(value.expectedAccount))fail('聊天核验请求版本或账户无效');
  return {version:1,expectedAccount:value.expectedAccount,target:chatCharacterReceiptTarget(value.target)};
}
// Hash all persisted fields, not only the known projection: extra/future data cannot silently compare equal.
export function chatCharacterCollectionReceiptText(value,owner){
  const normalized=normalizeChatCharacterCollection(value,owner);let nodes=0;
  const canonical=(item,depth=0)=>{
    if(++nodes>50000||depth>32)fail('聊天人物资料结构过大，请保全原数据');
    if(Array.isArray(item))return '['+item.map(row=>canonical(row,depth+1)).join(',')+']';
    if(object(item))return '{'+Object.keys(item).sort().map(key=>JSON.stringify(key)+':'+canonical(item[key],depth+1)).join(',')+'}';
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return JSON.stringify(item);
    fail('聊天人物资料不是可核验的 JSON');
  };
  const text=canonical(value),bytes=new TextEncoder().encode(text).byteLength;
  if(bytes>CHAT_CHARACTER_COLLECTION_LIMITS.bytes)fail('聊天人物资料超过核验上限，请保全原数据');
  return {text,bytes,revision:normalized.revision,count:normalized.items.length};
}
export function chatCharacterReceiptResponse(value){
  if(!keys(value,['ok','version','expectedAccount','target','state','collection','proof'])||value.ok!==true||value.version!==1||!account(value.expectedAccount)
    ||!['absent','present'].includes(value.state)||value.proof!=='read-only-snapshot')fail('聊天核验返回不兼容');
  const target=chatCharacterReceiptTarget(value.target),row=value.collection;
  if(value.state==='absent'){if(row!==null)fail('空记录回执不一致');}
  else if(!keys(row,['revision','count','bytes','sha256'])||!Number.isSafeInteger(row.revision)||row.revision<0||!Number.isInteger(row.count)||row.count<0||row.count>256
    ||!Number.isInteger(row.bytes)||row.bytes<1||row.bytes>CHAT_CHARACTER_COLLECTION_LIMITS.bytes||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))fail('聊天人物核验摘要无效');
  return {...value,target,collection:row?{...row}:null};
}
export function chatCharacterReceiptErrorPayload(error){
  const known=typeof error?.code==='string'&&/^chat_character_receipt_[a-z_]+$/.test(error.code);
  return {status:known&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503,
    body:{ok:false,version:1,code:known?error.code:'chat_character_receipt_storage',message:known?error.message:'聊天记录暂未核验，请保留现有资料后重试'}};
}
