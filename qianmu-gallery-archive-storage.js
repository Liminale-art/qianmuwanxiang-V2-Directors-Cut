// Add-only ST-native object storage. The gallery browser uses read methods only.
// No live head replacement, migration, original download, deletion or generation.
// Records/pages have content-addressed slots; differing edits retain both copies.
import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {captureGalleryArchiveJson,encodeGalleryIndexPage,encodeGalleryIndexManifest,createGalleryPageIndexReader,GALLERY_PAGE_INDEX_LIMITS as LIMIT} from './qianmu-gallery-page-index.js';
import {galleryArchiveScope,galleryArchiveObjectReference,encodeGalleryArchiveRecord,inspectGalleryArchiveRecord,GALLERY_ARCHIVE_RECORD_BYTES} from './qianmu-gallery-archive-record.js';
import {galleryCatalogTags} from './qianmu-gallery-catalog-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {galleryArchiveSourceReceipt as sourceReceipt,galleryArchiveSourceSlot,galleryArchiveSourceVersion} from './qianmu-gallery-archive-version.js';
import {encodeGalleryArchiveRecipe,inspectGalleryArchiveRecipe} from './qianmu-gallery-archive-recipe.js?v=1.59.318';
import {recipeArchiveSnapshot} from './qianmu-recipe-archive-contract.js';
import {encodeGalleryLocalRecipe,inspectGalleryLocalRecipe,galleryLocalRecipeSlot,readGalleryLocalRecipeCopy} from './qianmu-gallery-local-recipe.js';
import {encodeGalleryReviewedRecipe,inspectGalleryReviewedRecipe,galleryReviewedRecipeSlot} from './qianmu-gallery-reviewed-recipe.js';
import {encodeGalleryArchiveOriginal,inspectGalleryArchiveOriginal} from './qianmu-gallery-archive-original.js';
import {createGallerySupplementStorage,captureGallerySupplement} from './qianmu-gallery-archive-supplement.js';
import {galleryArchiveSupplementReference} from './qianmu-gallery-archive-version.js';
import {createGalleryEvidenceStorage,captureGalleryEvidence,galleryArchiveEvidenceReference,galleryEvidenceMatchesSupplement,galleryEvidenceSummary} from './qianmu-gallery-archive-evidence.js';

const fail=message=>{throw Object.assign(Error(message),{code:'gallery_archive_storage',writeState:'not_started'});};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const bytes=value=>new TextEncoder().encode(value).length;
export async function createGalleryArchiveStorage({scope,guard,verifyRecord,verifySupplement=()=>false,verifyEvidence=()=>false,createStorage=createConfiguredStAccountStorage,yieldWork=async()=>{}}={}){
  const owner=galleryArchiveScope(scope);
  if(typeof guard!=='function'||typeof verifyRecord!=='function'||typeof createStorage!=='function')fail('画面保全缺少来源验证');
  let storage,supplements,supplementsLoading,evidence,evidenceLoading,stagedEvidence,stagedSupplement,closed=false,busy=false,mayHaveWritten=false;const readers=new Set(),staged=new Map(),currentPageRecords=new Map();
  function check(){
    if(closed)fail('画面保全会话已结束');let valid=false;
    try{const result=guard();if(result&&typeof result.then==='function')void Promise.resolve(result).catch(()=>{});else valid=result===true;
      valid=valid&&same(galleryArchiveScope(scope),owner);
    }catch{valid=false;}
    if(!valid){close();fail('画面保全账户或聊天已变化');}return true;
  }
  function close(){closed=true;for(const reader of readers)reader.close();readers.clear();staged.clear();currentPageRecords.clear();storage?.close();supplements?.close();evidence?.close();stagedSupplement=null;stagedEvidence=null;}
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
  async function putObject(kind,encoded,inspect,location=slot(kind,encoded.reference)){
    check();const before=receipt(await storage.read(location,{guard:check}));check();
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
  const sourceSlot=(receipt,supplement,evidence)=>galleryArchiveSourceSlot(owner,receipt,supplement,evidence);
  async function supplementStore(){
    check();if(supplements)return supplements;
    supplementsLoading??=createGallerySupplementStorage({scope:owner,guard:check,createStorage}).then(opened=>{
      try{check();supplements=opened;return opened;}catch(error){opened.close();throw error;}
    }).catch(error=>{supplementsLoading=null;throw error;});
    return supplementsLoading;
  }
  async function openHead(head){
    check();const reader=await createGalleryPageIndexReader({source:owner,head,guard:check,readPage:(ref,{signal})=>indexText('page',ref,signal)});check();readers.add(reader);
    return Object.freeze({page:input=>reader.page(input),close(){readers.delete(reader);reader.close();}});
  }
  async function evidenceStore(){
    check();if(evidence)return evidence;
    evidenceLoading??=createGalleryEvidenceStorage({scope:owner,guard:check,createStorage,yieldWork:async()=>{await yieldWork();check();await new Promise(resolve=>setTimeout(resolve,0));check();}}).then(opened=>{
      try{check();evidence=opened;return opened;}catch(error){opened.close();throw error;}
    }).catch(error=>{evidenceLoading=null;throw error;});return evidenceLoading;
  }
  const versionValue=(value,expected)=>galleryArchiveSourceVersion(value,owner,expected);
  async function readRecipeCopy(original,signal){
    check();
    if(original.recipeState==='inline')return {state:'available',snapshot:recipeArchiveSnapshot(original.value.record.snapshot).snapshot,
      origin:'saved-inline',proof:'recipe-readback-only',originalVerified:false,canPrune:false};
    if(original.recipeState==='local-reference')return readGalleryLocalRecipeCopy(storage,owner,original.value.record,{guard:check,signal});
    if(original.recipeState!=='server-reference')return {state:original.recipeState,snapshot:null,originalVerified:false,canPrune:false};
    const stored=receipt(await storage.read(slot('recipe',original.reference),{guard:check,signal}));check();
    if(!stored.exists)return {state:'not-preserved',snapshot:null,originalVerified:false,canPrune:false};
    return {state:'available',...inspectGalleryArchiveRecipe(owner,original,stored.value)};
  }
  async function readOriginalCopy(original,signal){
    check();const stored=receipt(await storage.read(slot('original',original.reference),{guard:check,signal}));check();
    if(!stored.exists)return {state:'not-preserved',reference:null,originalVerified:false,canPrune:false};
    const result=await inspectGalleryArchiveOriginal(owner,original,stored.value);check();return {state:'available',...result};
  }
  function stagedRecord(rawReference,signal){
    check();const ref=galleryArchiveObjectReference(rawReference,GALLERY_ARCHIVE_RECORD_BYTES),original=currentPageRecords.get(ref.sha256);
    if(signal?.aborted)fail('当前批次读取已取消');
    if(!original||!same(original.reference,ref))fail('读取不属于当前已保全批次');return original;
  }
  async function readStagedCopy(rawReference,signal,readCopy){
    const original=stagedRecord(rawReference,signal),current=()=>{
      if(stagedRecord(rawReference,signal)!==original)fail('当前已保全批次已变化');
    };
    await verify(original);current();const result=await readCopy(original,signal);current();await verify(original);current();return result;
  }
  async function saveOriginalReference(record,response,stagedOriginal){
    const encoded=await encodeGalleryArchiveOriginal(owner,record,response);check();await verify(encoded.record);
    const stagedCurrent=()=>{if(stagedOriginal&&stagedRecord(encoded.record.reference)!==stagedOriginal)fail('原图副本不属于当前已保全批次');};
    stagedCurrent();
    if(!stagedOriginal)await inspectGalleryArchiveRecord(owner,await readObject('record',encoded.record.reference),encoded.record.reference);check();
    await putObject('original',encoded,async stored=>{
      const prior=await inspectGalleryArchiveOriginal(owner,encoded.record,stored);check();
      // Other records may change the whole-gallery hash; this record stays exact.
      if(['id','sha256','bytes','mime'].some(key=>prior.reference[key]!==encoded.value.source.reference[key])
        ||prior.original.url!==encoded.value.source.original.url)fail('原画面已有不同原图副本凭据，保留旧版未覆盖');
    },slot('original',encoded.record.reference));
    await verify(encoded.record);stagedCurrent();
    return {record:encoded.record.reference,proof:'original-reference-only',originalVerified:false,canPrune:false};
  }
  return Object.freeze({scope:Object.freeze({...owner}),
    async preserveEvidence(raw,rawSupplement,{signal}={}){
      check();const captured=captureGalleryEvidence(raw),ref=galleryArchiveSupplementReference(rawSupplement);
      return exclusive(async()=>{
        if(!same(stagedSupplement,ref))fail('正文依据所需关联资料尚未在本次保全');
        const companion=await (await supplementStore()).read(ref,{signal});check();
        if(!galleryEvidenceMatchesSupplement(captured,companion.value.receipt))fail('正文依据和关联资料来自不同资料头，未混用保存');
        if(await verifySupplement(structuredClone(companion.value.receipt))!==true)fail('正文依据关联资料来源已变化');check();
        const saved=await (await evidenceStore()).preserve(captured,{supplement:ref,signal,verify:async summary=>{
          check();if(!same(stagedSupplement,ref)||!galleryEvidenceMatchesSupplement(summary,companion.value.receipt))return false;
          const valid=await verifyEvidence(summary);check();return valid===true;
        }});mayHaveWritten=true;check();
        const finalCompanion=await (await supplementStore()).read(ref,{signal});check();
        if(!galleryEvidenceMatchesSupplement(captured,finalCompanion.value.receipt)||await verifySupplement(structuredClone(finalCompanion.value.receipt))!==true)fail('正文依据保存后关联资料来源已变化');check();
        stagedEvidence={reference:{...saved.reference},supplement:{...ref}};return saved;
      });
    },
    async readEvidence(rawReference,{signal}={}){
      check();const ref=galleryArchiveEvidenceReference(rawReference),saved=await (await evidenceStore()).read(ref,{signal});check();
      const companion=await (await supplementStore()).read(saved.supplement,{signal});check();
      if(!galleryEvidenceMatchesSupplement(saved.receipt,companion.value.receipt))fail('已保存正文依据与关联资料来源不符');return saved;
    },
    async preserveSupplement(raw){
      check();const captured=captureGallerySupplement(raw);
      return exclusive(async()=>{
        const saved=await (await supplementStore()).preserve(captured,{verify:verifySupplement});check();
        stagedSupplement=structuredClone(saved.reference);return saved;
      });
    },
    async readSupplement(rawReference,{signal}={}){
      check();const ref=galleryArchiveSupplementReference(rawReference),encoded=await (await supplementStore()).read(ref,{signal});check();
      return {receipt:encoded.value.receipt,reference:ref,proof:'supplement-readback-only',originalVerified:false,canPrune:false};
    },
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
    async preserveServerRecipe(rawRecord,rawResponse){
      check();const record=captureGalleryArchiveJson(rawRecord,GALLERY_ARCHIVE_RECORD_BYTES),response=captureGalleryArchiveJson(rawResponse,LIMIT.recordBytes);
      return exclusive(async()=>{
        const encoded=await encodeGalleryArchiveRecipe(owner,record,response);check();await verify(encoded.record);
        // The unchanged record must already have been durably read back.
        await inspectGalleryArchiveRecord(owner,await readObject('record',encoded.record.reference),encoded.record.reference);check();
        await putObject('recipe',encoded,stored=>{
          inspectGalleryArchiveRecipe(owner,encoded.record,stored);
          if(JSON.stringify(captureGalleryArchiveJson(stored,LIMIT.recordBytes))!==encoded.text)fail('原画面已有不同配方副本，保留原件未覆盖');
        },slot('recipe',encoded.record.reference));
        await verify(encoded.record);
        return {record:encoded.record.reference,proof:'recipe-readback-only',originalVerified:false,canPrune:false};
      });
    },
    async preserveLocalRecipe(rawRecord,rawLocal){
      check();const record=captureGalleryArchiveJson(rawRecord,GALLERY_ARCHIVE_RECORD_BYTES),local=captureGalleryArchiveJson(rawLocal,LIMIT.recordBytes);
      return exclusive(async()=>{
        const encoded=await encodeGalleryLocalRecipe(owner,record,local);check();await verify(encoded.record);
        await inspectGalleryArchiveRecord(owner,await readObject('record',encoded.record.reference),encoded.record.reference);check();
        const location=await galleryLocalRecipeSlot(owner,record);check();
        await putObject('local-recipe',encoded,async stored=>{
          await inspectGalleryLocalRecipe(owner,record,stored);check();
          if(JSON.stringify(stored)!==encoded.text)fail('旧配方已有不同保全副本，未覆盖');
        },location);
        const result=await readGalleryLocalRecipeCopy(storage,owner,record,{guard:check});await verify(encoded.record);
        if(result.state!=='available')fail('旧配方保存读回未确认');return result;
      });
    },
    async preserveReviewedRecipe(rawRecord,rawReview,consent){
      check();const record=captureGalleryArchiveJson(rawRecord,GALLERY_ARCHIVE_RECORD_BYTES),review=captureGalleryArchiveJson(rawReview,LIMIT.recordBytes),approval={...consent};
      return exclusive(async()=>{
        const encoded=await encodeGalleryReviewedRecipe(owner,record,review,approval);check();const original=await encodeGalleryArchiveRecord(owner,record);await verify(original);
        await inspectGalleryArchiveRecord(owner,await readObject('record',original.reference),original.reference);check();
        const location=await galleryReviewedRecipeSlot(owner,record);check();
        await putObject('reviewed-recipe',encoded,async stored=>{
          await inspectGalleryReviewedRecipe(owner,record,stored);check();if(JSON.stringify(stored)!==encoded.text)fail('此画面已有另一份核对结果，未覆盖');
        },location);
        const result=await readGalleryLocalRecipeCopy(storage,owner,record,{guard:check});await verify(original);
        if(result.state!=='available')fail('旧配方核对副本保存未确认');return result;
      });
    },
    async readRecipe(rawReference,{signal}={}){
      check();const ref=galleryArchiveObjectReference(rawReference,GALLERY_ARCHIVE_RECORD_BYTES);
      const original=await inspectGalleryArchiveRecord(owner,await readObject('record',ref,signal),ref);check();
      return readRecipeCopy(original,signal);
    },
    async preserveOriginalReference(rawRecord,rawResponse){
      check();const record=captureGalleryArchiveJson(rawRecord,GALLERY_ARCHIVE_RECORD_BYTES),response=captureGalleryArchiveJson(rawResponse,16384);
      return exclusive(()=>saveOriginalReference(record,response));
    },
    async preserveStagedOriginalReference(rawReference,rawResponse){
      const original=stagedRecord(rawReference),response=captureGalleryArchiveJson(rawResponse,16384);
      return exclusive(()=>saveOriginalReference(original.value.record,response,original));
    },
    async readOriginal(rawReference,{signal}={}){
      check();const ref=galleryArchiveObjectReference(rawReference,GALLERY_ARCHIVE_RECORD_BYTES);
      const original=await inspectGalleryArchiveRecord(owner,await readObject('record',ref,signal),ref);check();
      return readOriginalCopy(original,signal);
    },
    async readMediaRecord(rawReference,{signal}={}){
      check();const ref=galleryArchiveObjectReference(rawReference,GALLERY_ARCHIVE_RECORD_BYTES);
      const original=await inspectGalleryArchiveRecord(owner,await readObject('record',ref,signal),ref);check();
      // One selected record read, not readRecord + readOriginal duplicating it.
      const media=await readOriginalCopy(original,signal);check();
      return {record:original.value.record,recipeState:original.recipeState,reference:ref,media,originalVerified:false,canPrune:false};
    },
    async readRecoveryRecord(rawReference,{signal}={}){
      check();const ref=galleryArchiveObjectReference(rawReference,GALLERY_ARCHIVE_RECORD_BYTES);
      const original=await inspectGalleryArchiveRecord(owner,await readObject('record',ref,signal),ref);check();
      const recipe=await readRecipeCopy(original,signal);check();const media=await readOriginalCopy(original,signal);check();
      return {record:original.value.record,reference:ref,recipe,media,proof:'record-readback-only',originalVerified:false,canPrune:false};
    },
    async readStagedRecipe(rawReference,{signal}={}){
      // Only this session's last completely read-back page can reuse its record
      // bytes. The sidecar is still freshly read and validated; no persistent
      // "exists" cache, caller-injected body, fallback or deletion permission.
      return readStagedCopy(rawReference,signal,readRecipeCopy);
    },
    async readStagedOriginal(rawReference,{signal}={}){
      return readStagedCopy(rawReference,signal,readOriginalCopy);
    },
    async stagePage(raw){
      check();const captured=captureGalleryArchiveJson(raw,LIMIT.recordBytes);
      if(!Array.isArray(captured)||!captured.length||captured.length>LIMIT.rows)fail('画面保全每批须为1至128项，未裁剪');
      return exclusive(async()=>{
        currentPageRecords.clear();
        // Validate the complete batch first. Its order must already be newest
        // first; never silently reorder/deduplicate the source supplied by host.
        const encoded=[];
        for(const item of captured){await yieldWork();check();encoded.push(await encodeGalleryArchiveRecord(owner,item));check();}
        const rows=encoded.map(item=>({recordId:item.value.record.id,createdAt:item.value.record.createdAt,label:'',
          tags:galleryCatalogTags(item.value.record.tags),record:item.reference}));
        const page=await encodeGalleryIndexPage(owner,rows);check();
        if(!staged.has(page.reference.sha256)&&staged.size>=LIMIT.pages)fail('单次保全页数超过上限，已存副本保留');
        for(const item of encoded)await verify(item);
        for(const item of encoded){await yieldWork();check();await preserveEncoded(item);await new Promise(resolve=>setTimeout(resolve,0));check();}
        // Recheck all records after uploads, before making this page reachable.
        for(const item of encoded)await verify(item);
        await putObject('page',{...page,value:JSON.parse(page.text)},value=>inspectPage(value,page));check();
        for(const item of encoded)await verify(item);
        staged.set(page.reference.sha256,{descriptor:structuredClone(page.descriptor),rows:structuredClone(rows)});
        for(const item of encoded)currentPageRecords.set(item.reference.sha256,item);
        return {descriptor:structuredClone(page.descriptor),records:encoded.map(item=>({recordId:item.value.record.id,reference:item.reference,recipeState:item.recipeState})),
          persistence:'st-account-file',proof:'page-readback-only',originalVerified:false,canPrune:false};
      });
    },
    async readPage(rawReference){check();const ref=galleryArchiveObjectReference(rawReference,LIMIT.pageBytes);return indexText('page',ref);},
    async openStagedPage(rawDescriptor){
      check();const descriptor=captureGalleryArchiveJson(rawDescriptor,4096),head=await encodeGalleryIndexManifest(owner,[descriptor]);check();
      return openHead(head);
    },
    async publishSourceVersion(rawReceipt,rawPages,rawSupplement,rawEvidence){
      check();const observed=sourceReceipt(rawReceipt),pages=captureGalleryArchiveJson(rawPages,LIMIT.manifestBytes);
      const supplement=rawSupplement===undefined?undefined:galleryArchiveSupplementReference(rawSupplement);
      const evidence=rawEvidence===undefined?undefined:galleryArchiveEvidenceReference(rawEvidence);
      return exclusive(async()=>{
        const head=await encodeGalleryIndexManifest(owner,pages);check();const ids=new Set();let checkedEvidence;
        // Only pages whose complete records were verified/read back by this
        // session may publish. No caller-forged descriptors or cross-page IDs.
        for(const descriptor of pages){
          const saved=staged.get(descriptor.sha256);
          if(!saved||!same(saved.descriptor,descriptor))fail('图库目录包含尚未在本次保全的页面');
          for(const row of saved.rows){if(ids.has(row.recordId))fail('图库目录跨页画面编号重复');ids.add(row.recordId);}
        }
        if(ids.size!==observed.count)fail('图库目录尚未覆盖完整来源，未发布部分版本');
        if(supplement){
          if(!same(stagedSupplement,supplement))fail('补充资料尚未在本次保全，未发布版本');
          const encoded=await (await supplementStore()).read(supplement);check();const saved=encoded.value.receipt;
          if(saved.gallery.sha256!==observed.sha256||saved.gallery.bytes!==observed.bytes||saved.gallery.count!==observed.count
            ||saved.order.length!==ids.size||saved.order.some(id=>!ids.has(id)))fail('补充资料与图库目录或原顺序不符');
          if(await verifySupplement(structuredClone(saved))!==true)fail('补充资料来源已变化，未发布版本');check();
          if(evidence){
            if(!same(stagedEvidence,{reference:evidence,supplement}))fail('正文依据尚未在本次保全，未发布版本');
            const body=await (await evidenceStore()).read(evidence);check();
            if(!same(body.supplement,supplement)||!galleryEvidenceMatchesSupplement(body.receipt,saved))fail('正文依据和关联资料版本不符');
            checkedEvidence=galleryEvidenceSummary(body.receipt);
            if(await verifyEvidence(structuredClone(checkedEvidence))!==true)fail('正文依据来源已变化，未发布版本');check();
          }
        }
        else if(evidence)fail('正文依据版本缺少已保全的关联资料');
        // Recheck page bytes, not every original record body again. Staging
        // already read those back; first-paint readers need only small metadata.
        for(const descriptor of pages){
          await yieldWork();check();
          const ref={sha256:descriptor.sha256,bytes:descriptor.bytes};
          const expected=await encodeGalleryIndexPage(owner,staged.get(ref.sha256).rows);check();
          if(await indexText('page',ref)!==expected.text)fail('图库页面已变化，未发布目录');
          await new Promise(resolve=>setTimeout(resolve,0));check();
        }
        await putObject('manifest',{...head,value:JSON.parse(head.text)},value=>inspectPage(value,head));check();
        const value={schema:evidence?'qianmu.gallery.source-version.v3':supplement?'qianmu.gallery.source-version.v2':'qianmu.gallery.source-version.v1',scope:owner,sourceReceipt:observed,manifest:head.reference,
          ...(supplement?{supplement}:{}),...(evidence?{evidence}:{})};
        const content=JSON.stringify(value),encoded={value,text:content,reference:{sha256:await vibeDigest(content),bytes:bytes(content)}};check();
        if(checkedEvidence&&await verifyEvidence(structuredClone(checkedEvidence))!==true)fail('正文依据发布前来源已变化');check();
        await putObject('source',encoded,stored=>{if(!same(versionValue(stored,observed),value))fail('同一来源已有不同目录，两个副本均保留，未覆盖');},await sourceSlot(observed,supplement,evidence));check();
        if(checkedEvidence&&await verifyEvidence(structuredClone(checkedEvidence))!==true)fail('正文依据发布后来源已变化，副本保留但未确认');check();
        return {reference:head.reference,sourceReceipt:observed,total:ids.size,pages:pages.length,...(supplement?{supplement}:{}),...(evidence?{evidence}:{}),
          persistence:'st-account-file',proof:'version-readback-only',originalVerified:false,canPrune:false};
      });
    },
    async openSourceVersion(rawReceipt,rawSupplement,rawEvidence){
      check();const observed=sourceReceipt(rawReceipt),supplement=rawSupplement===undefined?undefined:galleryArchiveSupplementReference(rawSupplement),evidence=rawEvidence===undefined?undefined:galleryArchiveEvidenceReference(rawEvidence),location=await sourceSlot(observed,supplement,evidence);check();
      const saved=receipt(await storage.read(location,{guard:check}));if(!saved.exists)fail('此来源尚无完整图库版本，未当作空库');
      const version=versionValue(saved.value,observed),content=await indexText('manifest',version.manifest);check();
      if(!same(version.supplement,supplement)||!same(version.evidence,evidence))fail('图库版本关联资料或正文依据绑定已变化');
      const decoded=JSON.parse(content);if(decoded.total!==observed.count)fail('图库版本总数与来源不符');
      const reader=await openHead({text:content,reference:version.manifest});
      return Object.freeze({...reader,reference:version.manifest,sourceReceipt:observed,total:observed.count,...(supplement?{supplement}:{}),...(evidence?{evidence}:{}),
        proof:'version-readback-only',originalVerified:false,canPrune:false});
    },close,
  });
}
