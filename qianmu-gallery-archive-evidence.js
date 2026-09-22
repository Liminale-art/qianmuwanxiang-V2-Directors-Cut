import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {galleryArchiveScope,galleryArchiveObjectReference} from './qianmu-gallery-archive-record.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {galleryArchiveSupplementReference,galleryArchiveEvidenceReference} from './qianmu-gallery-archive-version.js';
export {galleryArchiveEvidenceReference} from './qianmu-gallery-archive-version.js';
import {chatGalleryEvidenceRequest,chatGalleryEvidenceSourceResponse,CHAT_GALLERY_EVIDENCE_LIMITS as SOURCE} from './qianmu-chat-gallery-evidence.js';
import {STORYBOARD_CHAT_EVIDENCE_SCHEMA} from './qianmu-storyboard-chat-evidence.js';
import {vibeDigest} from './qianmu-vibe-file.js';

// Digest rows only, never narrative text. Each native document stays far below
// its existing node/depth limits; raising a whole-document limit is not paging.
export const GALLERY_EVIDENCE_PAGE_LIMITS=Object.freeze({rows:512,pages:196,pageBytes:128*1024,manifestBytes:128*1024});
const LIMIT=GALLERY_EVIDENCE_PAGE_LIMITS,utf8=new TextEncoder();
const schemas={page:'qianmu.gallery.evidence-page.v1',manifest:'qianmu.gallery.evidence-manifest.v1'};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=(value,length=64)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_evidence',writeState:'not_started'});};
function fields(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).length!==keys.length)fail('正文依据包含不支持的字段或格式');
  const result={};for(const key of keys){const prop=Object.getOwnPropertyDescriptor(value,key);
    if(!prop?.enumerable||!Object.hasOwn(prop,'value'))fail('正文依据不能包含访问器或缺失字段');result[key]=prop.value;
  }return result;
}
function rows(raw,start,max=SOURCE.messages){
  if(!Array.isArray(raw)||raw.length>max||Reflect.ownKeys(raw).length!==raw.length+1)fail('正文依据列表不完整或超过上限');
  const result=[];for(let i=0;i<raw.length;i++){
    const prop=Object.getOwnPropertyDescriptor(raw,String(i));if(!prop?.enumerable||!Object.hasOwn(prop,'value'))fail('正文依据包含空缺楼层或访问器');
    const row=fields(prop.value,['floor','sha256','messageHash','revisionHash','swipeId']);
    if(row.floor!==start+i||!hash(row.sha256)||!hash(row.messageHash,8)||!hash(row.revisionHash,8)||!integer(row.swipeId,0,Number.MAX_SAFE_INTEGER))fail('正文依据楼层顺序、摘要或版本无效');
    result.push(row);
  }return result;
}
// Synchronous, detached snapshot before any await. Only flat validated digests
// are copied, not message bodies, unknown fields, getters or hidden swipes.
export function captureGalleryEvidence(raw){
  const value=fields(raw,['ok','version','expectedAccount','target','gallerySha256','source','chatEvidence','proof','header']);
  const evidence=fields(value.chatEvidence,['schema','chatKey','messages','digest']);
  const messages=rows(evidence.messages,0);
  const {chatEvidence,...rest}=value,metadata=captureGalleryArchiveJson({...rest,chatEvidence:{schema:evidence.schema,chatKey:evidence.chatKey,digest:evidence.digest}},8192);
  return {...metadata,chatEvidence:{schema:evidence.schema,chatKey:evidence.chatKey,messages,digest:evidence.digest}};
}
export function galleryEvidenceSummary(receipt){
  const {chatEvidence,...base}=receipt;
  return {...base,chatEvidence:{schema:chatEvidence.schema,chatKey:chatEvidence.chatKey,digest:chatEvidence.digest,count:chatEvidence.messages.length}};
}
async function inspectSummary(scope,raw){
  const value=fields(raw,['ok','version','expectedAccount','target','gallerySha256','source','proof','header','chatEvidence']);
  const base=chatGalleryEvidenceRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,gallerySha256:value.gallerySha256});
  const source=fields(value.source,['bytes','sha256']),header=fields(value.header,['bytes','sha256']);
  const evidence=fields(value.chatEvidence,['schema','chatKey','digest','count']);
  if(value.ok!==true||value.proof!=='read-only-chat-evidence'||!integer(source.bytes,1,SOURCE.fileBytes)||!hash(source.sha256)
    ||!integer(header.bytes,1,SOURCE.headerBytes)||header.bytes>source.bytes||!hash(header.sha256)||evidence.schema!==STORYBOARD_CHAT_EVIDENCE_SCHEMA
    ||evidence.chatKey!==scope.chatKey||!hash(evidence.digest)||!integer(evidence.count,0,SOURCE.messages)
    ||base.target.chatId!==scope.chatKey||(base.target.kind==='character'?scope.ownerKey!=='char:'+base.target.avatar:!scope.ownerKey.startsWith('group:'))
    ||base.expectedAccount!=='st-user:'+await vibeDigest(scope.namespace.slice(8)))fail('正文依据不属于准确账户、聊天或保存来源');
  return {ok:true,version:base.version,expectedAccount:base.expectedAccount,target:base.target,gallerySha256:base.gallerySha256,source,proof:value.proof,header,chatEvidence:evidence};
}
async function encode(value,max){
  const captured=captureGalleryArchiveJson(value,max),text=JSON.stringify(captured);
  return {value:captured,text,reference:{sha256:await vibeDigest(text),bytes:utf8.encode(text).length}};
}
async function inspectPage(scope,raw,descriptor){
  const value=fields(captureGalleryArchiveJson(raw,LIMIT.pageBytes),['schema','scope','rows']);
  if(value.schema!==schemas.page||!same(galleryArchiveScope(value.scope),scope))fail('正文依据页账户或聊天不符');
  const messages=rows(value.rows,descriptor.start,LIMIT.rows);
  if(messages.length!==descriptor.count)fail('正文依据页缺失楼层');
  const encoded=await encode({schema:schemas.page,scope,rows:messages},LIMIT.pageBytes);
  if(encoded.reference.sha256!==descriptor.sha256||encoded.reference.bytes!==descriptor.bytes)fail('正文依据页摘要不符，原文件未覆盖');
  return encoded;
}
async function inspectManifest(scope,raw,reference){
  const value=fields(captureGalleryArchiveJson(raw,LIMIT.manifestBytes),['schema','scope','receipt','supplement','pages']);
  if(value.schema!==schemas.manifest||!same(galleryArchiveScope(value.scope),scope)||!Array.isArray(value.pages)||value.pages.length>LIMIT.pages)fail('正文依据清单来源或页数无效');
  const receipt=await inspectSummary(scope,value.receipt),supplement=galleryArchiveSupplementReference(value.supplement);
  const pages=[];let start=0;const hashes=new Set();
  for(const rawPage of value.pages){
    const page=fields(rawPage,['start','count','sha256','bytes']),ref=galleryArchiveObjectReference({sha256:page.sha256,bytes:page.bytes},LIMIT.pageBytes);
    if(page.start!==start||page.count!==Math.min(LIMIT.rows,receipt.chatEvidence.count-start)||page.count<1||hashes.has(ref.sha256))fail('正文依据清单缺页、重复或顺序不符');
    pages.push({start,count:page.count,...ref});start+=page.count;hashes.add(ref.sha256);
  }
  if(start!==receipt.chatEvidence.count)fail('正文依据清单未覆盖全部楼层');
  const encoded=await encode({schema:schemas.manifest,scope,receipt,supplement,pages},LIMIT.manifestBytes);
  if(!same(encoded.reference,galleryArchiveEvidenceReference(reference)))fail('正文依据清单摘要不符');return encoded;
}
export function galleryEvidenceMatchesSupplement(evidence,supplement){
  return evidence.expectedAccount===supplement.expectedAccount&&same(evidence.target,supplement.target)
    &&evidence.gallerySha256===supplement.gallery.sha256&&supplement.source.kind==='jsonl-header'
    &&evidence.header.bytes===supplement.source.bytes&&evidence.header.sha256===supplement.source.sha256;
}

export async function createGalleryEvidenceStorage({scope,guard,createStorage=createConfiguredStAccountStorage,yieldWork=()=>new Promise(resolve=>setTimeout(resolve,0))}={}){
  const owner=galleryArchiveScope(scope);let closed=false,storage,busy=false;
  if(typeof guard!=='function'||typeof createStorage!=='function'||typeof yieldWork!=='function')fail('正文依据保全缺少来源保护');
  function close(){closed=true;const current=storage;storage=null;current?.close();}
  function check(signal){
    if(closed||signal?.aborted)fail('正文依据保存或读取已取消');const valid=guard();
    if(valid&&typeof valid.then==='function')void Promise.resolve(valid).catch(()=>{});
    if(valid!==true||!same(galleryArchiveScope(scope),owner)){close();fail('正文依据账户或聊天已变化');}return true;
  }
  function receipt(result,signal){check(signal);if(result?.persistence!=='st-account-file'||result.concurrency!=='optimistic-non-cas'||typeof result.exists!=='boolean'
    ||(result.exists?!hash(result.fingerprint):result.fingerprint!==null||result.value!==null))fail('正文依据没有可靠的ST保存回执');return result;}
  const slot=(kind,ref)=>`gallery-evidence-${kind}-${ref.sha256}`;
  try{check();storage=await createStorage({isCurrent:()=>{try{return check();}catch{return false;}},maxBytes:Math.max(LIMIT.pageBytes,LIMIT.manifestBytes)});check();
    if(storage.namespace!==owner.namespace)fail('正文依据保全账户不一致');
  }catch(error){close();throw error;}
  async function readObject(kind,ref,signal){
    check(signal);const saved=receipt(await storage.read(slot(kind,ref),{guard:()=>check(signal),signal}),signal);
    if(!saved.exists)fail('正文依据副本缺失，未用当前聊天猜补');return saved.value;
  }
  async function readManifest(rawReference,{signal}={}){
    check(signal);const ref=galleryArchiveEvidenceReference(rawReference),value=await readObject('manifest',ref,signal);
    const result=await inspectManifest(owner,value,ref);check(signal);return result;
  }
  async function read(rawReference,{signal}={}){
    const manifest=await readManifest(rawReference,{signal}),messages=[];
    for(const page of manifest.value.pages){
      await yieldWork();check(signal);const saved=await inspectPage(owner,await readObject('page',page,signal),page);check(signal);
      messages.push(...saved.value.rows);
    }
    const {chatEvidence,...base}=manifest.value.receipt;
    const evidence=await chatGalleryEvidenceSourceResponse({...base,chatEvidence:{schema:chatEvidence.schema,chatKey:chatEvidence.chatKey,messages,digest:chatEvidence.digest}});check(signal);
    return {receipt:evidence,supplement:manifest.value.supplement,reference:manifest.reference,proof:'evidence-readback-only',originalVerified:false,canPrune:false};
  }
  return Object.freeze({read,readManifest,close,async preserve(raw,{supplement,verify,signal}={}){
    check(signal);const copy=captureGalleryEvidence(raw),companion=galleryArchiveSupplementReference(supplement);
    if(busy||typeof verify!=='function')fail('正文依据正在保存或缺少原来源核验');busy=true;let started=false;
    try{
      const checked=await chatGalleryEvidenceSourceResponse(copy),summary=await inspectSummary(owner,galleryEvidenceSummary(checked));check(signal);
      const verifySource=async()=>{check(signal);if(await verify(structuredClone(summary),{supplement:{...companion}})!==true)fail('正文依据尚未核对原保存来源');check(signal);};
      await verifySource();const pages=[];
      async function put(kind,encoded,inspect){
        check(signal);const prior=receipt(await storage.read(slot(kind,encoded.reference),{guard:()=>check(signal),signal}),signal);
        if(prior.exists)await inspect(prior.value);
        else{await verifySource();started=true;const saved=receipt(await storage.write(slot(kind,encoded.reference),encoded.value,{expectedFingerprint:null,guard:()=>check(signal),signal}),signal);
          if(!saved.exists)fail('正文依据保存尚未确认');await inspect(saved.value);
        }
        check(signal);await inspect(await readObject(kind,encoded.reference,signal));check(signal);
      }
      for(let start=0;start<checked.chatEvidence.messages.length;start+=LIMIT.rows){
        await yieldWork();check(signal);const part=checked.chatEvidence.messages.slice(start,start+LIMIT.rows);
        const page=await encode({schema:schemas.page,scope:owner,rows:part},LIMIT.pageBytes);check(signal);
        const descriptor={start,count:part.length,...page.reference};await put('page',page,value=>inspectPage(owner,value,descriptor));
        await verifySource();pages.push(descriptor);
      }
      const manifest=await encode({schema:schemas.manifest,scope:owner,receipt:summary,supplement:companion,pages},LIMIT.manifestBytes);check(signal);
      // All pages must be readable together before publishing the small manifest.
      for(const page of pages){await yieldWork();check(signal);await inspectPage(owner,await readObject('page',page,signal),page);check(signal);}
      await verifySource();await put('manifest',manifest,value=>inspectManifest(owner,value,manifest.reference));
      await verifySource();return {reference:manifest.reference,supplement:companion,messages:summary.chatEvidence.count,pages:pages.length,
        proof:'evidence-readback-only',originalVerified:false,canPrune:false};
    }catch(error){if(started)error.writeState='unconfirmed';throw error;}finally{busy=false;}
  }});
}
