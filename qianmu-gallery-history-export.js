import {galleryCatalogAccount,galleryCatalogSource} from './qianmu-gallery-catalog-contract.js';
import {galleryDirectoryTarget} from './qianmu-gallery-directory.js';
import {createChatGalleryReceiptClient,createChatGalleryRecordClient} from './qianmu-chat-character-receipt-client.js';
import {captureHistoricalStoryboardSource} from './qianmu-historical-storyboard-source.js';
import {captureHistoricalStoryboardBundle} from './qianmu-historical-storyboard-bundle.js';
import {loadGalleryPreviewImage} from './qianmu-gallery-preview-media.js';
import {comfyReferencePath} from './qianmu-comfy-reference-contract.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'gallery_history_export',submissionState:'not_submitted'});};
// One explicitly confirmed saved chat, not the catalog's subset/count and not a
// current-host backup. No source writes, catalog edits, remote URLs or auto fallback.
export async function exportGalleryHistory({namespace,source,confirmed=false,resolveNamespace,guard,headers=()=>({}),save,
  signal,parentSignal,onProgress=()=>{},timeoutMs=600000,fetchImpl=globalThis.fetch,loadImage=loadGalleryPreviewImage}={}){
  namespace=galleryCatalogAccount(namespace);source=galleryCatalogSource(source);
  if(confirmed!==true||typeof resolveNamespace!=='function'||typeof guard!=='function'||typeof save!=='function'||typeof headers!=='function'
    ||typeof onProgress!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1)fail('请先确认准确聊天和原件保全范围');
  const target=galleryDirectoryTarget(source),controller=new AbortController(),readers=[];
  let session,reject;
  const cancelled=new Promise((_,no)=>reject=no);
  const abort=()=>{controller.abort();session?.close();for(const reader of readers)reader.close();reject(Object.assign(new Error('历史原件保全已取消或超时，未下载不完整文件'),{code:'gallery_history_export'}));};
  const check=async()=>{
    if(controller.signal.aborted)fail('历史原件保全已停止');await guard();
    if(controller.signal.aborted)fail('历史原件保全已停止');
    if(await resolveNamespace()!==namespace)fail('ST 账户已变化，未下载原账户资料');
    if(controller.signal.aborted)fail('历史原件保全已停止');await guard();if(controller.signal.aborted)fail('历史原件保全已停止');
  };
  const signals=[signal,parentSignal].filter(Boolean);for(const item of signals)item.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,Math.min(600000,timeoutMs));
  try{
    if(signals.some(item=>item.aborted))abort();
    return await Promise.race([(async()=>{
      await check();onProgress({phase:'source',completed:0,total:null});await check();
      const options={namespace,target,headers,guard:check,fetchImpl,timeoutMs:30000};
      const receiptReader=createChatGalleryReceiptClient(options),recordReader=createChatGalleryRecordClient(options);readers.push(receiptReader,recordReader);
      const receipt=await receiptReader.inspect({signal:controller.signal});await check();
      if(receipt.state!=='present')fail('原聊天没有已保存的静帧资料；没有用本机目录或当前聊天补齐');
      if(receipt.gallery.count>400)fail('此聊天超过单次 400 张上限，未截断为部分备份；可先在阅片目录分批保全原图');
      session=await captureHistoricalStoryboardSource({...options,timeoutMs:180000,requestTimeoutMs:30000,gallerySha256:receipt.gallery.sha256,account:resolveNamespace,signal:controller.signal});await check();
      const total=session.source.selection.total;
      if(session.source.selection.ids.length!==total||total!==receipt.gallery.count)fail('原聊天画面范围已变化，未下载部分资料');
      let completed=0;
      const result=await captureHistoricalStoryboardBundle({session,guard:check,signal:controller.signal,readImage:async(selected,readOptions)=>{
        await check();onProgress({phase:'images',completed,total});await check();
        const selection={recordId:selected.recordId,createdAt:selected.createdAt,gallerySha256:selected.gallerySha256};
        const record=await recordReader.read(selection,{signal:readOptions.signal});await check();
        if(record.record.url!==comfyReferencePath(selected.url))fail('原画面路径与捕获原件不符，未混用其他文件');
        const media=await loadImage(record.record.url,{...readOptions,guard:check});await check();completed++;
        if(completed===total)onProgress({phase:'packing',completed,total});
        return media.blob;
      }});await check();
      const filename=`qianmu-history-originals-${total}-${Date.now()}.qmb`;
      onProgress({phase:'saving',completed:total,total});await check();
      // The host's existing synchronous download handoff remains the only write.
      await save(result.file,filename);return {filename,count:total,bytes:result.file.size,summary:result.summary};
    })(),cancelled]);
  }finally{clearTimeout(timer);for(const item of signals)item.removeEventListener('abort',abort);controller.abort();session?.close();for(const reader of readers)reader.close();}
}
