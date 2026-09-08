import {inspectStoryboardPackageFile} from './qianmu-storyboard-package-input.js';
import {vibeDigest,vibeFilePreview} from './qianmu-vibe-file.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_stage',submissionState:'not_submitted'});};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Only a pre-commit asset stage. Never applies metadata, deletes an archive or authorizes a request.
// Recovery always needs the original file and a fresh explicit confirmation, never automatic replay.
export function createStoryboardPackageStage({store,journal,locks=globalThis.navigator?.locks}){
  async function verify(options){
    if(!account(options?.namespace)||typeof options.chatKey!=='string'||!options.chatKey||options.chatKey.length>4096||typeof options.guard!=='function'||typeof options.isCurrent!=='function')fail('缺少分镜导入账户、聊天或页面核对');
    if(options.isCurrent()!==true)fail('分镜导入页面已变化');await options.guard();if(options.isCurrent()!==true)fail('分镜导入页面已变化');
  }
  async function scope(options){
    await verify(options);return {namespace:options.namespace,chatHash:await vibeDigest(options.chatKey)};
  }
  async function inspect(file,options){
    const target=await scope(options),packet=await inspectStoryboardPackageFile(file);await verify(options);
    const inventory=await store.inventory(target.namespace),heads=new Map(inventory.heads.map(row=>[row.assetId,row])),rows=[];let neededBytes=0;
    for(const asset of packet.assets){
      await verify(options);const head=heads.get(asset.assetId),exists=Boolean(head);
      if(head){if(head.namespace!==target.namespace)fail('本机素材目录账户不符');const local=await store.load(target.namespace,asset.assetId);if(!local||local.assetId!==asset.assetId||local.serialized!==asset.serialized)fail('同编号本机原文件不完整，请先保全；不会覆盖');}
      const bytes=asset.bytes+(vibeFilePreview(asset.document)?.size||0);if(!exists)neededBytes+=bytes;
      rows.push({id:asset.assetId,name:asset.summary.name,bytes,exists});
    }
    if(!same(inventory,await store.inventory(target.namespace)))fail('核对期间本机素材目录已变化，请重新核对');await verify(options);
    const missing=rows.filter(row=>!row.exists).length,usage=inventory.usage;
    const plan={...target,sourceNamespace:packet.payload.vibeAccount,fileHash:packet.fingerprint,fileBytes:packet.fileBytes,localHash:await vibeDigest(JSON.stringify(inventory)),
      rows,missing,neededBytes,fits:inventory.heads.length+missing<=1024&&usage.bytes+usage.previewBytes+neededBytes<=usage.limit,legacyUrls:packet.census.legacyUrls.length};
    return {packet,plan};
  }
  return Object.freeze({
    async inspect(file,options){return (await inspect(file,{...options})).plan;},
    async stage(file,proof,confirmed,options){
      if(confirmed!==true||!hash(proof?.fileHash)||!hash(proof?.localHash)||!hash(proof?.chatHash)||!account(proof?.namespace))fail('请先核对并明确确认本次素材暂存');
      if(!locks?.request)fail('浏览器不支持跨页导入锁，尚未写入任何素材');
      const captured={...options},approved={fileHash:proof.fileHash,localHash:proof.localHash,namespace:proof.namespace,chatHash:proof.chatHash};
      const target=await scope(captured);
      if(approved.namespace!==target.namespace||approved.chatHash!==target.chatHash)fail('确认的目标账户或聊天不符');
      return locks.request(`qianmu:package-stage:${target.namespace}`,{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)fail('另一页面正在暂存分镜包，请稍后重新核对');
        const {packet,plan}=await inspect(file,captured);
        if(!same(approved,{fileHash:plan.fileHash,localHash:plan.localHash,namespace:plan.namespace,chatHash:plan.chatHash}))fail('原包、本机素材或聊天已变化，请重新核对后确认');
        if(!plan.fits)fail('素材空间或名额不足，未开始整包暂存；不会自动清理');
        const descriptor={namespace:plan.namespace,sourceNamespace:plan.sourceNamespace,chatHash:plan.chatHash,fileHash:plan.fileHash,fileBytes:plan.fileBytes,assetIds:plan.rows.map(row=>row.id)};
        await verify(captured);let checkpoint=await journal.prepare(descriptor,{isCurrent:captured.isCurrent});
        try{await verify(captured);
        checkpoint=await journal.checkpoint(checkpoint,'staging',{isCurrent:captured.isCurrent});
        for(const asset of packet.assets){
          await verify(captured);const existing=await store.load(target.namespace,asset.assetId);
          if(existing){if(existing.serialized!==asset.serialized)fail('暂存期间同编号原文件变化，请保全核对');continue;}
          await verify(captured);await store.putFile(target.namespace,asset.serialized,{isCurrent:captured.isCurrent});
        }
        // A crash may have committed the last asset but not its checkpoint. Re-read actual originals.
        for(const asset of packet.assets){await verify(captured);const current=await store.load(target.namespace,asset.assetId);if(!current||current.serialized!==asset.serialized)fail('部分素材暂存结果未确认，请使用原包重新核对');}
        await verify(captured);checkpoint=await journal.checkpoint(checkpoint,'assets_ready',{isCurrent:captured.isCurrent});await verify(captured);
        return {checkpoint,verified:packet.assets.length,settingsApplied:false};
        }catch(error){throw Object.assign(new Error(`素材暂存未完成确认，可能已有原文件写入；设置未应用。请使用原包重新核对：${error?.message||'结果未确认'}`),{code:'storyboard_package_stage_pending',recoveryKey:checkpoint.key,settingsApplied:false,submissionState:'not_submitted'});}
      });
    },
  });
}
