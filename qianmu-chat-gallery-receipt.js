import {chatCharacterReceiptError,chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';

export const CHAT_GALLERY_RECEIPT_LIMITS=Object.freeze({bytes:2*1024*1024,records:10000,nodes:100000});
const fail=message=>{throw chatCharacterReceiptError('content',message,400);};
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const keys=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&Object.keys(value).every(key=>fields.includes(key));

// Hash the complete existing records, including unknown future fields. The response
// carries only a count/digest, never prompts, URLs, image data or other chat metadata.
export function chatGalleryReceiptText(value){
  if(value===undefined)return null;
  if(!Array.isArray(value)||value.length>CHAT_GALLERY_RECEIPT_LIMITS.records)fail('聊天静帧记录格式或数量不支持，未裁剪资料');
  let nodes=0,characters=0;const seen=new Set();
  const quote=value=>{const text=JSON.stringify(value);characters+=text.length;if(characters>CHAT_GALLERY_RECEIPT_LIMITS.bytes)fail('聊天静帧资料超过核验上限，请保全原件');return text;};
  const canonical=(item,depth=0)=>{
    if(++nodes>CHAT_GALLERY_RECEIPT_LIMITS.nodes||depth>32)fail('聊天静帧资料结构过大，请保留原件');
    if(item&&typeof item==='object'){
      if(seen.has(item))fail('聊天静帧资料存在循环引用');seen.add(item);
      let text;
      if(Array.isArray(item)){
        const fields=Object.keys(item);
        if(fields.length!==item.length||fields.some((key,index)=>key!==String(index)))fail('聊天静帧资料包含不完整数组');
        text='['+item.map(row=>canonical(row,depth+1)).join(',')+']';
      }else{
        if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)fail('聊天静帧资料不是普通 JSON');
        text='{'+Object.keys(item).sort().map(key=>quote(key)+':'+canonical(item[key],depth+1)).join(',')+'}';
      }
      seen.delete(item);return text;
    }
    if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return quote(item);
    fail('聊天静帧资料不是可核验的 JSON');
  };
  for(const row of value)if(!object(row))fail('聊天静帧条目不完整，不能确认来源');
  const text=canonical(value),bytes=new TextEncoder().encode(text).byteLength;
  if(bytes>CHAT_GALLERY_RECEIPT_LIMITS.bytes)fail('聊天静帧资料超过核验上限，请保全原件');
  return {text,count:value.length,bytes};
}

export function chatGalleryReceiptResponse(value){
  if(!keys(value,['ok','version','expectedAccount','target','state','gallery','proof'])||value.ok!==true||value.version!==1
    ||typeof value.expectedAccount!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value.expectedAccount)
    ||!['absent','present'].includes(value.state)||value.proof!=='read-only-snapshot')fail('聊天静帧核验返回不兼容');
  const target=chatCharacterReceiptTarget(value.target),row=value.gallery;
  if(value.state==='absent'){if(row!==null)fail('聊天静帧空记录回执不一致');}
  else if(!keys(row,['count','bytes','sha256'])||!Number.isSafeInteger(row.count)||row.count<0||row.count>CHAT_GALLERY_RECEIPT_LIMITS.records
    ||!Number.isSafeInteger(row.bytes)||row.bytes<2||row.bytes>CHAT_GALLERY_RECEIPT_LIMITS.bytes||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))fail('聊天静帧核验摘要无效');
  return {...value,target,gallery:row?{...row}:null};
}
