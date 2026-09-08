import {createVibeAssetStore} from './qianmu-vibe-asset-store.js';
import {createVibeEncodingStore,validateVibeEncodingIdentity} from './qianmu-vibe-encoding-store.js';
import {exportNovelVibeFile,selectNovelVibeEncoding,vibeFilePreview,vibeFileError,vibeVariants,vibeDigest,appendNovelVibeEncoding,VIBE_FILE_LIMITS} from './qianmu-vibe-file.js';
import {normalizeNovelVibeImage} from './qianmu-novel-vibe.js';
import {exportVibeReceiptFile,inspectVibeReceiptFile,VIBE_RECEIPT_FILE_LIMIT} from './qianmu-vibe-receipt-file.js';
import {createVibeStorageOperations} from './qianmu-vibe-storage.js';
export function createVibeAssetOperations(store,{encodings,locks=globalThis.navigator?.locks}={}){
const storage=createVibeStorageOperations({store,encodings});
async function exportReceipts(namespace,rows){
  const reviewSegments=[];let bytes=2048;
  for(const row of rows){bytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if(row.reviewArchive){const history=await encodings.reviewHistory(namespace,row.cacheKey,row);
      for(const segment of history.segments){bytes+=new TextEncoder().encode(JSON.stringify(segment)).byteLength;reviewSegments.push(segment);}}
    if(bytes>VIBE_RECEIPT_FILE_LIMIT)throw vibeFileError('size','记录与核查明细超过 32 MB，请逐项导出');
  }return exportVibeReceiptFile(namespace,rows,{reviewSegments});
}
return async function run({type,namespace,id,file,ids,settings,bundle,model,information,encoding,cacheKey,identity,attemptId,retryAttemptId,status,assetRef,image,name,expectedSourceId,sourceAssetRef,delivery,serviceAttemptId,serviceDelivery,expected,proof,confirmed,after,section,key}){
  if(type==='aggregate-prepare'||type==='aggregate-verify'){
    const {createVibeAggregationOperations}=await import('./qianmu-vibe-aggregate.js'),aggregate=createVibeAggregationOperations({store});
    return type==='aggregate-prepare'?aggregate.prepare(namespace,id):aggregate.verify(namespace,id,proof);
  }
  if(type==='preservation-page'||type==='preservation-export'){
    const {createVibePreservationStore}=await import('./qianmu-vibe-preservation.js'),preserve=createVibePreservationStore();
    return type==='preservation-page'?preserve.page(namespace,section,{after}):preserve.export(namespace,section,key);
  }
  if(type==='encoding-get')return encodings.get(namespace,cacheKey);
  if(type==='storage-inventory')return storage.inventory(namespace);
  if(type==='storage-summary')return storage.summary(namespace);
  if(type==='storage-remove')return storage.remove(namespace,ids,proof,confirmed);
  if(type==='encoding-list')return encodings.list(namespace);
  if(type==='encoding-archive-page')return encodings.archivePage(namespace,{after});
  if(type==='encoding-review-history'){
    const result=await encodings.reviewHistory(namespace,cacheKey,expected);return {receipt:result.receipt,reviews:result.reviews};
  }
  if(type==='encoding-compact-reviews'){
    if(confirmed!==true)throw vibeFileError('changed','尚未确认本次核查明细整理');
    const selected=structuredClone(expected);
    if(typeof locks?.request!=='function')throw vibeFileError('storage','浏览器不支持跨页协调，暂不能整理');
    return locks.request('qianmu:nai-maintenance',{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)throw vibeFileError('busy','仍有 NAI 请求正在等待或生成，请结束后整理');
      return encodings.compactReviews(namespace,cacheKey,selected,true);
    });
  }
  if(type==='encoding-archive'){
    if(confirmed!==true||!Array.isArray(expected)||!expected.length||expected.length>40)throw vibeFileError('changed','尚未确认本次归档');
    const selected=structuredClone(expected);
    if(typeof locks?.request!=='function')throw vibeFileError('storage','浏览器不支持跨页协调，暂不能归档');
    return locks.request('qianmu:nai-maintenance',{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)throw vibeFileError('busy','仍有 NAI 请求正在等待或生成，请结束后归档');
      return encodings.archiveCompleted(namespace,selected,true);
    });
  }
  if(type==='encoding-export-page'){
    if(!Array.isArray(expected)||!expected.length||expected.length>40)throw vibeFileError('size','请选择 1～40 条记录导出');
    const selected=structuredClone(expected),rows=[];
    for(const row of selected){const current=await encodings.get(namespace,row?.cacheKey);
      if(!current||JSON.stringify(current)!==JSON.stringify(row))throw vibeFileError('changed','编码记录已变化，请刷新后导出');rows.push(current);}
    return exportReceipts(namespace,rows);
  }
  if(type==='encoding-export'){
    const rows=cacheKey?[await encodings.get(namespace,cacheKey)]:await encodings.list(namespace);
    if(cacheKey&&(!rows[0]||JSON.stringify(rows[0])!==JSON.stringify(expected)))throw vibeFileError('changed','编码记录已变化，请刷新后导出');
    return exportReceipts(namespace,rows);
  }
  if(type==='encoding-inspect-file')return inspectVibeReceiptFile(namespace,file);
  if(type==='encoding-review')return encodings.review(namespace,cacheKey,expected,delivery);
  if(type==='encoding-review-local-plan')return encodings.previewLocalReview(namespace,cacheKey,expected);
  if(type==='encoding-review-local')return encodings.reviewLocal(namespace,cacheKey,expected,proof,confirmed);
  if(type==='encoding-reserve')return encodings.reserve(namespace,cacheKey,identity,attemptId,{retryAttemptId,sourceAssetRef,delivery});
  if(type==='encoding-transition')return encodings.transition(namespace,cacheKey,attemptId,status,{assetRef});
  if(type==='remember-encoding'){
    if(assetRef?.namespace!==namespace)throw vibeFileError('account','服务 Vibe 不能缓存到其他账户');
    const asset=await store.load(namespace,assetRef.id);if(!asset||asset.document.id!==identity?.sourceId)throw vibeFileError('source','服务编码缓存与原图不符');
    selectNovelVibeEncoding(asset.document,identity.capabilityModelId,identity.parameters?.information_extracted);
    return encodings.remember(namespace,cacheKey,identity,assetRef,{serviceAttemptId,serviceDelivery});
  }
  if(type==='export-encoding'){
    const checked=await validateVibeEncodingIdentity(identity,cacheKey),info=checked.parameters.information_extracted;
    const doc={identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await vibeDigest(encoding),name:'恢复的 Vibe',
      encodings:{[checked.encodingModel]:{[await vibeDigest(`information_extracted:${info}`)]:{encoding,params:{information_extracted:info}}}},
      importInfo:{model:checked.capabilityModelId,information_extracted:info,strength:.6}};
    return new Blob([await exportNovelVibeFile([doc],{bundle:false})],{type:'application/json'});
  }
  if(type==='recover-encoding'){
    const receipt=await encodings.get(namespace,cacheKey);if(!receipt||JSON.stringify(receipt)!==JSON.stringify(expected))throw vibeFileError('changed','原编码记录已变化，请刷新');
    await validateVibeEncodingIdentity(identity,cacheKey);if(JSON.stringify(receipt.identity)!==JSON.stringify(identity))throw vibeFileError('source','领取结果与原编码请求不符');
    let source=receipt.sourceAssetRef?await store.load(namespace,receipt.sourceAssetRef.id):null;
    if(!source){const heads=await store.list(namespace);const head=heads.find(row=>row.summary.sourceId===identity.sourceId&&row.summary.hasImage);if(head)source=await store.load(namespace,head.assetId);}
    if(!source)return {sourceMissing:true};
    if(source.document.id!==identity.sourceId)throw vibeFileError('source','原文件与领取结果不符，未替换');
    const next=await appendNovelVibeEncoding(source.document,identity.capabilityModelId,identity.parameters.information_extracted,encoding);
    const [head]=await store.putFile(namespace,next.serialized),assetRef={version:1,namespace,id:head.assetId};
    const settled=await encodings.recover(namespace,cacheKey,receipt,assetRef,serviceAttemptId,serviceDelivery);
    return {...settled,assetRef};
  }
  if(type==='freeze-original'){
    const original=normalizeNovelVibeImage(image);
    const document={identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(original.data),image:original.data,
      name:typeof name==='string'?name.slice(0,100):'Vibe',encodings:{}};
    const [head]=await store.putFile(namespace,JSON.stringify(document));return {version:1,namespace,id:head.assetId};
  }
  if(type==='import'){
    if(!(file instanceof Blob)||file.size<1||file.size>VIBE_FILE_LIMITS.file)throw vibeFileError('size','Vibe 文件须在 64 MB 以内');
    return store.putFile(namespace,await file.text());
  }
  if(type==='head')return store.head(namespace,id);
  if(type==='preview')return store.preview(namespace,id);
  if(type==='usage')return store.usage(namespace);
  if(type==='list')return store.list(namespace);
  if(type==='remove')return storage.remove(namespace,ids,proof,confirmed);
  if(type==='export'){
    if(!Array.isArray(ids)||ids.length<1||ids.length>16)throw vibeFileError('size','请选择 1～16 项 Vibe 导出');
    if(settings!==undefined&&(!Array.isArray(settings)||settings.length!==ids.length||settings.some(row=>!row||typeof row.name!=='string'||row.name.length>100
      ||![row.strength,row.information].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1))))throw vibeFileError('params','导出配置无效，原文件保留');
    if(bundle!==undefined&&typeof bundle!=='boolean')throw vibeFileError('params','导出类型无效');
    // Head-only preflight bounds the entire operation before any large JSON body is deserialized.
    let bytes=128;
    for(const key of ids){const head=await store.head(namespace,key);if(!head)throw vibeFileError('missing','Vibe 资产已被清理，无法完整导出');
      bytes+=head.bytes+2048;if(bytes>VIBE_FILE_LIMITS.file)throw vibeFileError('size','导出合计超过 64 MB，请分批导出');}
    const docs=[];for(let at=0;at<ids.length;at++){
      const asset=await store.load(namespace,ids[at]);if(!asset)throw vibeFileError('missing','Vibe 资产已被清理，无法完整导出');
      let document=asset.document;const edited=settings?.[at];
      if(edited){
        const known=document.type==='image'||vibeVariants(document).some(row=>!row.customParams&&row.information===edited.information);
        // A library edit changes export defaults, never mutates the immutable encodings or invents an unknown IE.
        document={...document,name:edited.name,importInfo:{...(document.importInfo?.model?{model:document.importInfo.model}:{}),strength:edited.strength,
          ...(known?{information_extracted:edited.information}:{})}};
      }
      docs.push(document);
    }
    return new Blob([await exportNovelVibeFile(docs,{bundle:bundle??ids.length!==1})],{type:'application/json'});
  }
  if(!['original-preview','original','resolve','check','attach-encoding','library-info','export-reviewed'].includes(type))throw vibeFileError('operation','未知 Vibe 资产操作');
  const asset=await store.load(namespace,id);if(!asset)throw vibeFileError('missing','Vibe 原资产不存在，请重新导入');
  if(expectedSourceId!==undefined&&asset.document.id!==expectedSourceId)throw vibeFileError('source','编码缓存与原图不符，未替换素材');
  if(type==='library-info'||type==='export-reviewed'){
    // A receipt identifies one exact variant; old file defaults may point at another model or IE.
    selectNovelVibeEncoding(asset.document,model,information);
    const strength=asset.document.importInfo?.strength??.6;
    if(type==='library-info')return {name:asset.summary.name,defaults:{strength,information}};
    const document={...asset.document,importInfo:{model,information_extracted:information,strength}};
    return new Blob([await exportNovelVibeFile([document],{bundle:false})],{type:'application/json'});
  }
  if(type==='original'){
    if(asset.document.type!=='image')throw vibeFileError('image','此 Vibe 没有原图，不能重新编码');
    return {data:asset.document.image};
  }
  if(type==='attach-encoding'){
    const next=await appendNovelVibeEncoding(asset.document,model,information,encoding);
    const [head]=await store.putFile(namespace,next.serialized);return {version:1,namespace,id:head.assetId};
  }
  if(type==='original-preview')return vibeFilePreview(asset.document,{original:true});
  if(type==='resolve'||type==='check'){
    if(['nai-diffusion-3','nai-diffusion-furry-3'].includes(model)){
      if(asset.document.type!=='image')throw vibeFileError('model','V3 需要原图，不能使用纯编码 Vibe');
      return {kind:'image',information,...(type==='resolve'?{data:asset.document.image}:{})};
    }
    let selected;
    try{selected=selectNovelVibeEncoding(asset.document,model,information);}
    catch(error){
      // Selecting an original is free. A missing supported encoding is prepared only during generation with consent.
      if(type==='check'&&asset.document.type==='image'&&error.code==='vibe_file_missing_encoding')return {kind:'needs-encoding',information};
      throw error;
    }
    return {kind:'novelai-vibe-encoding',encodingModel:selected.model,variant:selected.variant,information:selected.information,...(type==='resolve'?{data:selected.encoding}:{})};
  }
};
}
const run=createVibeAssetOperations(createVibeAssetStore(),{encodings:createVibeEncodingStore()});let pending=Promise.resolve();
if(typeof self!=='undefined')self.addEventListener('message',event=>{
  const message=event.data;if(!message||typeof message.ticket!=='number')return;
  // Serial reads/imports bound peak memory; only metadata, a preview or the selected encoding crosses back.
  pending=pending.then(async()=>{
    try{self.postMessage({ticket:message.ticket,value:await run(message)});}
    catch(error){self.postMessage({ticket:message.ticket,error:{code:typeof error?.code==='string'?error.code:'vibe_file_storage',message:error?.message||'Vibe 操作失败'}});}
  }).catch(()=>{});
});
