import {validateVibeEncodingReceipt} from './qianmu-vibe-encoding-contract.js';
import {resolveVibeReviewHistory,checkCombinedVibeReviews} from './qianmu-vibe-history.js';
import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {parseBoundedJson} from './qianmu-json-input.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const VIBE_RECEIPT_ORIGINAL_SLOT='vibe-receipt-original';
export const VIBE_RECEIPT_ORIGINAL_LIMITS=Object.freeze({body:8*1048576,manifest:256*1024,part:512*1024,characters:65536,parts:512});
const schema='qianmu.vibe.receipt-original.v1',partSlot='vibe-receipt-part',limits=VIBE_RECEIPT_ORIGINAL_LIMITS;
const bytes=value=>new TextEncoder().encode(value).length,hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>{throw Object.assign(Error(message),{code:'vibe_receipt_original',submissionState:'not_submitted'});};
const exact=(value,keys)=>value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d?.enumerable&&Object.hasOwn(d,'value');});

// Legacy local reviews can contain an explicit undefined delivery; timestamps
// can be fractional or -0. Preserve their exact values and property order,
// not JSON's omission/coercion. Tags live in immutable text, not executable data.
function encode(value){
  const seen=new Set();let count=0;
  function visit(item,depth=0){
    if(++count>200000||depth>24)fail('费用原件结构过大，未截断');
    if(item===undefined)return ['undefined'];
    if(item===null||typeof item==='boolean'||typeof item==='string')return item;
    if(typeof item==='number'){if(!Number.isFinite(item))fail('费用原件数值无效');return Object.is(item,-0)?['negative-zero']:item;}
    if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype)fail('费用原件含不支持的数据');
    const names=Object.keys(item),array=Array.isArray(item);
    if(Reflect.ownKeys(item).length!==names.length+(array?1:0)||array&&(names.length!==item.length||names.some((key,i)=>key!==String(i))))fail('费用原件字段不完整');
    seen.add(item);const values=names.map(key=>{const d=Object.getOwnPropertyDescriptor(item,key);if(!Object.hasOwn(d,'value'))fail('费用原件含访问器');return array?visit(d.value,depth+1):[key,visit(d.value,depth+1)];});seen.delete(item);
    return [array?'array':'object',values];
  }
  const text=JSON.stringify(visit(value));if(bytes(text)>limits.body)fail('费用原件超过保全上限，原数据保留');return text;
}
function decode(text){
  const root=parseBoundedJson(text,{maxBytes:limits.body,maxDepth:80,maxNodes:1000000,label:'费用原件'});let count=0;
  function visit(item,depth=0){
    if(++count>200000||depth>24)fail('费用原件结构过大');
    if(item===null||['boolean','string','number'].includes(typeof item))return item;
    if(!Array.isArray(item))fail('费用原件编码无效');
    if(item.length===1&&item[0]==='undefined')return undefined;
    if(item.length===1&&item[0]==='negative-zero')return -0;
    if(item.length!==2||!['object','array'].includes(item[0])||!Array.isArray(item[1]))fail('费用原件编码无效');
    if(item[0]==='array')return item[1].map(value=>visit(value,depth+1));
    const result={};for(const pair of item[1]){
      if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||Object.hasOwn(result,pair[0]))fail('费用原件字段重复或损坏');
      Object.defineProperty(result,pair[0],{value:visit(pair[1],depth+1),enumerable:true,writable:true,configurable:true});
    }return result;
  }
  const value=visit(root);if(encode(value)!==text)fail('费用原件编码不一致');return value;
}
async function checked(value,namespace){
  if(!exact(value,['namespace','section','receipt','segments'])||value.namespace!==namespace||!['current','archived'].includes(value.section))fail('费用原件归属或分区无效');
  await validateVibeEncodingReceipt(value.receipt,namespace,value.receipt?.cacheKey);
  if(value.section==='archived'&&value.receipt.status!=='ready')fail('历史费用原件含未完成请求');
  const reviews=await resolveVibeReviewHistory(namespace,value.receipt.cacheKey,value.receipt.reviewArchive,value.segments);
  checkCombinedVibeReviews(value.receipt,reviews);return value;
}
// Stable complete evidence identity, including legacy undefined and -0. A
// digest names stored evidence; it is never a fee authorization certificate.
export async function captureVibeReceiptOriginal(value,namespace){
  const text=encode(value),snapshot=decode(text);await checked(snapshot,namespace);
  return {text,snapshot,digest:await vibeDigest(text)};
}
export {encode as vibeReceiptEvidenceText};
export function validateVibeReceiptOriginal(value,{namespace,scope}={}){
  if(!exact(value,['schema','namespace','cacheKey','section','digest','bytes','parts'])||value.schema!==schema||value.namespace!==namespace||!hash(value.cacheKey)
    ||!['current','archived'].includes(value.section)||!hash(value.digest)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>limits.body
    ||!Array.isArray(value.parts)||!value.parts.length||value.parts.length>limits.parts||bytes(JSON.stringify(value))>limits.manifest)fail('费用原件目录损坏或归属不符');
  for(const ref of value.parts)stAccountImmutableReference(ref,{scope,slot:partSlot,maxBytes:limits.part+1024});return value;
}

// Complete immutable receipt + review-chain preservation/reading only. This is
// NOT a current ledger, a fee certificate, a reservation or cross-device lock.
// No IDB writes, mutable heads, settings changes, retries or media/API reads.
export function createVibeReceiptOriginals(client,{guard=()=>true,signal,onProgress=()=>{}}={}){
  const namespace=client?.namespace,scope=client?.scope;
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||!hash(scope)
    ||typeof client.preserveImmutable!=='function'||typeof client.readImmutable!=='function'||typeof guard!=='function'||typeof onProgress!=='function')fail('费用原件储存环境无效');
  async function check(){if(signal?.aborted)fail('费用原件操作已取消');if(await guard()===false||signal?.aborted)fail('费用原件账户或页面已变化');return true;}
  const transport={guard:check,signal};
  async function progress(stage,amount){await check();await onProgress({kind:'vibe-receipt-original',stage,bytes:amount});await check();}
  return Object.freeze({
    async preserve(input){
      const text=encode(input),captured=decode(text);await check();await checked(captured,namespace);await check();
      const parts=[];
      for(let at=0;at<text.length;){let end=Math.min(text.length,at+limits.characters);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
        const part=text.slice(at,end),saved=await client.preserveImmutable(partSlot,part,transport);await check();
        if(saved.value!==part)fail('费用原件分块尚未完整读回');parts.push(stAccountImmutableReference(saved.reference,{scope,slot:partSlot,maxBytes:limits.part+1024}));
        await progress('part',bytes(part));at=end;await new Promise(resolve=>setTimeout(resolve,0));
      }
      const value={schema,namespace,cacheKey:captured.receipt.cacheKey,section:captured.section,digest:await vibeDigest(text),bytes:bytes(text),parts};
      await check();validateVibeReceiptOriginal(value,{namespace,scope});const saved=await client.preserveImmutable(VIBE_RECEIPT_ORIGINAL_SLOT,value,transport);await check();
      if(JSON.stringify(saved.value)!==JSON.stringify(value))fail('费用原件目录尚未完整读回');
      const reference=stAccountImmutableReference(saved.reference,{scope,slot:VIBE_RECEIPT_ORIGINAL_SLOT,maxBytes:limits.manifest+1024});
      await progress('complete',value.bytes);return {cacheKey:value.cacheKey,section:value.section,reference};
    },
    async read(reference,{cacheKey,section}={}){
      const captured=stAccountImmutableReference(reference,{scope,slot:VIBE_RECEIPT_ORIGINAL_SLOT,maxBytes:limits.manifest+1024});
      if(!hash(cacheKey)||!['current','archived'].includes(section))fail('请选择确切的费用原件编号和分区');await check();
      const saved=await client.readImmutable(captured,transport);await check();const value=validateVibeReceiptOriginal(saved.value,{namespace,scope});
      if(value.cacheKey!==cacheKey||value.section!==section)fail('费用原件与选定记录不符');
      const parts=[];let total=0;for(const ref of value.parts){const part=await client.readImmutable(ref,transport);await check();
        if(typeof part.value!=='string'||!part.value.length||part.value.length>limits.characters)fail('费用原件分块损坏');
        const count=bytes(part.value);total+=count;if(total>value.bytes)fail('费用原件长度超出目录');parts.push(part.value);await progress('part',count);
      }
      const text=parts.join('');parts.length=0;if(total!==value.bytes||await vibeDigest(text)!==value.digest)fail('费用原件完整性核对失败');await check();
      const result=await checked(decode(text),namespace);await check();if(result.receipt.cacheKey!==cacheKey||result.section!==section)fail('费用原件内容与目录不符');
      await progress('complete',total);return result;
    },
  });
}
