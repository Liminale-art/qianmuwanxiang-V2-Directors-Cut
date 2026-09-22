import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {galleryLocalRecipeReference,encodeGalleryLocalRecipe,inspectGalleryLocalRecipe,readGalleryLocalRecipeCopy,readLegacyGalleryRecipe} from './qianmu-gallery-local-recipe.js';
import {galleryLegacyRecipeReference} from './qianmu-gallery-reviewed-recipe.js';

// Current-record consumption for redraw/export/edit. It does not migrate,
// attach metadata, use current drawing settings, or borrow an unscoped cache.
export async function readCurrentGalleryLocalRecipe({record,getContext,epoch,account,createStorage=createConfiguredStAccountStorage,readLocal=readLegacyGalleryRecipe,timeoutMs=12000}={}){
  const copy=captureGalleryArchiveJson(record,1024*1024),signature=JSON.stringify(copy),host=captureCurrentChatSource({getContext,epoch});
  let closed=false,storage,timer,namespace,liveRecord;const fail=()=>{throw Error('原配方读取已取消或画面来源变化');};
  const close=()=>{closed=true;host.close();storage?.close();};
  function check(){if(closed)fail();host.assertCurrent();const rows=getContext().chatMetadata.story_director_liminale?.storyboardImages;
    const matches=Array.isArray(rows)?rows.filter(row=>row?.id===copy.id):[];
    if(matches.length!==1||JSON.stringify(captureGalleryArchiveJson(record,1024*1024))!==signature||JSON.stringify(captureGalleryArchiveJson(matches[0],1024*1024))!==signature)fail();
    if(liveRecord&&matches[0]!==liveRecord)fail();liveRecord=matches[0];return true;}
  async function guard(){check();if(await account()!==namespace)fail();check();return true;}
  if(typeof account!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000){close();throw Error('旧配方读取缺少账户保护');}
  const work=async()=>{
    check();namespace=await account();check();const scope={namespace,...host.source};
    const strong=galleryLocalRecipeReference(scope,copy),legacy=galleryLegacyRecipeReference(scope,copy);
    if(!strong&&!legacy)throw Error('旧本机配方引用无法核对，未猜补');
    let row;if(strong)try{row=await readLocal(copy.snapshotRef);}catch{row=null;}await guard();
    if(row){const encoded=await encodeGalleryLocalRecipe(scope,copy,row);await guard();const checked=await inspectGalleryLocalRecipe(scope,copy,encoded.value);await guard();return checked.snapshot;}
    const opened=await createStorage({maxBytes:2*1024*1024,isCurrent:()=>{try{return check();}catch{return false;}}});
    try{await guard();if(opened.namespace!==namespace)fail();storage=opened;}catch(error){opened.close();throw error;}
    const result=await readGalleryLocalRecipeCopy(storage,scope,copy,{guard:check});await guard();
    if(result.state!=='available')throw Error(legacy?'请在原设备打开画面大图，先使用「核对旧配方」；未借用本机缓存或当前设置':'原配方仍只在旧设备，尚未保全；未使用当前设置替代');return result.snapshot;
  };
  try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{close();reject(Error('原配方读取超时，未使用不完整内容'));},timeoutMs);})]);}
  finally{clearTimeout(timer);close();}
}
