import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {galleryArchiveScope,galleryArchiveObjectReference} from './qianmu-gallery-archive-record.js';
import {chatGallerySupplementResponse,CHAT_GALLERY_SUPPLEMENT_LIMITS} from './qianmu-chat-gallery-supplement.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const GALLERY_ARCHIVE_SUPPLEMENT_BYTES=CHAT_GALLERY_SUPPLEMENT_LIMITS.responseBytes+8192;
const schema='qianmu.gallery.supplement.v1',utf8=new TextEncoder();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_supplement',writeState:'not_started'});};
// Capture synchronously before any await. Native storage has a depth limit too;
// unsupported originals fail intact, never flatten or discard future fields.
export function captureGallerySupplement(value){
  const seen=new Set();let nodes=0,characters=0;
  function visit(item,depth=0){
    if(++nodes>250000||depth>28)fail('分镜补充资料结构超限，未截断');
    if(typeof item==='string'){characters+=item.length;if(characters>GALLERY_ARCHIVE_SUPPLEMENT_BYTES||item.includes('\0')||new TextDecoder().decode(utf8.encode(item))!==item)fail('分镜补充资料文字超限或编码无效');return;}
    if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('分镜补充资料不是独立 JSON');
    seen.add(item);const keys=Reflect.ownKeys(item);
    if(keys.some(key=>typeof key!=='string')||Array.isArray(item)&&(keys.length!==item.length+1||keys.filter(key=>key!=='length').some((key,index)=>key!==String(index))))fail('分镜补充资料字段或数组不完整');
    for(const key of keys){if(Array.isArray(item)&&key==='length')continue;
      const property=Object.getOwnPropertyDescriptor(item,key);
      if(['__proto__','prototype','constructor'].includes(key)||!property?.enumerable||!Object.hasOwn(property,'value'))fail('分镜补充资料不能包含访问器或不安全字段');
      visit(key,depth+1);visit(property.value,depth+1);
    }seen.delete(item);
  }
  visit(value);const text=JSON.stringify(value);if(utf8.encode(text).length>GALLERY_ARCHIVE_SUPPLEMENT_BYTES)fail('分镜补充资料超过独立保存上限，未截断');return JSON.parse(text);
}
export async function encodeGalleryArchiveSupplement(scope,raw){
  const owner=galleryArchiveScope(scope),copy=captureGallerySupplement(raw);
  const receipt=await chatGallerySupplementResponse(copy,{namespace:owner.namespace});
  if(receipt.target.chatId!==owner.chatKey||(receipt.target.kind==='character'?owner.ownerKey!=='char:'+receipt.target.avatar:!owner.ownerKey.startsWith('group:')))fail('分镜补充资料不属于所选聊天');
  const value={schema,scope:owner,receipt},text=JSON.stringify(captureGallerySupplement(value));
  return {value,text,reference:{sha256:await vibeDigest(text),bytes:utf8.encode(text).length}};
}
export async function inspectGalleryArchiveSupplement(scope,raw,reference){
  const copy=captureGallerySupplement(raw),owner=galleryArchiveScope(scope),ref=galleryArchiveObjectReference(reference,GALLERY_ARCHIVE_SUPPLEMENT_BYTES);
  if(!copy||Array.isArray(copy)||Object.keys(copy).length!==3||copy.schema!==schema||!same(galleryArchiveScope(copy.scope),owner))fail('已保存分镜补充资料来源不符');
  const encoded=await encodeGalleryArchiveSupplement(owner,copy.receipt);
  if(!same(encoded.reference,ref))fail('已保存分镜补充资料校验失败，原文件未覆盖');return encoded;
}

// Separate bounded store: do not enlarge image-record/page budgets. Immutable
// content slots remain readable without the original chat, session or model.
export async function createGallerySupplementStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=galleryArchiveScope(scope);let closed=false,storage,busy=false;
  if(typeof guard!=='function'||typeof createStorage!=='function')fail('分镜补充资料缺少同步来源保护');
  function check(){
    if(closed)fail('分镜补充资料保存会话已变化');const valid=guard();
    if(valid&&typeof valid.then==='function')void Promise.resolve(valid).catch(()=>{});
    if(valid!==true||!same(galleryArchiveScope(scope),owner))fail('分镜补充资料保存会话已变化');return true;
  }
  function close(){closed=true;storage?.close();}
  function receipt(result){check();if(result?.persistence!=='st-account-file'||result.concurrency!=='optimistic-non-cas'||typeof result.exists!=='boolean'
    ||(result.exists?!/^[a-f0-9]{64}$/.test(result.fingerprint||''):result.fingerprint!==null||result.value!==null))fail('分镜补充资料没有可靠保存回执');return result;}
  const slot=ref=>'gallery-supplement-'+ref.sha256;
  try{check();storage=await createStorage({isCurrent:()=>{try{return check();}catch{return false;}},maxBytes:GALLERY_ARCHIVE_SUPPLEMENT_BYTES});check();if(storage.namespace!==owner.namespace)fail('分镜补充资料账户不一致');}
  catch(error){close();throw error;}
  async function read(reference,{signal}={}){
    check();const ref=galleryArchiveObjectReference(reference,GALLERY_ARCHIVE_SUPPLEMENT_BYTES),saved=receipt(await storage.read(slot(ref),{guard:check,signal}));
    if(!saved.exists)fail('已保存分镜补充资料缺失，未用当前配置猜补');const encoded=await inspectGalleryArchiveSupplement(owner,saved.value,ref);check();return encoded;
  }
  return Object.freeze({async preserve(raw,{verify}={}){
    check();const copy=captureGallerySupplement(raw);if(busy||typeof verify!=='function')fail('分镜补充资料正在保存或缺少来源核验');busy=true;let started=false;
    try{
      const encoded=await encodeGalleryArchiveSupplement(owner,copy);check();
      const verifySource=async()=>{if(await verify(structuredClone(encoded.value.receipt))!==true)fail('分镜补充资料尚未核对来源');check();};
      await verifySource();const before=receipt(await storage.read(slot(encoded.reference),{guard:check}));
      if(before.exists)await inspectGalleryArchiveSupplement(owner,before.value,encoded.reference);
      else{await verifySource();started=true;const written=receipt(await storage.write(slot(encoded.reference),encoded.value,{expectedFingerprint:null,guard:check}));if(!written.exists)fail('分镜补充资料保存未确认');}
      check();await read(encoded.reference);await verifySource();return {reference:encoded.reference,proof:'supplement-readback-only',originalVerified:false,canPrune:false};
    }catch(error){if(started)error.writeState='unconfirmed';throw error;}finally{busy=false;}
  },read,close});
}
