import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {galleryArchiveScope,galleryArchiveObjectReference,GALLERY_ARCHIVE_RECORD_BYTES} from './qianmu-gallery-archive-record.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {galleryArchiveSourceVersion} from './qianmu-gallery-archive-version.js';
import {captureGallerySupplement,GALLERY_ARCHIVE_SUPPLEMENT_BYTES} from './qianmu-gallery-archive-supplement.js';
import {projectChatGallerySupplement} from './qianmu-chat-gallery-supplement.js';
import {chatGalleryReceiptSummary} from './qianmu-chat-gallery-receipt.js';
import {chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const GALLERY_RESTORE_PLAN_LIMITS=Object.freeze({rows:128,pageBytes:128*1024,manifestBytes:128*1024,pages:79});
const LIMIT=GALLERY_RESTORE_PLAN_LIMITS,utf8=new TextEncoder(),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_restore_plan',writeState:'not_started'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const count=value=>Number.isSafeInteger(value)&&value>=0,hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const schema=kind=>'qianmu.gallery.restore-'+kind+'.v1';
async function encode(value,max){const copy=captureGalleryArchiveJson(value,max),text=JSON.stringify(copy);return {value:copy,reference:{sha256:await vibeDigest(text),bytes:utf8.encode(text).length}};}

// Content-addressed preparation, not an active write intent or a restoration
// receipt. No mutable "latest plan", pruning, chat write, or automatic retry.
export async function createGalleryRestorePlanStorage({scope,guard,createStorage=createConfiguredStAccountStorage}={}){
  const owner=galleryArchiveScope(scope);if(typeof guard!=='function')fail('恢复准备缺少来源保护');let storage,supplementStorage,closed=false,busy=false,wrote=false;const staged=new Map();
  function close(){closed=true;storage?.close();supplementStorage?.close();staged.clear();}
  async function check(){if(closed||await guard()!==true||closed)fail('恢复准备来源已变化');return true;}
  const receipt=value=>{if(value?.persistence!=='st-account-file'||value.concurrency!=='optimistic-non-cas'||typeof value.exists!=='boolean'
    ||(value.exists?!hash(value.fingerprint):value.fingerprint!==null||value.value!==null))fail('恢复准备没有完整ST回执');return value;};
  const slot=(kind,ref)=>`gallery-restore-${kind}-${ref.sha256}`;
  async function readObject(store,kind,ref){await check();const saved=receipt(await store.read(slot(kind,ref),{guard:check}));if(!saved.exists)fail('恢复准备文件缺失，未自动补造');
    const text=JSON.stringify(saved.value);if(utf8.encode(text).length!==ref.bytes||await vibeDigest(text)!==ref.sha256)fail('恢复准备文件校验失败');await check();return saved.value;}
  async function put(store,kind,encoded){await check();const key=slot(kind,encoded.reference),before=receipt(await store.read(key,{guard:check}));
    if(before.exists){if(!same(before.value,encoded.value))fail('恢复准备副本冲突，未覆盖');}
    else{wrote=true;const saved=receipt(await store.write(key,encoded.value,{expectedFingerprint:null,guard:check}));if(!saved.exists||!same(saved.value,encoded.value))fail('恢复准备保存未确认');}
    await readObject(store,kind,encoded.reference);await check();return structuredClone(encoded.reference);}
  async function supplements(){if(!supplementStorage){const opened=await createStorage({maxBytes:GALLERY_ARCHIVE_SUPPLEMENT_BYTES,isCurrent:()=>!closed});
    if(closed||opened.namespace!==owner.namespace){opened.close();fail('恢复准备账户已变化');}supplementStorage=opened;}return supplementStorage;}
  async function exclusive(work){await check();if(busy)fail('恢复准备正在处理');busy=true;try{return await work();}catch(error){if(wrote)error.writeState='unconfirmed';throw error;}finally{busy=false;}}
  function row(raw,index){
    if(!exact(raw,['index','recordId','origin','sourceIndex','reference'])||raw.index!==index||typeof raw.recordId!=='string'||!raw.recordId||raw.recordId.length>240
      ||!['baseline','source'].includes(raw.origin)||!count(raw.sourceIndex))fail('恢复准备条目顺序或来源无效');
    return {...raw,reference:galleryArchiveObjectReference(raw.reference,GALLERY_ARCHIVE_RECORD_BYTES)};
  }
  function page(raw){
    const value=captureGalleryArchiveJson(raw,LIMIT.pageBytes);
    if(!exact(value,['schema','scope','start','rows'])||value.schema!==schema('page')||!same(galleryArchiveScope(value.scope),owner)||!count(value.start)
      ||!Array.isArray(value.rows)||!value.rows.length||value.rows.length>LIMIT.rows)fail('恢复准备分页无效');
    value.rows=value.rows.map((item,index)=>row(item,index+value.start));return value;
  }
  function manifest(raw){
    const value=captureGalleryArchiveJson(raw,LIMIT.manifestBytes);
    if(!exact(value,['schema','scope','target','source','baseline','evidenceDigest','gallery','supplement','pages','added','kept'])||value.schema!==schema('plan')
      ||!same(galleryArchiveScope(value.scope),owner)||!hash(value.evidenceDigest)||!Array.isArray(value.pages)||value.pages.length>LIMIT.pages
      ||!count(value.added)||!count(value.kept))fail('恢复准备清单不完整');
    value.target=chatCharacterReceiptTarget(value.target);value.source=galleryArchiveSourceVersion(value.source,owner,value.source?.sourceReceipt);value.baseline=galleryArchiveSourceVersion(value.baseline,owner,value.baseline?.sourceReceipt);
    if(!value.source.evidence||!value.baseline.evidence||value.target.chatId!==owner.chatKey||(value.target.kind==='character'?owner.ownerKey!=='char:'+value.target.avatar:!owner.ownerKey.startsWith('group:')))fail('恢复准备必须绑定同一准确聊天及完整依据');
    value.gallery=chatGalleryReceiptSummary(value.gallery);value.supplement=galleryArchiveObjectReference(value.supplement,GALLERY_ARCHIVE_SUPPLEMENT_BYTES);
    let start=0;for(const descriptor of value.pages){
      if(!exact(descriptor,['sha256','bytes','start','count'])||descriptor.start!==start||!Number.isSafeInteger(descriptor.count)||descriptor.count<1||descriptor.count>LIMIT.rows)fail('恢复准备分页缺失或乱序');
      galleryArchiveObjectReference({sha256:descriptor.sha256,bytes:descriptor.bytes},LIMIT.pageBytes);start+=descriptor.count;
    }
    if(start!==value.gallery.count||value.gallery.count!==value.baseline.sourceReceipt.count+value.added||value.added+value.kept!==value.source.sourceReceipt.count)fail('恢复准备总数不符，未截断');return value;
  }
  async function verifyContents(value){
    const ids=new Set();let baselineCount=0,sourceCount=0,lastSource=-1;
    for(const descriptor of value.pages){
      const current=page(await readObject(storage,'page',descriptor));if(current.start!==descriptor.start||current.rows.length!==descriptor.count)fail('恢复准备页范围不符');
      for(const item of current.rows){if(ids.has(item.recordId))fail('恢复准备包含重复记录');ids.add(item.recordId);
        if(item.origin==='baseline'){if(sourceCount||item.sourceIndex!==baselineCount++)fail('恢复准备没有保留当前记录原顺序');}
        else{if(item.sourceIndex<=lastSource||item.sourceIndex>=value.source.sourceReceipt.count)fail('恢复新增记录来源顺序无效');lastSource=item.sourceIndex;sourceCount++;}
      }
      await new Promise(resolve=>setTimeout(resolve,0));await check();
    }
    if(baselineCount!==value.baseline.sourceReceipt.count||sourceCount!==value.added)fail('恢复准备未覆盖完整当前基线');
    const stored=captureGallerySupplement(await readObject(await supplements(),'supplement',value.supplement));
    if(!exact(stored,['schema','scope','saved'])||stored.schema!==schema('supplement')||!same(galleryArchiveScope(stored.scope),owner))fail('恢复关联资料来源不符');
    await projectChatGallerySupplement(stored.saved,{namespace:owner.namespace,chatKey:owner.chatKey});await check();return stored.saved;
  }
  async function readPlan(rawReference){
    const reference=galleryArchiveObjectReference(rawReference,LIMIT.manifestBytes),value=manifest(await readObject(storage,'plan',reference));
    const saved=await verifyContents(value);await readObject(storage,'plan',reference);await check();
    return {reference,plan:value,saved,proof:'restore-plan-readback-only',restoreReady:false,canPrune:false};
  }
  try{await check();storage=await createStorage({maxBytes:LIMIT.pageBytes,isCurrent:()=>!closed});if(storage.namespace!==owner.namespace)fail('恢复准备账户不符');await check();}
  catch(error){close();throw error;}
  return Object.freeze({
    stagePage(rawRows,start){const captured=captureGalleryArchiveJson(rawRows,LIMIT.pageBytes);return exclusive(async()=>{
      const value=page({schema:schema('page'),scope:owner,start,rows:captured}),encoded=await encode(value,LIMIT.pageBytes);await put(storage,'page',encoded);
      const descriptor={...encoded.reference,start,count:value.rows.length};staged.set(descriptor.sha256,descriptor);return structuredClone(descriptor);
    });},
    publish(raw,{saved,verify}={}){const captured=captureGalleryArchiveJson(raw,LIMIT.manifestBytes),capturedSaved=captureGallerySupplement(saved);return exclusive(async()=>{
      if(typeof verify!=='function'||await verify()!==true)fail('恢复准备尚未完整验证来源');await check();
      await projectChatGallerySupplement(capturedSaved,{namespace:owner.namespace,chatKey:owner.chatKey});
      const body={schema:schema('supplement'),scope:owner,saved:capturedSaved},text=JSON.stringify(captureGallerySupplement(body));
      const supplement=await put(await supplements(),'supplement',{value:body,reference:{sha256:await vibeDigest(text),bytes:utf8.encode(text).length}});
      const encoded=await encode(manifest({schema:schema('plan'),scope:owner,...captured,supplement}),LIMIT.manifestBytes);
      if(encoded.value.pages.some(page=>!same(staged.get(page.sha256),page)))fail('恢复准备引用了未核验的分页');
      await verifyContents(encoded.value);
      if(await verify()!==true)fail('恢复准备发布前来源已变化');await put(storage,'plan',encoded);const result=await readPlan(encoded.reference);
      if(await verify()!==true)fail('恢复准备发布后来源已变化，副本保留但未确认');await check();return result;
    });},
    read:reference=>exclusive(()=>readPlan(reference)),
    scan(rawReference,{visit=async()=>{}}={}){
      const reference=galleryArchiveObjectReference(rawReference,LIMIT.manifestBytes);
      return exclusive(async()=>{
        if(typeof visit!=='function')fail('恢复准备缺少分页接收器');const result=await readPlan(reference);let count=0;
        for(const descriptor of result.plan.pages){
          const current=page(await readObject(storage,'page',descriptor));
          for(const row of current.rows){await check();await visit(structuredClone(row));count++;await check();}
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        await readObject(storage,'plan',reference);await check();
        if(count!==result.plan.gallery.count)fail('恢复准备未完整读取');return result;
      });
    },close,
  });
}
