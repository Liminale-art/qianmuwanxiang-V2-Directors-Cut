import {createGalleryDiscoveryClient} from './qianmu-gallery-discovery-client.js';
import {createGalleryArchiveStorage} from './qianmu-gallery-archive-storage.js?v=1.59.391';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {galleryCatalogAccount,galleryCatalogTags} from './qianmu-gallery-catalog-contract.js';
import {loadGalleryPreviewImage} from './qianmu-gallery-preview-media.js';
import {createGalleryOriginalClient} from './qianmu-gallery-original-client.js?v=1.59.391';
import {decodeGalleryOriginalBlob} from './qianmu-gallery-original-preview.js';
import {createGalleryRestoreSource} from './qianmu-gallery-restore-source.js?v=1.59.391';
import {verifyGalleryRestoreOriginals} from './qianmu-gallery-restore-originals.js?v=1.59.391';

// Browsing remains read-only. Current-chat preservation is lazy and reachable
// only through the explicit preparation action, never directory opening.
export function createGalleryArchiveBrowser({account,headers,isCurrent=()=>true,
  getContext,epoch,canPrepare=()=>false,
  createDiscovery=createGalleryDiscoveryClient,createArchive=createGalleryArchiveStorage,
  createRestoration=async options=>(await import('./qianmu-gallery-restore-execution.js?v=1.59.391')).createGalleryRestoreExecution(options),
  loadImage=loadGalleryPreviewImage,createOriginal=createGalleryOriginalClient,decodeOriginal=decodeGalleryOriginalBlob,timeoutMs=45000}={}){
  if(typeof account!=='function'||typeof headers!=='function'||typeof isCurrent!=='function'
    ||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('图库读取环境尚未就绪');
  let closed=false,pending=false,namespace,storage,version,selection,endReason,originals,preparation,restoration;
  let versions=new Map(),rows=new Map();const cancellation=new AbortController();
  const discovery=createDiscovery({account,headers,guard:()=>current()});
  function current(){if(closed||isCurrent()!==true)throw Error('图库页面已变化，请重新打开');return true;}
  function releaseVersion(){restoration?.close();restoration=null;preparation=null;version?.close();version=null;storage?.close();storage=null;selection=null;rows.clear();}
  function close(reason){if(closed)return;if(reason instanceof Error)endReason=reason;closed=true;cancellation.abort();originals?.close();releaseVersion();versions.clear();discovery.close();}
  async function check(){
    current();const found=galleryCatalogAccount(await account());current();
    if(namespace!==undefined&&namespace!==found){const error=Error('ST 账户已变化，请重新打开图库');close(error);throw error;}
    namespace??=found;return true;
  }
  async function run(work,deadline=timeoutMs){
    current();if(pending)throw Error('正在读取，请稍后再试');pending=true;
    let timer,stop;
    const cancelled=new Promise((_,reject)=>{stop=()=>reject(endReason||Error('图库读取已取消或超时，请重新打开'));});
    cancellation.signal.addEventListener('abort',stop,{once:true});
    timer=setTimeout(close,deadline);
    const worker=(async()=>{await check();const result=await work();await check();return result;})();
    // A late account/file operation cannot release the busy slot prematurely.
    void worker.finally(()=>{pending=false;}).catch(()=>{});
    try{return await Promise.race([worker,cancelled]);}
    finally{clearTimeout(timer);cancellation.signal.removeEventListener('abort',stop);}
  }
  return Object.freeze({
    list(input={}){const captured=captureGalleryArchiveJson(input,4096);return run(async()=>{
      releaseVersion();versions.clear();const result=await discovery.list(captured,{signal:cancellation.signal});await check();
      versions=new Map(result.entries.map(entry=>[entry.key,structuredClone(entry.value)]));return result;
    });},
    open(key){return run(async()=>{
      const selected=versions.get(key);if(!selected)throw Error('此版本不在当前列表，请刷新后选择');
      releaseVersion();
      const candidate=await createArchive({scope:structuredClone(selected.scope),guard:current,verifyRecord:()=>false});
      try{
        await check();storage=candidate;
        const opened=await storage.openSourceVersion(selected.sourceReceipt,selected.supplement,selected.evidence);await check();
        if(JSON.stringify(opened.reference)!==JSON.stringify(selected.manifest)){opened.close();throw Error('图库版本已变化，请刷新列表');}
        version=opened;selection=structuredClone(selected);return {scope:{...selection.scope},total:version.total};
      }catch(error){candidate.close();releaseVersion();throw error;}
    });},
    page(input={}){const captured=captureGalleryArchiveJson(input,16384);return run(async()=>{
      if(!version)throw Error('请先选择已保存版本');rows.clear();const result=await version.page(captured);await check();
      rows=new Map(result.rows.map(row=>[row.recordId,structuredClone(row)]));return result;
    });},
    preview(recordId){return run(async()=>{
      const row=rows.get(recordId);if(!row||!selection||!storage)throw Error('画面不在当前分页，请重新选择');
      const saved=await storage.readMediaRecord(row.record,{signal:cancellation.signal});await check();
      const record=saved.record;
      if(record.id!==row.recordId||record.createdAt!==row.createdAt
        ||JSON.stringify(galleryCatalogTags(record.tags))!==JSON.stringify(row.tags))throw Error('画面记录与目录不一致，未加载图片');
      let media,originalVerified=false,mediaOrigin='st-original';
      if(saved.media.state==='available'){
        originals??=createOriginal({account,headers,guard:check,timeoutMs});
        const copy=await originals.read(saved.media.reference,{signal:cancellation.signal});await check();
        if(copy.originalVerified!==true||copy.proof!=='original-copy-readback'||JSON.stringify(copy.reference)!==JSON.stringify(saved.media.reference))throw Error('原图副本尚未核实');
        media=await decodeOriginal(copy.blob,{guard:check,signal:cancellation.signal});await check();originalVerified=true;mediaOrigin='server-copy';
      }else if(saved.media.state==='not-preserved'){
        media=await loadImage(record.url,{guard:check,signal:cancellation.signal});await check();
      }else throw Error('原图副本状态不兼容，未自动换图');
      return {...media,record:structuredClone(record),source:{...selection.scope},recipeState:saved.recipeState,
        mediaOrigin,originalVerified,canPrune:false};
    });},
    recipe(recordId){return run(async()=>{
      const row=rows.get(recordId);if(!row||!storage)throw Error('画面不在当前分页，请重新选择');
      const result=await storage.readRecipe(row.record);await check();return result;
    });},
    supplement(){return run(async()=>{
      if(!selection||!storage)throw Error('请先选择已保存版本');
      if(!selection.supplement)return {state:'not-preserved',receipt:null,canPrune:false};
      const result=await storage.readSupplement(selection.supplement,{signal:cancellation.signal});await check();
      const gallery=result.receipt.gallery,source=selection.sourceReceipt;
      if(gallery.sha256!==source.sha256||gallery.bytes!==source.bytes||gallery.count!==source.count)throw Error('补充资料与所选图库版本不符');
      return {state:'available',...result};
    });},
    evidence(){return run(async()=>{
      if(!selection||!storage)throw Error('请先选择已保存版本');
      if(!selection.evidence)return {state:'not-preserved',receipt:null,canPrune:false};
      const result=await storage.readEvidence(selection.evidence,{signal:cancellation.signal});await check();
      if(result.receipt.gallerySha256!==selection.sourceReceipt.sha256||JSON.stringify(result.supplement)!==JSON.stringify(selection.supplement))throw Error('正文依据与所选图库版本不符');
      return {state:'available',...result};
    });},
    review({onProgress=()=>{},verifyOriginals=false}={}){return run(async()=>{
      if(!selection||!storage)throw Error('请先选择已保存版本');
      if(typeof verifyOriginals!=='boolean')throw Error('原图核验方式无效');
      const source=await createGalleryRestoreSource({selection,archive:storage,guard:check,signal:cancellation.signal});
      try{
        if(!verifyOriginals)return await source.scan({onProgress});
        return await verifyGalleryRestoreOriginals({source,guard:check,signal:cancellation.signal,onProgress,readBatch:(references,options)=>{
          originals??=createOriginal({account,headers,guard:check,timeoutMs});return originals.readBatch(references,options);
        }});
      }finally{source.close();}
    },verifyOriginals===true?600000:180000);},
    prepare({onProgress=()=>{}}={}){return run(async()=>{
      if(!selection||!storage)throw Error('请先选择已保存版本');
      if(typeof getContext!=='function'||typeof epoch!=='function')throw Error('请在准确的原聊天中准备恢复');
      const {prepareCurrentGalleryRestore}=await import('./qianmu-gallery-restore-runtime.js?v=1.59.391');await check();
      restoration?.close();restoration=null;preparation=null;
      const result=await prepareCurrentGalleryRestore({selection,archive:storage,getContext,epoch,account,headers,guard:check,isCurrent:current,
        canPrepare,signal:cancellation.signal,onProgress});await check();if(result.compatible)preparation=structuredClone(result.reference);return result;
    },600000);},
    restorePreview({onProgress=()=>{}}={}){return run(async()=>{
      if(!selection||!storage||typeof getContext!=='function'||typeof epoch!=='function')throw Error('请在准确的原聊天中核对恢复');
      restoration?.close();restoration=null;await check();
      const opened=await createRestoration({selection,preparation,archive:storage,getContext,epoch,account,headers,guard:check,isCurrent:current,canPrepare,signal:cancellation.signal,onProgress});
      try{await check();restoration=opened;return await opened.preview();}catch(error){opened.close();restoration=null;throw error;}
    },600000);},
    restore(options){return run(async()=>{if(!restoration)throw Error('请先核对本次恢复');return restoration.execute(options);},600000);},
    finishRestore(){return run(async()=>{if(!restoration)throw Error('请先核对本次恢复');const result=await restoration.finish({confirmed:true});restoration.close();restoration=null;preparation=null;return result;},600000);},
    isClosed:()=>closed,close,
  });
}
