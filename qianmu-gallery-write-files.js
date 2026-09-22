import {createImageRestoreClient} from './qianmu-image-restore-client.js';
import {createRecipeVerificationClient} from './qianmu-recipe-verify-client.js';
import {imageRestoreReceipt} from './qianmu-image-restore-contract.js';
import {galleryRecipeResolution} from './qianmu-gallery-write-plan.js';
import {verifyGalleryLocalRecipe} from './qianmu-gallery-local-recipe.js';

// Read-only recheck before AND after a host save. It must never call restore,
// generate a replacement reference, or inspect a full saved gallery per recipe.
export async function verifyPreparedGalleryFiles({source,resolutions,headers,guard,fetchImpl,signal,onProgress=()=>{}}={}){
  const metadata=source.metadata,namespace=metadata.plan.scope.namespace,target=metadata.plan.target,rows=new Map(),images=new Map(),recipes=new Map();
  const fail=message=>{throw Error(message);};
  const check=async()=>{if(signal?.aborted||await guard()!==true||signal?.aborted)fail('恢复原件核对已取消或来源变化');return true;};
  for(const raw of resolutions){const row=galleryRecipeResolution(raw);if(rows.has(row.recordId))fail('恢复配方重复');rows.set(row.recordId,row);}
  const imageClient=createImageRestoreClient({namespace,headers,guard:check,fetchImpl}),recipeClient=createRecipeVerificationClient({namespace,headers,guard:check,fetchImpl});
  try{
    await source.scan({visit:async item=>{
      await check();if(item.origin!=='source')return;
      if(item.media.state!=='available'||item.recipe.state!=='available')fail('原图或原配方依据不完整');
      const receipt=imageRestoreReceipt(item.media.original),ref=item.media.reference,key=decodeURIComponent(receipt.url),prior=images.get(key);
      if(receipt.url!==item.record.url||['sha256','bytes','mime'].some(k=>receipt[k]!==ref[k])||prior&&['sha256','bytes','mime'].some(k=>prior[k]!==receipt[k]))fail('原图路径或内容依据不符');images.set(key,receipt);
      if(item.record.snapshot==null){
        if(item.recipe.origin==='verified-local-copy'){await verifyGalleryLocalRecipe(metadata.plan.scope,item.record,item.recipe.snapshot);return;}
        const row=rows.get(item.record.id);
        if(!row||row.createdAt!==item.record.createdAt||row.record.sha256!==item.reference.sha256||row.record.bytes!==item.reference.bytes
          ||['version','id','sha256','bytes'].some(k=>row.originalReference[k]!==item.record.snapshotServerRef?.[k]))fail('复位配方引用不是所选原画面');
        recipes.set(row.recordId,{source:{target,recordId:row.recordId,createdAt:row.createdAt},reference:row.reference});
      }
    }});
    if(recipes.size!==rows.size)fail('复位配方范围不完整');let completed=0;
    for(const receipt of images.values()){await check();if((await imageClient.inspect(receipt)).state!=='present')fail('原图文件缺失或已变化，未确认恢复');await check();
      await onProgress({phase:'verify-images',completed:++completed,total:images.size});await check();}
    completed=0;for(const recipe of recipes.values()){await recipeClient.verify(recipe,{signal});await check();await onProgress({phase:'verify-recipes',completed:++completed,total:recipes.size});await check();}
    await source.verify();await check();return {originalsVerified:images.size,recipesVerified:recipes.size,proof:'write-files-readback-only'};
  }finally{recipeClient.close();}
}
