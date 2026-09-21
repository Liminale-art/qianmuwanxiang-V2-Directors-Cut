// Add-only ST-native object storage foundation. Not imported by the application.
// No live head replacement, migration, original download, deletion or generation.
// Records/pages have content-addressed slots; differing edits retain both copies.
import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {captureGalleryArchiveJson,encodeGalleryIndexPage,encodeGalleryIndexManifest,createGalleryPageIndexReader,GALLERY_PAGE_INDEX_LIMITS as LIMIT} from './qianmu-gallery-page-index.js';
import {galleryArchiveScope,galleryArchiveObjectReference,encodeGalleryArchiveRecord,inspectGalleryArchiveRecord,GALLERY_ARCHIVE_RECORD_BYTES} from './qianmu-gallery-archive-record.js';
import {galleryCatalogTags} from './qianmu-gallery-catalog-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_storage',writeState:'not_started'});};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const bytes=value=>new TextEncoder().encode(value).length;
export async function createGalleryArchiveStorage({scope,guard,verifyRecord,createStorage=createConfiguredStAccountStorage}={}){
  const owner=galleryArchiveScope(scope);
  if(typeof guard!=='function'||typeof verifyRecord!=='function'||typeof createStorage!=='function')fail('画面保全缺少来源验证');
  let storage,closed=false,busy=false,mayHaveWritten=false;const readers=new Set();
  function check(){
    if(closed)fail('画面保全会话已结束');let valid=false;
    try{const result=guard();if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{});else valid=result===true;
      valid=valid&&same(galleryArchiveScope(scope),owner);
    }catch{valid=false;}
    if(!valid){close();fail('画面保全账户或聊天已变化');}return true;
  }
  function close(){closed=true;for(const reader of readers)reader.close();readers.clear();storage?.close();}
  check();
  try{
    storage=await createStorage({isCurrent:()=>{try{return check();}catch{return false;}},maxBytes:LIMIT.recordBytes});check();
    if(storage.namespace!==owner.namespace)fail('画面保全账户不一致');
  }catch(error){close();throw error;}
  const slot=(kind,ref)=>`gallery-${kind}-${ref.sha256}`;
  function receipt(value){
    check();
    if(value?.persistence!=='st-account-file'||value.concurrency!=='optimistic-non-cas'||typeof value.exists!=='boolean'
      ||(value.exists?!/^[a-f0-9]{64}$/.test(value.fingerprint||''):value.fingerprint!==null||value.value!==null))fail('ST画面保全返回尚未确认');
    return value;
  }
  async function readObject(kind,ref,signal){
    check();const result=receipt(await storage.read(slot(kind,ref),{guard:check,signal}));check();
    if(!result.exists)fail('画面保全文件缺失，未作为空库或自动重建');return result.value;
  }
  async function putObject(kind,encoded,inspect){
    check();const location=slot(kind,encoded.reference),before=receipt(await storage.read(location,{guard:check}));check();
    if(before.exists){await inspect(before.value);check();return;}
    mayHaveWritten=true;const written=await storage.write(location,encoded.value,{expectedFingerprint:null,guard:check});
    try{const saved=receipt(written);if(!saved.exists)fail('画面保全没有保存回执');await inspect(saved.value);check();}
    catch(error){error.writeState='unconfirmed';throw error;}
  }
  async function verify(encoded){
    check();const valid=await verifyRecord(structuredClone(encoded.value.record),{scope:{...owner},reference:{...encoded.reference}});check();
    if(valid!==true)fail('原画面尚未与来源核对一致，未确认保全');
  }
  async function preserveEncoded(encoded){
    await verify(encoded);await putObject('record',encoded,value=>inspectGalleryArchiveRecord(owner,value,encoded.reference));await verify(encoded);
    return {reference:{...encoded.reference},recordId:encoded.value.record.id,createdAt:encoded.value.record.createdAt,recipeState:encoded.recipeState,
      persistence:'st-account-file',proof:'record-readback-only',originalVerified:false,canPrune:false};
  }
  async function exclusive(work){check();if(busy)fail('画面保全正在保存，请勿重复提交');busy=true;mayHaveWritten=false;
    try{return await work();}catch(error){if(mayHaveWritten)error.writeState='unconfirmed';throw error;}finally{busy=false;mayHaveWritten=false;}}
  async function indexText(kind,ref,signal){
    const value=await readObject(kind,ref,signal),content=JSON.stringify(captureGalleryArchiveJson(value,kind==='page'?LIMIT.pageBytes:LIMIT.manifestBytes));check();
    if(!same(galleryArchiveScope(value?.scope),owner))fail('分页保全不属于当前聊天');
    if(bytes(content)!==ref.bytes||await vibeDigest(content)!==ref.sha256)fail('分页保全内容校验失败，未修改原文件');check();return content;
  }
  async function inspectPage(value,encoded){
    const content=JSON.stringify(captureGalleryArchiveJson(value,LIMIT.pageBytes));
    if(content!==encoded.text)fail('分页保全读回不一致，未覆盖已有版本');
  }
  return Object.freeze({scope:Object.freeze({...owner}),
    async preserveRecord(raw){
      // Capture before the first await so editing the live record cannot change
      // the object being written while the account/source is being checked.
      check();const captured=captureGalleryArchiveJson(raw,GALLERY_ARCHIVE_RECORD_BYTES);
      return exclusive(async()=>preserveEncoded(await encodeGalleryArchiveRecord(owner,captured)));
    },
    async readRecord(rawReference){
      check();const ref=galleryArchiveObjectReference(rawReference,GALLERY_ARCHIVE_RECORD_BYTES);
      const encoded=await inspectGalleryArchiveRecord(owner,await readObject('record',ref),ref);check();
      return {record:encoded.value.record,recipeState:encoded.recipeState,reference:{...ref},proof:'record-readback-only',originalVerified:false,canPrune:false};
    },
    async stagePage(raw){
      check();const captured=captureGalleryArchiveJson(raw,LIMIT.recordBytes);
      if(!Array.isArray(captured)||!captured.length||captured.length>LIMIT.rows)fail('画面保全每批须为1至128项，未裁剪');
      return exclusive(async()=>{
        // Validate the complete batch first. Its order must already be newest
        // first; never silently reorder/deduplicate the source supplied by host.
        const encoded=[];
        for(const item of captured){encoded.push(await encodeGalleryArchiveRecord(owner,item));check();}
        const rows=encoded.map(item=>({recordId:item.value.record.id,createdAt:item.value.record.createdAt,label:'',
          tags:galleryCatalogTags(item.value.record.tags),record:item.reference}));
        const page=await encodeGalleryIndexPage(owner,rows);check();
        for(const item of encoded)await verify(item);
        for(const item of encoded){await preserveEncoded(item);await new Promise(resolve=>setTimeout(resolve,0));check();}
        // Recheck all records after uploads, before making this page reachable.
        for(const item of encoded)await verify(item);
        await putObject('page',{...page,value:JSON.parse(page.text)},value=>inspectPage(value,page));check();
        for(const item of encoded)await verify(item);
        return {descriptor:structuredClone(page.descriptor),records:encoded.map(item=>({recordId:item.value.record.id,reference:item.reference,recipeState:item.recipeState})),
          persistence:'st-account-file',proof:'page-readback-only',originalVerified:false,canPrune:false};
      });
    },
    async readPage(rawReference){check();const ref=galleryArchiveObjectReference(rawReference,LIMIT.pageBytes);return indexText('page',ref);},
    async openStagedPage(rawDescriptor){
      check();const descriptor=captureGalleryArchiveJson(rawDescriptor,4096),head=await encodeGalleryIndexManifest(owner,[descriptor]);check();
      const reader=await createGalleryPageIndexReader({source:owner,head,guard:check,readPage:(ref,{signal})=>indexText('page',ref,signal)});check();readers.add(reader);
      return Object.freeze({page:input=>reader.page(input),close(){readers.delete(reader);reader.close();}});
    },close,
  });
}
