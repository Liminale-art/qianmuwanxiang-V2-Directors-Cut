import {createConfiguredStAccountStorage,stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {createVibeNativeOriginals,vibeNativeHeadText,VIBE_NATIVE_ORIGINAL_SLOT,VIBE_NATIVE_ORIGINAL_LIMITS} from './qianmu-vibe-native-original.js';
import {parseNovelVibeFile,vibeFileError,vibeFilePreview} from './qianmu-vibe-file.js';
import {vibeAssetNamespace,vibeAssetKey,validateVibeAssetHead,VIBE_ASSET_LIMITS} from './qianmu-vibe-asset-contract.js';
import {parseBoundedJson} from './qianmu-json-input.js';

export const VIBE_NATIVE_SLOT='vibe-assets';
const schema='qianmu.vibe.assets.v1',maxIndex=8*1048576,utf8=new TextEncoder();
const fail=message=>{throw vibeFileError('native_store',message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),size=value=>utf8.encode(JSON.stringify(value)).length;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const empty=namespace=>({schema,namespace,revision:0,assets:[],retired:[]});
const textHead=(text,namespace)=>{
  const head=parseBoundedJson(text,{maxBytes:VIBE_NATIVE_ORIGINAL_LIMITS.head,maxDepth:32,maxNodes:50000,label:'Vibe 目录'});
  validateVibeAssetHead(head,namespace);if(JSON.stringify(head)!==text)fail('Vibe 目录格式不一致');return head;
};
const totals=heads=>({count:heads.length,bytes:heads.reduce((n,h)=>n+h.bytes,0),previewBytes:heads.reduce((n,h)=>n+(h.previewBytes??0),0)});
function inspectIndex(value,namespace,scope){
  if(!exact(value,['schema','namespace','revision','assets','retired'])||value.schema!==schema||value.namespace!==namespace
    ||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.assets)||value.assets.length>1024
    ||!Array.isArray(value.retired)||value.retired.length>8192||size(value)>maxIndex)fail('Vibe 原生目录格式或容量无效');
  const seen=new Set(),heads=[],activeRows=new Set(value.assets);
  for(const row of [...value.assets,...value.retired]){
    if(!exact(row,['assetId','headText','original','legacy'])||!Array.isArray(row.legacy)||row.legacy.length>256)fail('Vibe 原生原件目录无效');
    const head=textHead(row.headText,namespace);if(row.assetId!==head.assetId||seen.has(head.assetId))fail('Vibe 原生目录存在重复或错误资产');seen.add(head.assetId);
    stAccountImmutableReference(row.original,{scope,slot:VIBE_NATIVE_ORIGINAL_SLOT,maxBytes:VIBE_NATIVE_ORIGINAL_LIMITS.manifest+1024});
    const sources=new Set([row.headText]);for(const source of row.legacy){
      if(!exact(source,['headText','original'])||textHead(source.headText,namespace).assetId!==head.assetId||sources.has(source.headText))fail('Vibe 旧源目录重复或归属不符');sources.add(source.headText);
      stAccountImmutableReference(source.original,{scope,slot:VIBE_NATIVE_ORIGINAL_SLOT,maxBytes:VIBE_NATIVE_ORIGINAL_LIMITS.manifest+1024});
    }
    if(activeRows.has(row))heads.push(head);
  }
  const usage=totals(heads);if(usage.bytes+usage.previewBytes>VIBE_ASSET_LIMITS.bytes)fail('Vibe 活跃文件超过512 MiB，未裁剪');return heads;
}

// Same-account native catalogue, exact immutable originals and retained removal
// markers. Old IDB rows are read only. Native failures never fall back to IDB.
// Optimistic readback detects conflicts; this is NOT a cross-device CAS.
export function createNativeVibeAssetStore({legacy,createStorage=createConfiguredStAccountStorage,now=Date.now,onProgress=()=>{}}={}){
  let opening,client,closed=false,owner='',known=false,queue=Promise.resolve();
  const alive=()=>{if(closed)fail('Vibe 储存会话已结束');};
  function operation(namespace,options,work){
    vibeAssetNamespace(namespace);const check=async()=>{alive();if(options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('Vibe 页面或账户已变化');
      if(await options.guard?.()===false)fail('Vibe 页面核对未通过');alive();if(options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('Vibe 页面或账户已变化');return true;};
    const task=queue.catch(()=>{}).then(async()=>{
      await check();if(owner&&owner!==namespace)fail('Vibe 会话不能切换ST账户');owner=namespace;
      opening??=Promise.resolve().then(()=>createStorage({maxBytes:maxIndex,isCurrent:()=>!closed})).then(value=>{
        if(closed||value.namespace!==namespace){value.close();fail('Vibe 储存账户不符或会话已结束');}client=value;return value;
      }).catch(error=>{opening=null;throw error;});await opening;await check();
      const transport={guard:check,signal:options.signal},originals=createVibeNativeOriginals(client,{...transport,onProgress});
      const read=async()=>{const result=await client.read(VIBE_NATIVE_SLOT,transport);await check();if(!result.exists&&known)fail('已确认的Vibe目录缺失，未重建空库');
        if(result.exists){inspectIndex(result.value,namespace,client.scope);known=true;}return result;};
      const old=async()=>{const value=await legacy.inventory(namespace);await check();return value;};
      let found=await read(),index=found.exists?structuredClone(found.value):empty(namespace);const baseline=await old();
      const unchanged=async()=>{if(!same(await old(),baseline))fail('旧页面修改了Vibe资料，未覆盖，请重新核对');};
      const save=async next=>{
        inspectIndex(next,namespace,client.scope);await unchanged();
        const result=await client.write(VIBE_NATIVE_SLOT,next,{...transport,expectedFingerprint:found.fingerprint});known=true;await check();
        if(!same(result.value,next))fail('Vibe目录尚未完整读回');await unchanged();if((await read()).fingerprint!==result.fingerprint)fail('另一端修改了Vibe目录，请重新核对');
        found=result;index=structuredClone(next);await onProgress({kind:'vibe-catalogue',stage:'verified'});await check();
      };
      const find=id=>[...index.assets,...index.retired].find(row=>row.assetId===id);
      // Preflight the entire legacy census, but preserve one complete original
      // at a time. First record publishes immediately; later batches cap at 8.
      const active=new Map(index.assets.map(row=>{const h=textHead(row.headText,namespace);return[h.assetId,h];}));
      const retired=new Set(index.retired.map(row=>row.assetId));
      for(const head of baseline.heads){vibeNativeHeadText(head,namespace);if(!active.has(head.assetId)&&!retired.has(head.assetId))active.set(head.assetId,head);}
      const usage=totals([...active.values()]);if(usage.count>1024||usage.bytes+usage.previewBytes>VIBE_ASSET_LIMITS.bytes)fail('合并后的Vibe资料超过保护上限，旧资料已保留，未裁剪');
      let staged=0,published=false;
      for(const head of baseline.heads){
        await check();const row=find(head.assetId),headText=JSON.stringify(head);
        if(row&&(row.headText===headText||row.legacy.some(source=>source.headText===headText)))continue;
        const asset=await legacy.load(namespace,head.assetId);await check();if(!asset)fail('旧Vibe原件缺失，未视作空库');
        const preview=(head.previewBytes??0)>0?await legacy.preview(namespace,head.assetId):null;await check();
        const saved=await originals.preserve({head,serialized:asset.serialized,preview});await unchanged();
        const source={headText,original:saved.reference};if(row)row.legacy.push(source);else index.assets.push({assetId:head.assetId,...source,legacy:[]});staged++;
        if(!published||staged>=8){index.revision++;await save(index);published=true;staged=0;}
      }
      if(staged){index.revision++;await save(index);}
      const state={get index(){return index;},find:id=>index.assets.find(row=>row.assetId===id),originals,check,
        save:async next=>{next.revision=index.revision+1;await save(next);}};
      const result=await work(state);await check();await unchanged();if((await read()).fingerprint!==found.fingerprint)fail('Vibe目录在读取期间变化，请重新核对');return result;
    });queue=task;return task;
  }
  const inventory=state=>{
    const heads=state.index.assets.map(row=>textHead(row.headText,owner)),usage={key:owner,...totals(heads),limit:VIBE_ASSET_LIMITS.bytes};
    const retained=totals(state.index.retired.map(row=>textHead(row.headText,owner))),records=[...state.index.assets,...state.index.retired].flatMap(row=>[row,...row.legacy]);
    return {heads,usage,metadata:{bytes:size(state.index)+records.reduce((n,row)=>n+row.original.bytes,0),count:1+records.length},persistence:'st-account-file',
      retained:{count:retained.count,bytes:retained.bytes+retained.previewBytes},concurrency:'optimistic-non-cas'};
  };
  return Object.freeze({
    list(namespace){return operation(namespace,{},state=>inventory(state).heads);},
    head(namespace,id){vibeAssetKey(namespace,id);return operation(namespace,{},state=>{const row=state.find(id);return row?textHead(row.headText,namespace):null;});},
    load(namespace,id){vibeAssetKey(namespace,id);return operation(namespace,{},state=>{const row=state.find(id);return row?state.originals.load(row.original,textHead(row.headText,namespace)):null;});},
    preview(namespace,id){vibeAssetKey(namespace,id);return operation(namespace,{},state=>{const row=state.find(id);return row?state.originals.preview(row.original,textHead(row.headText,namespace)):null;});},
    usage(namespace){return operation(namespace,{},state=>{const {usage}=inventory(state);return {...usage,estimatedBytes:usage.bytes+usage.previewBytes};});},
    inventory(namespace){return operation(namespace,{},inventory);},
    async putFile(namespace,text,options={}){
      const captured={...options};vibeAssetNamespace(namespace);alive();if(captured.isCurrent&&captured.isCurrent()!==true)fail('Vibe导入页面已变化');const parsed=await parseNovelVibeFile(text);
      return operation(namespace,captured,async state=>{
        const unique=[...new Map(parsed.map(asset=>[asset.assetId,asset])).values()],next=structuredClone(state.index),savedHeads=new Map();
        const current=inventory(state).usage;let count=current.count,bytes=current.bytes+current.previewBytes;
        for(const asset of unique)if(!state.find(asset.assetId)){count++;bytes+=asset.bytes+(vibeFilePreview(asset.document)?.size||0);}
        if(count>1024||bytes>VIBE_ASSET_LIMITS.bytes)fail('Vibe资产达到1024份或512 MiB上限，请先导出整理');
        for(const asset of unique){await state.check();const prior=state.find(asset.assetId);
          if(prior){const head=textHead(prior.headText,namespace),existing=await state.originals.load(prior.original,head);if(existing.serialized!==asset.serialized)fail('同编号Vibe原件不一致');savedHeads.set(asset.assetId,head);continue;}
          const preview=vibeFilePreview(asset.document),head={key:vibeAssetKey(namespace,asset.assetId),namespace,assetId:asset.assetId,bytes:asset.bytes,previewBytes:preview?.size||0,summary:asset.summary,createdAt:now()};
          const saved=await state.originals.preserve({head,serialized:asset.serialized,preview}),headText=JSON.stringify(head);
          const retiredAt=next.retired.findIndex(row=>row.assetId===asset.assetId),legacy=[];
          if(retiredAt>=0){const old=next.retired.splice(retiredAt,1)[0];for(const source of [{headText:old.headText,original:old.original},...old.legacy])if(source.headText!==headText)legacy.push(source);}
          next.assets.push({assetId:asset.assetId,headText,original:saved.reference,legacy});savedHeads.set(asset.assetId,head);
        }
        if(!same(next,state.index))await state.save(next);
        return parsed.map(asset=>({...savedHeads.get(asset.assetId),defaults:{strength:asset.document.importInfo?.strength??.6,information:asset.document.importInfo?.information_extracted??asset.summary.variants.find(row=>row.information!==null)?.information??1}}));
      });
    },
    remove(namespace,ids,{expectedHeads,isCurrent=()=>true,...options}={}){
      if(!Array.isArray(ids)||ids.length>1024||new Set(ids).size!==ids.length)fail('Vibe清理选择无效');const chosen=[...ids];chosen.forEach(id=>vibeAssetKey(namespace,id));
      const expected=expectedHeads===undefined?undefined:structuredClone(expectedHeads);
      if(expected&&(!Array.isArray(expected)||expected.length!==chosen.length||new Set(expected.map(head=>head.assetId)).size!==chosen.length||expected.some(head=>!chosen.includes(validateVibeAssetHead(head,namespace).assetId))))fail('Vibe清理快照不匹配');
      return operation(namespace,{...options,isCurrent},async state=>{
        const next=structuredClone(state.index);let removed=0,retainedBytes=0;
        for(const id of chosen){const at=next.assets.findIndex(row=>row.assetId===id),head=at<0?null:textHead(next.assets[at].headText,namespace);
          if(expected&&!same(head,expected.find(row=>row.assetId===id)))fail('Vibe文件已变化，未移出目录');if(at<0)continue;
          next.retired.push(next.assets.splice(at,1)[0]);removed++;retainedBytes+=head.bytes+(head.previewBytes??0);
        }
        if(removed)await state.save(next);return {removed,bytes:0,retained:true,retainedBytes};
      });
    },
    close(){closed=true;client?.close();legacy.close();},
  });
}
