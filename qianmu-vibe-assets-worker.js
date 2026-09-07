import {createVibeAssetStore} from './qianmu-vibe-asset-store.js';
import {createVibeEncodingStore} from './qianmu-vibe-encoding-store.js';
import {exportNovelVibeFile,selectNovelVibeEncoding,vibeFilePreview,vibeFileError,vibeVariants,vibeDigest,appendNovelVibeEncoding,VIBE_FILE_LIMITS} from './qianmu-vibe-file.js';
import {normalizeNovelVibeImage} from './qianmu-novel-vibe.js';
export function createVibeAssetOperations(store,{encodings}={}){
return async function run({type,namespace,id,file,ids,settings,bundle,model,information,encoding,cacheKey,identity,attemptId,retryAttemptId,status,assetRef,image,name,expectedSourceId}){
  if(type==='encoding-get')return encodings.get(namespace,cacheKey);
  if(type==='encoding-list')return encodings.list(namespace);
  if(type==='encoding-reserve')return encodings.reserve(namespace,cacheKey,identity,attemptId,{retryAttemptId});
  if(type==='encoding-transition')return encodings.transition(namespace,cacheKey,attemptId,status,{assetRef});
  if(type==='remember-encoding'){
    if(assetRef?.namespace!==namespace)throw vibeFileError('account','服务 Vibe 不能缓存到其他账户');
    const asset=await store.load(namespace,assetRef.id);if(!asset||asset.document.id!==identity?.sourceId)throw vibeFileError('source','服务编码缓存与原图不符');
    selectNovelVibeEncoding(asset.document,identity.capabilityModelId,identity.parameters?.information_extracted);
    return encodings.remember(namespace,cacheKey,identity,assetRef);
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
  if(type==='remove')return store.remove(namespace,ids);
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
  if(!['original-preview','original','resolve','check','attach-encoding'].includes(type))throw vibeFileError('operation','未知 Vibe 资产操作');
  const asset=await store.load(namespace,id);if(!asset)throw vibeFileError('missing','Vibe 原资产不存在，请重新导入');
  if(expectedSourceId!==undefined&&asset.document.id!==expectedSourceId)throw vibeFileError('source','编码缓存与原图不符，未替换素材');
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
