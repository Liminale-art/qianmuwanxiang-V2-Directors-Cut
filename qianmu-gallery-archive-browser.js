import {createGalleryDiscoveryClient} from './qianmu-gallery-discovery-client.js';
import {createGalleryArchiveStorage} from './qianmu-gallery-archive-storage.js?v=1.59.290';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {galleryCatalogAccount,galleryCatalogTags} from './qianmu-gallery-catalog-contract.js';
import {loadGalleryPreviewImage} from './qianmu-gallery-preview-media.js';

// Account-bound, read-only consumer. No current chat, local recipe fallback,
// preservation, source repair, generation or deletion is reachable here.
export function createGalleryArchiveBrowser({account,headers,isCurrent=()=>true,
  createDiscovery=createGalleryDiscoveryClient,createArchive=createGalleryArchiveStorage,
  loadImage=loadGalleryPreviewImage,timeoutMs=45000}={}){
  if(typeof account!=='function'||typeof headers!=='function'||typeof isCurrent!=='function'
    ||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('图库读取环境尚未就绪');
  let closed=false,pending=false,namespace,storage,version,selection,endReason;
  let versions=new Map(),rows=new Map();const cancellation=new AbortController();
  const discovery=createDiscovery({account,headers,guard:()=>current()});
  function current(){if(closed||isCurrent()!==true)throw Error('图库页面已变化，请重新打开');return true;}
  function releaseVersion(){version?.close();version=null;storage?.close();storage=null;selection=null;rows.clear();}
  function close(reason){if(closed)return;if(reason instanceof Error)endReason=reason;closed=true;cancellation.abort();releaseVersion();versions.clear();discovery.close();}
  async function check(){
    current();const found=galleryCatalogAccount(await account());current();
    if(namespace!==undefined&&namespace!==found){const error=Error('ST 账户已变化，请重新打开图库');close(error);throw error;}
    namespace??=found;return true;
  }
  async function run(work){
    current();if(pending)throw Error('正在读取，请稍后再试');pending=true;
    let timer,stop;
    const cancelled=new Promise((_,reject)=>{stop=()=>reject(endReason||Error('图库读取已取消或超时，请重新打开'));});
    cancellation.signal.addEventListener('abort',stop,{once:true});
    timer=setTimeout(close,timeoutMs);
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
        const opened=await storage.openSourceVersion(selected.sourceReceipt);await check();
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
      const saved=await storage.readRecord(row.record);await check();
      const record=saved.record;
      if(record.id!==row.recordId||record.createdAt!==row.createdAt
        ||JSON.stringify(galleryCatalogTags(record.tags))!==JSON.stringify(row.tags))throw Error('画面记录与目录不一致，未加载图片');
      const media=await loadImage(record.url,{guard:check,signal:cancellation.signal});await check();
      return {...media,record:structuredClone(record),source:{...selection.scope},recipeState:saved.recipeState,
        originalVerified:false,canPrune:false};
    });},
    recipe(recordId){return run(async()=>{
      const row=rows.get(recordId);if(!row||!storage)throw Error('画面不在当前分页，请重新选择');
      const result=await storage.readRecipe(row.record);await check();return result;
    });},
    isClosed:()=>closed,close,
  });
}
