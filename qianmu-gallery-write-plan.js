import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {galleryArchiveScope,galleryArchiveObjectReference,GALLERY_ARCHIVE_RECORD_BYTES} from './qianmu-gallery-archive-record.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {GALLERY_RESTORE_PLAN_LIMITS} from './qianmu-gallery-restore-plan.js';
import {recipeArchiveReference} from './qianmu-recipe-archive-contract.js';
import {chatGalleryReceiptSummary} from './qianmu-chat-gallery-receipt.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const GALLERY_WRITE_PLAN_LIMITS=Object.freeze({rows:128,pageBytes:128*1024,manifestBytes:128*1024,pages:512});
const LIMIT=GALLERY_WRITE_PLAN_LIMITS,utf8=new TextEncoder(),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_write_plan',submissionState:'not_submitted'});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=v=>Number.isSafeInteger(v)&&v>=0,hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const schema=kind=>'qianmu.gallery.write-'+kind+'.v1';
export function galleryRecipeResolution(raw){
  raw=captureGalleryArchiveJson(raw,16*1024);
  if(!exact(raw,['recordId','createdAt','record','originalReference','reference'])||typeof raw.recordId!=='string'||!raw.recordId||raw.recordId.length>240
    ||/[\u0000-\u001f\u007f]/.test(raw.recordId)||!integer(raw.createdAt))fail('配方复位记录缺少准确的原画面');
  const record=galleryArchiveObjectReference(raw.record,GALLERY_ARCHIVE_RECORD_BYTES),originalReference=recipeArchiveReference(raw.originalReference),reference=recipeArchiveReference(raw.reference);
  if(originalReference.sha256!==reference.sha256||originalReference.bytes!==reference.bytes)fail('配方复位不得更改原配方内容');
  return {recordId:raw.recordId,createdAt:raw.createdAt,record,originalReference,reference};
}

// Immutable, reference-only resolved write plans. They are NOT host save receipts
// and do not claim that files still exist. The writer must recheck dependencies,
// rehydrate these exact overrides and use the shared historical-chat journal.
export async function createGalleryWritePlanStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=galleryArchiveScope(scope);if(typeof guard!=='function')fail('写回方案缺少账户来源保护');let storage,closed=false,busy=false,wrote=false;const staged=new Map();
  const close=()=>{closed=true;storage?.close();staged.clear();};
  async function check(){if(closed||await guard()!==true||closed)fail('写回方案来源已变化');return true;}
  const receipt=v=>{if(v?.persistence!=='st-account-file'||v.concurrency!=='optimistic-non-cas'||typeof v.exists!=='boolean'
    ||(v.exists?!hash(v.fingerprint):v.fingerprint!==null||v.value!==null))fail('写回方案没有完整ST回执');return v;};
  const slot=(kind,ref)=>`gallery-write-${kind}-${ref.sha256}`;
  async function readObject(kind,ref){await check();const saved=receipt(await storage.read(slot(kind,ref),{guard:check}));if(!saved.exists)fail('写回方案文件缺失，未自动补造');
    const text=JSON.stringify(saved.value);if(utf8.encode(text).length!==ref.bytes||await vibeDigest(text)!==ref.sha256)fail('写回方案内容校验失败');await check();return saved.value;}
  async function encode(value,max){const copy=captureGalleryArchiveJson(value,max),text=JSON.stringify(copy);return {value:copy,reference:{sha256:await vibeDigest(text),bytes:utf8.encode(text).length}};}
  async function put(kind,encoded){await check();const key=slot(kind,encoded.reference),before=receipt(await storage.read(key,{guard:check}));
    if(before.exists){if(!same(before.value,encoded.value))fail('写回方案副本冲突，未覆盖');}
    else{wrote=true;const saved=receipt(await storage.write(key,encoded.value,{expectedFingerprint:null,guard:check}));if(!saved.exists||!same(saved.value,encoded.value))fail('写回方案保存未确认');}
    await readObject(kind,encoded.reference);await check();return structuredClone(encoded.reference);}
  async function exclusive(work){await check();if(busy)fail('写回方案正在处理');busy=true;try{return await work();}catch(error){if(wrote)error.writeState='unconfirmed';throw error;}finally{busy=false;}}
  function page(raw){const value=captureGalleryArchiveJson(raw,LIMIT.pageBytes);
    if(!exact(value,['schema','scope','start','rows'])||value.schema!==schema('page')||!same(galleryArchiveScope(value.scope),owner)||!integer(value.start)
      ||!Array.isArray(value.rows)||!value.rows.length||value.rows.length>LIMIT.rows)fail('写回方案分页无效');
    value.rows=value.rows.map(galleryRecipeResolution);return value;}
  function manifest(raw){const value=captureGalleryArchiveJson(raw,LIMIT.manifestBytes);
    if(!exact(value,['schema','scope','preparation','gallery','pages','resolutions'])||value.schema!==schema('plan')||!same(galleryArchiveScope(value.scope),owner)
      ||!Array.isArray(value.pages)||value.pages.length>LIMIT.pages||!integer(value.resolutions)||value.resolutions>10000)fail('写回方案清单不完整');
    value.preparation=galleryArchiveObjectReference(value.preparation,GALLERY_RESTORE_PLAN_LIMITS.manifestBytes);value.gallery=chatGalleryReceiptSummary(value.gallery);
    let start=0;for(const descriptor of value.pages){
      if(!exact(descriptor,['sha256','bytes','start','count'])||descriptor.start!==start||!Number.isSafeInteger(descriptor.count)||descriptor.count<1||descriptor.count>LIMIT.rows)fail('写回方案分页缺失或乱序');
      galleryArchiveObjectReference({sha256:descriptor.sha256,bytes:descriptor.bytes},LIMIT.pageBytes);start+=descriptor.count;
    }
    if(start!==value.resolutions||value.resolutions>value.gallery.count)fail('写回方案配方总数不符');return value;
  }
  async function scanPages(value,visit){const ids=new Set();let count=0;
    for(const descriptor of value.pages){const current=page(await readObject('page',descriptor));
      if(current.start!==descriptor.start||current.rows.length!==descriptor.count)fail('写回方案页范围不符');
      for(const row of current.rows){if(ids.has(row.recordId))fail('写回方案配方重复');ids.add(row.recordId);await check();await visit(structuredClone(row),count++);await check();}
      await new Promise(resolve=>setTimeout(resolve,0));await check();
    }
    if(count!==value.resolutions)fail('写回方案配方未完整读取');
  }
  async function readPlan(rawReference,visit=async()=>{}){
    const reference=galleryArchiveObjectReference(rawReference,LIMIT.manifestBytes),plan=manifest(await readObject('plan',reference));await scanPages(plan,visit);
    await readObject('plan',reference);await check();return {reference,plan,proof:'write-plan-readback-only',metadataRestored:false,canPrune:false};
  }
  try{await check();storage=await createStorage({maxBytes:LIMIT.pageBytes,isCurrent:()=>!closed});if(storage.namespace!==owner.namespace)fail('写回方案账户不符');await check();}
  catch(error){close();throw error;}
  return Object.freeze({
    stagePage(rawRows,start){const captured=captureGalleryArchiveJson(rawRows,LIMIT.pageBytes);return exclusive(async()=>{
      const value=page({schema:schema('page'),scope:owner,start,rows:captured}),encoded=await encode(value,LIMIT.pageBytes);await put('page',encoded);
      const descriptor={...encoded.reference,start,count:value.rows.length};staged.set(descriptor.sha256,descriptor);return structuredClone(descriptor);
    });},
    publish(raw,{verify}={}){const captured=captureGalleryArchiveJson(raw,LIMIT.manifestBytes);return exclusive(async()=>{
      if(typeof verify!=='function'||await verify()!==true)fail('写回方案来源尚未完整核对');await check();
      const encoded=await encode(manifest({schema:schema('plan'),scope:owner,...captured}),LIMIT.manifestBytes);
      if(encoded.value.pages.some(row=>!same(staged.get(row.sha256),row)))fail('写回方案引用了未核验分页');
      await scanPages(encoded.value,async()=>{});if(await verify()!==true)fail('写回方案发布前来源已变化');
      await put('plan',encoded);const result=await readPlan(encoded.reference);
      if(await verify()!==true)fail('写回方案发布后来源已变化，副本保留但未确认');await check();return result;
    });},
    read:ref=>exclusive(()=>readPlan(ref)),
    scan(rawReference,{visit=async()=>{}}={}){const ref=galleryArchiveObjectReference(rawReference,LIMIT.manifestBytes);
      return exclusive(()=>{if(typeof visit!=='function')fail('写回方案缺少分页接收器');return readPlan(ref,visit);});},close,
  });
}
