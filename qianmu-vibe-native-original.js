import {parseNovelVibeFile,vibeFileError,vibeDigest,vibeFilePreview} from './qianmu-vibe-file.js';
import {vibeAssetNamespace,validateVibeAssetHead} from './qianmu-vibe-asset-contract.js';
import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {parseBoundedJson} from './qianmu-json-input.js';

export const VIBE_NATIVE_ORIGINAL_SLOT='vibe-original';
export const VIBE_NATIVE_ORIGINAL_LIMITS=Object.freeze({body:64*1048576,preview:2*1048576,head:256*1024,manifest:1048576,part:512*1024,characters:65536});
const schema='qianmu.vibe.original.v1',limits=VIBE_NATIVE_ORIGINAL_LIMITS,utf8=new TextEncoder();
const fail=message=>{throw vibeFileError('native_original',message);};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d?.enumerable&&Object.hasOwn(d,'value');});
const bodySlot='vibe-original-part',previewSlot='vibe-preview-part';
const bytes=text=>utf8.encode(text).length;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Unknown JSON head fields are preserved, never silently coerced or omitted.
// Text wrapping also preserves escaped controls in legacy metadata without
// expanding the shared native transport's JSON object contract.
function headText(value,namespace){
  const seen=new Set();let nodes=0;
  function visit(item,depth=0){
    if(++nodes>50000||depth>32)fail('Vibe 原目录结构过大，未截断');
    if(item===null||typeof item==='string'||typeof item==='boolean')return;
    if(typeof item==='number'){if(!Number.isFinite(item)||Object.is(item,-0))fail('Vibe 原目录数值不能无损保存');return;}
    if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('Vibe 原目录包含非 JSON 内容');
    const names=Object.keys(item);if(Reflect.ownKeys(item).length!==names.length+(Array.isArray(item)?1:0)
      ||Array.isArray(item)&&(names.length!==item.length||names.some((key,i)=>key!==String(i))))fail('Vibe 原目录字段不能完整保存');
    seen.add(item);for(const key of names){const d=Object.getOwnPropertyDescriptor(item,key);if(!Object.hasOwn(d,'value'))fail('Vibe 原目录包含访问器');visit(d.value,depth+1);}seen.delete(item);
  }
  visit(value);validateVibeAssetHead(value,namespace);const text=JSON.stringify(value);if(bytes(text)>limits.head)fail('Vibe 原目录过大，未截断');return text;
}
function readHead(text,namespace){
  if(typeof text!=='string'||bytes(text)>limits.head)fail('Vibe 原目录不完整');
  const value=parseBoundedJson(text,{maxBytes:limits.head,maxDepth:32,maxNodes:50000,label:'Vibe 原目录'});
  if(headText(value,namespace)!==text)fail('Vibe 原目录格式不一致');return value;
}
function validateParts(value,scope,slot,maxBytes,maxParts){
  if(!exact(value,['digest','bytes','parts'])||!hash(value.digest)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>maxBytes
    ||!Array.isArray(value.parts)||!value.parts.length||value.parts.length>maxParts)fail('Vibe 原件分块目录无效');
  for(const ref of value.parts)stAccountImmutableReference(ref,{scope,slot,maxBytes:limits.part+1024});return value;
}
export function validateVibeNativeOriginal(value,{namespace,scope}={}){
  vibeAssetNamespace(namespace);
  if(!exact(value,['schema','namespace','headText','body','preview'])||value.schema!==schema||value.namespace!==namespace)fail('Vibe 原件归属或格式无效');
  const head=readHead(value.headText,namespace);validateParts(value.body,scope,bodySlot,limits.body,1024);
  if(value.body.bytes!==head.bytes||value.body.digest!==head.assetId)fail('Vibe 原件与资产编号不符');
  if((head.previewBytes??0)===0){if(value.preview!==null)fail('Vibe 无预览记录不应补造缓存');}
  else{
    const p=value.preview;
    if(!exact(p,['mime','bytes','digest','content'])||!/^image\/(png|jpeg|webp)$/.test(p.mime)||p.bytes!==head.previewBytes||!hash(p.digest))fail('Vibe 预览目录无效');
    validateParts(p.content,scope,previewSlot,Math.ceil(limits.preview/3)*4,43);
    if(p.content.bytes!==Math.ceil(p.bytes/3)*4)fail('Vibe 预览长度不符');
  }
  if(bytes(JSON.stringify(value))>limits.manifest)fail('Vibe 原件目录过大');return head;
}
const toBase64=value=>{const parts=[];for(let at=0;at<value.length;at+=16384)parts.push(String.fromCharCode(...value.subarray(at,at+16384)));return btoa(parts.join(''));};

// Preservation/reading only: no mutable catalogue, legacy writes, deletion,
// encoding request, paid retry, or adoption of a recovery checkpoint. Callers
// publish a catalogue only after this complete immutable original is verified.
export function createVibeNativeOriginals(client,{guard=()=>true,signal,onProgress=()=>{}}={}){
  const namespace=vibeAssetNamespace(client?.namespace),scope=client?.scope;
  if(!hash(scope)||typeof client.preserveImmutable!=='function'||typeof client.readImmutable!=='function'||typeof guard!=='function'||typeof onProgress!=='function')fail('Vibe 原件储存环境无效');
  async function check(){if(signal?.aborted)fail('Vibe 原件处理已取消');if(await guard()===false||signal?.aborted)fail('Vibe 原件账户或页面已变化');return true;}
  const transport={guard:check,signal};
  async function progress(stage,verifiedBytes){await check();await onProgress({kind:'vibe-original',stage,bytes:verifiedBytes});await check();}
  async function writeParts(text,slot){
    const parts=[],digest=await vibeDigest(text);await check();
    for(let at=0;at<text.length;){let end=Math.min(text.length,at+limits.characters);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
      const part=text.slice(at,end),saved=await client.preserveImmutable(slot,part,transport);await check();
      if(saved.value!==part)fail('Vibe 原件分块尚未完整读回');stAccountImmutableReference(saved.reference,{scope,slot,maxBytes:limits.part+1024});
      parts.push(saved.reference);await progress(slot===bodySlot?'body-part':'preview-part',bytes(part));at=end;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {digest,bytes:bytes(text),parts};
  }
  async function readParts(value,slot){
    const parts=[];let count=0;for(const ref of value.parts){const saved=await client.readImmutable(ref,transport);await check();
      if(typeof saved.value!=='string'||!saved.value.length||saved.value.length>limits.characters)fail('Vibe 原件分块损坏');
      const size=bytes(saved.value);count+=size;if(count>value.bytes)fail('Vibe 原件分块长度超出目录');parts.push(saved.value);await progress(slot===bodySlot?'body-part':'preview-part',size);
    }
    const text=parts.join('');parts.length=0;if(count!==value.bytes||await vibeDigest(text)!==value.digest)fail('Vibe 完整原件摘要或长度不符');await check();return text;
  }
  async function inspect(reference,expectedHead){
    const captured=stAccountImmutableReference(reference,{scope,slot:VIBE_NATIVE_ORIGINAL_SLOT,maxBytes:limits.manifest+1024});
    const expected=expectedHead===undefined?undefined:headText(expectedHead,namespace);await check();
    const saved=await client.readImmutable(captured,transport);await check();const head=validateVibeNativeOriginal(saved.value,{namespace,scope});
    if(expected!==undefined&&expected!==saved.value.headText)fail('Vibe 原件与选定目录版本不一致');return {manifest:saved.value,head};
  }
  async function parseOriginal(text,head){
    const parsed=await parseNovelVibeFile(text);await check();const asset=parsed[0];
    if(parsed.length!==1||asset.serialized!==text||asset.assetId!==head.assetId||asset.bytes!==head.bytes||!same(asset.summary,head.summary))fail('Vibe 完整原件与原目录不符');return asset;
  }
  return Object.freeze({
    async preserve({head,serialized,preview=null}={}){
      const capturedText=headText(head,namespace),capturedHead=readHead(capturedText,namespace);await check();
      const asset=await parseOriginal(serialized,capturedHead);let previewData=null;
      if((capturedHead.previewBytes??0)>0){
        if(!(preview instanceof Blob)||preview.size!==capturedHead.previewBytes||!/^image\/(png|jpeg|webp)$/.test(preview.type))fail('Vibe 原缩略图缺失或无效');
        const supplied=vibeFilePreview(asset.document),raw=new Uint8Array(await preview.arrayBuffer());await check();
        if(!supplied||supplied.type!==preview.type||supplied.size!==preview.size||await vibeDigest(new Uint8Array(await supplied.arrayBuffer()))!==await vibeDigest(raw))fail('Vibe 缩略图与完整原件不一致');
        previewData={mime:preview.type,bytes:preview.size,digest:await vibeDigest(raw),text:toBase64(raw)};
      }else if(preview!==null)fail('Vibe 原目录未记录此缩略图，未擅自补造');
      await check();const body=await writeParts(serialized,bodySlot),storedPreview=previewData?{mime:previewData.mime,bytes:previewData.bytes,digest:previewData.digest,content:await writeParts(previewData.text,previewSlot)}:null;
      const value={schema,namespace,headText:capturedText,body,preview:storedPreview};validateVibeNativeOriginal(value,{namespace,scope});
      const saved=await client.preserveImmutable(VIBE_NATIVE_ORIGINAL_SLOT,value,transport);await check();
      stAccountImmutableReference(saved.reference,{scope,slot:VIBE_NATIVE_ORIGINAL_SLOT,maxBytes:limits.manifest+1024});
      if(!same(saved.value,value))fail('Vibe 原件目录尚未完整读回');await progress('complete',capturedHead.bytes+(capturedHead.previewBytes??0));
      return {head:capturedHead,reference:saved.reference};
    },
    async inspect(reference,expectedHead){const result=await inspect(reference,expectedHead);return structuredClone(result);},
    async load(reference,expectedHead){const {manifest,head}=await inspect(reference,expectedHead);return parseOriginal(await readParts(manifest.body,bodySlot),head);},
    async preview(reference,expectedHead){
      const {manifest}=await inspect(reference,expectedHead),p=manifest.preview;if(!p)return null;
      const text=await readParts(p.content,previewSlot);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(text))fail('Vibe 预览编码无效');
      let raw;try{raw=Uint8Array.from(atob(text),char=>char.charCodeAt(0));}catch{fail('Vibe 预览编码损坏');}
      if(raw.length!==p.bytes||toBase64(raw)!==text||await vibeDigest(raw)!==p.digest)fail('Vibe 预览内容不符');await check();
      // Validate the actual image, not just a matching MIME label/digest.
      const blob=vibeFilePreview({thumbnail:`data:${p.mime};base64,${text}`});await progress('preview',raw.length);return blob;
    },
  });
}
