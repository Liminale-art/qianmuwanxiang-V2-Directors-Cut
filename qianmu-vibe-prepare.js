import {resolveStoryboardVibeRecipe,retainStoryboardVibeRecipe} from './qianmu-vibe-recipe.js';
import {retainVibeAssetRef,VIBE_ENCODING_MODELS} from './qianmu-vibe-asset-ref.js';
import {encodeNovelVibe,prepareNovelVibeEncoding} from './qianmu-vibe-encoding.js';
export {createVibeServiceClient} from './qianmu-vibe-service-client.js';

// This error describes the IMAGE submission. The separately persisted encoding may already have been charged.
const fail=(code,message,encodingState='not_submitted')=>Object.assign(new Error(message),{
  code:`storyboard_vibe_${code}`,submissionState:'not_submitted',encodingState,retryable:false,
});
const blocked=()=>fail('pending','此 Vibe 编码结果尚未确认，请核查渠道记录；未重复编码，也未提交生图','unknown');

export async function confirmVibeEncoding(title,text,{popup,confirm=value=>globalThis.confirm(value)}={}){
  if(typeof popup?.show?.confirm==='function'){
    const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    try{
      const result=await popup.show.confirm(escape(title),escape(text).replaceAll('\n','<br>'));
      // ST's affirmative result is 1. Never infer paid consent from substring matches such as "unconfirmed".
      return result===true||result===1;
    }catch(_){return false;}
  }
  return typeof confirm==='function'&&await confirm(`${title}\n${text}`)===true;
}

async function prepareVibes(payload,{namespace,model,connection,apiKey,call,readImage,checkpoint,
  guard,confirm,encode=encodeNovelVibe,service=null,allowEncoding=true,notify=()=>{}}){
  const items=resolveStoryboardVibeRecipe(payload);
  if(!items.length)return [];
  if(![call,readImage,checkpoint,guard,confirm,encode].every(fn=>typeof fn==='function'))throw fail('setup','Vibe 生成准备尚未接通');
  const binding=structuredClone(connection),identity=structuredClone(model);
  const ref=value=>{const result=retainVibeAssetRef(value);if(result.invalid||result.namespace!==namespace)throw fail('account','Vibe 原资产来自其他账户，请重新导入');return result;};
  const rpc=async(type,options)=>{await guard();const result=await call(type,{namespace,...options});await guard();return result;};
  const save=async(index,value)=>{
    const assetRef=ref(value),next=items.map((row,at)=>at===index?{...row,previewUrl:'',assetRef}:row);
    const recipe=retainStoryboardVibeRecipe({version:2,items:next});if(recipe.invalid)throw fail('recipe','原 Vibe 配置无法保全，未继续生成');
    await guard();await checkpoint(recipe);items.splice(0,items.length,...recipe.items);await guard();
  };
  // Freeze every URL before the first paid operation, not after an image has already been accepted.
  for(let index=0;index<items.length;index++){
    const item=items[index];if(item.assetRef){ref(item.assetRef);continue;}
    await guard();const image=await readImage(item.previewUrl,item.name||'Vibe');await guard();
    const assetRef=await rpc('freeze-original',{image,name:item.name});await save(index,assetRef);
  }
  // A missing/corrupt/incompatible later item must not be discovered only after paying for an earlier one.
  for(const item of items)await rpc('check',{id:item.assetRef.id,model:identity.capabilityModelId,information:item.information});
  const result=[];let bytes=0;
  for(let index=0;index<items.length;index++){
    const item=items[index],original=ref(item.assetRef),selection={id:original.id,model:identity.capabilityModelId,information:item.information};
    let image;
    try{image=await rpc('resolve',selection);}
    catch(error){
      if(error.code!=='vibe_file_missing_encoding'||!VIBE_ENCODING_MODELS[identity.capabilityModelId])throw error;
      const source=await rpc('original',{id:original.id});
      const input={...binding,version:1,provider:'novel',model:identity.remoteModelId,capabilityModelId:identity.capabilityModelId,apiKey,image:source.data,information:item.information};
      const prepared=await prepareNovelVibeEncoding(input);await guard();
      const options={cacheKey:prepared.cacheKey},cached=await rpc('encoding-get',options);
      let used,remoteState=null;
      if(cached?.status==='ready')used=ref(cached.assetRef);
      else{
        if(service){
          remoteState=await service.query(prepared);await guard();
          if(remoteState?.status==='ready'){
            const received=await service.result(prepared);await guard();
            used=ref(await rpc('attach-encoding',{...selection,encoding:received.encoding,expectedSourceId:prepared.identity.sourceId}));
            await rpc('remember-encoding',{...options,identity:prepared.identity,assetRef:used});
            if(received.channelNeedsReview)notify('Vibe 编码已取回；NAI 共用渠道尚待核查');
          }else if(remoteState&&remoteState.status!=='rejected')throw blocked();
        }
      }
      if(!used){
        if(cached&&cached.status!=='rejected')throw blocked();
        if(!allowEncoding)throw fail('service','此 Vibe 尚需编码；当前增强服务的编码入口未接通，请先导入已有编码的 Vibe 文件');
        if(bytes>=48*1024*1024)throw fail('size','本次 Vibe 已达 48 MB 上限，请减少所选项；未追加编码');
        await guard();
        const approved=await confirm('确认 Vibe 编码',`${item.name||'Vibe'} · 信息提取 ${item.information}\n此模型档位尚未缓存。NovelAI 官方每次编码收取 2 Anlas；第三方以渠道实际费用为准。仅本次编码获授权，缓存可复用。${items.length>4?' 当前超过 4 项 Vibe，官方还会按额外项数增加每张图费用，缓存不免除此费用。':''}`);
        await guard();if(approved!==true)throw fail('cancelled','已取消 Vibe 编码，未提交生图');
        const attemptId=crypto.randomUUID(),reservation=await rpc('encoding-reserve',{...options,identity:prepared.identity,attemptId,retryAttemptId:cached?.attemptId||''});
        if(!reservation.owned){if(reservation.receipt?.status==='ready')used=ref(reservation.receipt.assetRef);else throw blocked();}
        else{
          let authorized=false,completed=false,localOnly=false,channelNeedsReview=false;
          try{
            const deliver=service?(input,hooks)=>service.encode(input,hooks,remoteState?.status==='rejected'?remoteState.attemptId:''):encode;
            const encoded=await deliver(input,{guard,authorize:async(actual,key)=>{
              await guard();if(key!==prepared.cacheKey||JSON.stringify(actual)!==JSON.stringify(prepared.identity))throw fail('identity','Vibe 编码参数已变化');
              await rpc('encoding-transition',{...options,attemptId,status:'submitting'});authorized=true;return true;
            }});
            // Once the upstream returned, preserve its result under the ORIGINAL account even if the UI changed.
            // This writes only immutable local recovery data; a stale job is never allowed to use it or generate an image.
            completed=true;localOnly=encoded.serviceStored===false;channelNeedsReview=encoded.channelNeedsReview===true;
            if(!authorized||encoded.cacheKey!==prepared.cacheKey||JSON.stringify(encoded.identity)!==JSON.stringify(prepared.identity))throw fail('result','编码返回身份不符，请核查原请求','unknown');
            used=ref(await call('attach-encoding',{namespace,...selection,encoding:encoded.encoding,expectedSourceId:prepared.identity.sourceId}));
            await call('encoding-transition',{namespace,...options,attemptId,status:'ready',assetRef:used});
          }catch(error){
            const state=completed?'unknown':error?.submissionState==='rejected'?'rejected':authorized?'unknown':'rejected';
            // Local storage/RPC errors do not prove that an upstream request was uncharged.
            try{await call('encoding-transition',{namespace,...options,attemptId,status:state});}catch(_){}
            throw fail('encoding',completed?'Vibe 编码已返回，但本地关联未完成；请保留缓存并核查，未重复扣费'
              :state==='unknown'?'Vibe 编码结果未确认，请核查渠道记录，勿重复提交':error?.message||'Vibe 编码未完成',state);
          }
          await guard();notify(localOnly?'Vibe 编码已保存在本设备；服务暂存失败，请导出备份，勿重复编码':channelNeedsReview?'Vibe 编码已缓存；NAI 共用渠道尚待核查':'Vibe 编码已缓存');
        }
      }
      // Resolve the durable asset, not the transient HTTP bytes. Corruption or deletion must not trigger another charge.
      image=await rpc('resolve',{...selection,id:used.id,expectedSourceId:prepared.identity.sourceId});await save(index,used);
    }
    bytes+=image.data.length/4*3-(image.data.endsWith('==')?2:image.data.endsWith('=')?1:0);
    if(bytes>48*1024*1024)throw fail('size','本次 Vibe 合计超过 48 MB，请减少所选项；已取得的编码仍保留在缓存中');
    result.push({...image,strength:item.strength,information:item.information});
  }
  await guard();return result;
}
export async function prepareStoryboardVibes(payload,options){
  try{return await prepareVibes(payload,options);}
  catch(error){
    // Even an uncertain service RESULT read happened before this image was submitted.
    throw Object.assign(new Error(error?.message||'Vibe 准备未完成'),{code:error?.code||'storyboard_vibe_prepare',submissionState:'not_submitted',
      encodingState:error?.encodingState||error?.submissionState||'not_submitted',retryable:false});
  }
}
