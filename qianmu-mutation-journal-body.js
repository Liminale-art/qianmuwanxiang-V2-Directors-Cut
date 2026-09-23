import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {assertJsonInputBounds,parseBoundedJson} from './qianmu-json-input.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const slot='mutation-journal-part',limit=64*1048576,utf8=new TextEncoder();
const fail=message=>{throw Object.assign(Error(message),{code:'mutation_journal_native',submissionState:'not_submitted'});};
const bounds={maxBytes:limit,maxDepth:64,maxNodes:1200000,label:'配置恢复原件'};
export function assertMutationBodyValue(value){
  const seen=new Set();let nodes=0;
  const visit=(item,depth=0)=>{if(++nodes>bounds.maxNodes||depth>bounds.maxDepth)fail('配置恢复原件结构过大，未截断');
    if(item===null||typeof item==='string'||typeof item==='boolean')return;
    if(typeof item==='number'){if(!Number.isFinite(item)||Object.is(item,-0))fail('配置恢复原件包含不能无损保存的数值');return;}
    if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('配置恢复原件包含非JSON值，旧内容已保留');
    seen.add(item);if(Object.getOwnPropertySymbols(item).length||Array.isArray(item)&&(Object.keys(item).length!==item.length||Object.keys(item).some((key,index)=>key!==String(index))))fail('配置恢复原件字段或数组不完整');
    for(const key of Object.keys(item)){const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('配置恢复原件包含访问器');visit(descriptor.value,depth+1);}seen.delete(item);};visit(value);
}
export function validateMutationBodyReference(value,scope){
  if(!value||typeof value!=='object'||Object.keys(value).length!==3||!['digest','bytes','parts'].every(key=>Object.hasOwn(value,key))
    ||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>limit
    ||!Array.isArray(value.parts)||!value.parts.length||value.parts.length>1024)fail('配置恢复分块目录不完整');
  for(const ref of value.parts)stAccountImmutableReference(ref,{scope,slot,maxBytes:512*1024+1024});return value;
}
export function createMutationJournalBody(client,transport,check){
  return Object.freeze({
    async read(reference){
      validateMutationBodyReference(reference,client.scope);const parts=[];let bytes=0;
      for(const ref of reference.parts){const saved=await client.readImmutable(ref,transport);await check();
        if(typeof saved.value!=='string'||!saved.value.length||saved.value.length>65536)fail('配置恢复分块损坏');
        bytes+=utf8.encode(saved.value).length;if(bytes>reference.bytes)fail('配置恢复分块长度不符');parts.push(saved.value);}
      const text=parts.join('');parts.length=0;
      if(bytes!==reference.bytes||await vibeDigest(text)!==reference.digest)fail('配置恢复完整原件校验失败');await check();
      return parseBoundedJson(text,bounds);
    },
    async preserve(value){
      assertMutationBodyValue(value);const text=JSON.stringify(value);assertJsonInputBounds(text,bounds);const digest=await vibeDigest(text),parts=[];await check();
      for(let at=0;at<text.length;){let end=Math.min(text.length,at+65536);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
        const saved=await client.preserveImmutable(slot,text.slice(at,end),transport);await check();if(saved.value!==text.slice(at,end))fail('配置恢复原件尚未完整读回');parts.push(saved.reference);at=end;
        await new Promise(resolve=>setTimeout(resolve,0));}
      return validateMutationBodyReference({digest,bytes:utf8.encode(text).length,parts},client.scope);
    },
  });
}
