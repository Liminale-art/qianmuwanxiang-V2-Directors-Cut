import {createImageRestoreClient} from './qianmu-image-restore-client.js';
import {createGalleryOriginalClient} from './qianmu-gallery-original-client.js';
import {createRecipeRestoreClient} from './qianmu-recipe-restore-client.js';
import {imageRestoreReceipt} from './qianmu-image-restore-contract.js';
import {galleryOriginalReference} from './qianmu-gallery-original-contract.js';
import {recipeArchiveReference} from './qianmu-recipe-archive-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),scope='gallery-prepared-assets-only';
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_restore_assets',submissionState:'not_submitted'});};
// Completes FILE dependencies of a durable paged preparation. Never assigns
// chat metadata or saves ST. A caller must subsequently journal and revalidate
// the host write. Unknown writes retain originals and require fresh inspection.
export function createPreparedGalleryAssets({source,account,headers,guard,verifyCurrent,signal,fetchImpl=globalThis.fetch,
  onProgress=()=>{},timeoutMs=600000}={}){
  if(!source?.metadata||![account,headers,guard,verifyCurrent,fetchImpl,onProgress].every(fn=>typeof fn==='function')
    ||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>600000)fail('恢复原件缺少准确方案或来源保护');
  const selected=source.metadata,namespace=selected.plan.scope.namespace,target=selected.plan.target;
  let closed=false,busy=false,preview=null,cancel;
  const close=()=>{closed=true;preview=null;cancel?.();};signal?.addEventListener('abort',close,{once:true});if(signal?.aborted)close();
  async function operation(work){
    if(closed||busy)fail('恢复原件已结束或正在处理');busy=true;let attempted=false,originals=0,recipes=0,reject;
    const controller=new AbortController(),cancelled=new Promise((_,no)=>reject=no);
    const abort=()=>{controller.abort();reject(Error('恢复原件已取消或超时'));};cancel=abort;
    const timer=setTimeout(abort,timeoutMs),clients=[];
    async function check(){if(closed||controller.signal.aborted||await guard()!==true||await account()!==namespace||closed||controller.signal.aborted)fail('恢复原件账户或页面已变化');return true;}
    async function current(options={deep:true}){await check();if(await verifyCurrent(options)!==true)fail('当前聊天基线已变化，未继续恢复原件');await check();}
    async function fetchLinked(url,options){
      await check();const linked=new AbortController();
      const stop=()=>{linked.abort();controller.signal.removeEventListener('abort',stop);options.signal.removeEventListener('abort',stop);};
      controller.signal.addEventListener('abort',stop,{once:true});options.signal.addEventListener('abort',stop,{once:true});
      if(controller.signal.aborted||options.signal.aborted)stop();
      try{return await fetchImpl(url,{...options,signal:linked.signal});}catch(error){stop();throw error;}
    }
    const images=createImageRestoreClient({namespace,headers,fetchImpl:fetchLinked,guard:check}),copies=createGalleryOriginalClient({account,headers,fetchImpl:fetchLinked,guard:check}),recipeClient=createRecipeRestoreClient({namespace,headers,fetchImpl:fetchLinked,guard:check});clients.push(copies,recipeClient);
    const op={check,current,images,copies,recipeClient,signal:controller.signal,mark:kind=>{attempted=true;if(kind==='original')originals++;else recipes++;},
      progress:async value=>{await onProgress(value);await check();}};
    const worker=(async()=>{await current();return work(op);})();
    void worker.finally(()=>{busy=false;}).catch(()=>{});
    try{return await Promise.race([worker,cancelled]);}
    catch(cause){preview=null;if(attempted)closed=true;throw Object.assign(Error(attempted?'原件写入未完整确认；已保存文件保留，请重新核对，未自动重传或改写聊天':cause.message),{
      code:'gallery_restore_assets',cause,assetsState:attempted?'needs_review':'not_started',attempts:{originals,recipes},metadataRestored:false,submissionState:'not_submitted'});}
    finally{clearTimeout(timer);controller.abort();clients.forEach(client=>client.close());cancel=null;if(closed)signal?.removeEventListener('abort',close);}
  }
  async function inspect(op){
    const images=new Map(),recipes=[];let selectedCount=0,inline=0;
    await source.scan({onProgress:async value=>{await op.progress({phase:'records',...value});},visit:async item=>{
      await op.check();if(item.origin!=='source')return;selectedCount++;
      if(item.media.state!=='available')fail('所选版本缺少独立原图依据，未用现有地址或重新生成猜补');
      const reference=galleryOriginalReference(item.media.reference),receipt=imageRestoreReceipt(item.media.original);
      if(receipt.url!==item.record.url||reference.sha256!==receipt.sha256||reference.bytes!==receipt.bytes||reference.mime!==receipt.mime)fail('所选原图副本与原记录不符');
      const key=decodeURIComponent(receipt.url),existing=images.get(key);
      if(existing&&['sha256','bytes','mime'].some(field=>existing.receipt[field]!==receipt[field]))fail('同一原图路径对应不同内容，未开始写入');
      if(!existing)images.set(key,{receipt,reference});
      if(item.recipe.state!=='available')fail('所选版本缺少完整原配方，未使用当前配置补齐');
      if(item.record.snapshot!=null){inline++;return;}
      recipes.push({index:item.index,recordId:item.record.id,createdAt:item.record.createdAt,record:item.reference,reference:recipeArchiveReference(item.record.snapshotServerRef)});
    }});
    await op.current();
    let inspected=0;for(const row of images.values()){await op.check();row.state=(await op.images.inspect(row.receipt)).state;await op.progress({phase:'preflight',completed:++inspected,total:images.size});}
    await op.current();await source.verify();await op.check();
    const view={scope,preparation:selected.reference,records:selectedCount,originals:images.size,missing:[...images.values()].filter(row=>row.state==='missing').length,
      conflicts:[...images.values()].filter(row=>row.state==='conflict').length,serverRecipes:recipes.length,inlineRecipes:inline,metadataRestored:false,canPrune:false};
    const digest=await vibeDigest(JSON.stringify({view,images:[...images.values()],recipes}));await op.check();
    return {view:{...view,digest,ready:view.conflicts===0},images:[...images.values()],recipes};
  }
  return Object.freeze({
    preview(){return operation(async op=>{preview=null;const result=await inspect(op);preview=structuredClone(result.view);return structuredClone(preview);});},
    restore({confirmed=false,expectedDigest,scope:requestedScope,onRecipeResolved=async()=>{}}={}){
      if(confirmed!==true||requestedScope!==scope||!preview?.ready||expectedDigest!==preview.digest||typeof onRecipeResolved!=='function')return Promise.reject(Error('请核对并明确确认原图与原配方文件恢复'));
      const wanted=expectedDigest;preview=null;
      return operation(async op=>{
        const prepared=await inspect(op);if(!prepared.view.ready||prepared.view.digest!==wanted)fail('原件状态或方案已变化，请重新核对并确认');
        let completed=0;
        for(const row of prepared.images){
          await op.check();if(row.state==='missing'){
            const read=await op.copies.read(row.reference,{signal:op.signal});await op.check();
            const bytes=new Uint8Array(await read.blob.arrayBuffer());await op.check();let data='';
            for(let at=0;at<bytes.length;at+=8192){data+=String.fromCharCode(...bytes.subarray(at,at+8192));if(at%131072===0){await new Promise(resolve=>setTimeout(resolve,0));await op.check();}}
            await op.current({deep:false});op.mark('original');await op.images.restore(row.receipt,btoa(data),{confirmed:true});await op.check();
          }
          if((await op.images.inspect(row.receipt)).state!=='present')fail('原图路径读回未确认');
          await op.progress({phase:'originals',completed:++completed,total:prepared.images.length});
        }
        await op.current();completed=0;
        for(const row of prepared.recipes){
          const item=await source.readSelected(row.index);await op.check();
          if(!same(item.reference,row.record)||item.recipe.state!=='available'||!same(item.record.snapshotServerRef,row.reference))fail('原配方或原记录在恢复期间已变化');
          op.mark('recipe');const receipt=await op.recipeClient.restore({source:{target,recordId:row.recordId,createdAt:row.createdAt},snapshot:item.recipe.snapshot,originalReference:row.reference},{confirmed:true,signal:op.signal});await op.check();
          await onRecipeResolved({recordId:row.recordId,createdAt:row.createdAt,record:structuredClone(row.record),originalReference:structuredClone(row.reference),reference:structuredClone(receipt.reference)});await op.check();
          await op.progress({phase:'recipes',completed:++completed,total:prepared.recipes.length});
        }
        await op.current();for(const row of prepared.images){if((await op.images.inspect(row.receipt)).state!=='present')fail('最终核对发现原图变化');await op.check();}
        await source.verify();await op.current();
        return {...prepared.view,originalsVerified:prepared.images.length,recipesResolved:prepared.recipes.length,
          proof:'prepared-assets-readback-only',restoreReady:false,metadataRestored:false,canPrune:false};
      });
    },close(){signal?.removeEventListener('abort',close);close();},
  });
}
