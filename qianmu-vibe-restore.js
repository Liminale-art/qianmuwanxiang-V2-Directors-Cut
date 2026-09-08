import {parseNovelVibeFile,vibeDigest,vibeFilePreview,vibeFileError,VIBE_FILE_LIMITS} from './qianmu-vibe-file.js';
const fail=message=>{throw vibeFileError('restore',message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const bytes=value=>value>=1048576?`${(value/1048576).toFixed(2)} MiB`:value>=1024?`${(value/1024).toFixed(1)} KiB`:`${value} B`;
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

// Restore original immutable assets only. Never import settings, requests or fee authorizations.
export function createVibeRestoreOperations({store}){
  async function inspect(namespace,file){
    if(!account(namespace))fail('无法确认当前账户');
    if(!(file instanceof Blob)||file.size<1||file.size>VIBE_FILE_LIMITS.file)fail('请选择 64 MiB 以内的原始 .naiv4vibe 或 Bundle 文件');
    const text=await file.text(),parsed=await parseNovelVibeFile(text),assets=[...new Map(parsed.map(asset=>[asset.assetId,asset])).values()];
    const inventory=await store.inventory(namespace),fingerprint=await vibeDigest(text),localFingerprint=await vibeDigest(JSON.stringify(inventory)),rows=[];
    let neededBytes=0;
    for(const asset of assets){
      const head=inventory.heads.find(row=>row.assetId===asset.assetId),exists=Boolean(head);
      if(head){if(head.namespace!==namespace)fail('文件目录的账户不符');const current=await store.load(namespace,asset.assetId);
        if(!current||current.assetId!==asset.assetId||current.serialized!==asset.serialized)fail('同编号原资产不完整，请先原始保全；未覆盖');}
      const previewBytes=vibeFilePreview(asset.document)?.size||0;
      if(!exists)neededBytes+=asset.bytes+previewBytes;
      rows.push({id:asset.assetId,name:asset.summary.name,type:asset.summary.type,variants:asset.summary.variants.length,bytes:asset.bytes,previewBytes,exists});
    }
    if(!same(inventory,await store.inventory(namespace)))fail('核对期间本机文件已变化，请重新核对');
    const missingCount=rows.filter(row=>!row.exists).length,usage=inventory.usage;
    const fits=inventory.heads.length+missingCount<=1024&&usage.bytes+usage.previewBytes+neededBytes<=usage.limit;
    return {text,plan:{namespace,fingerprint,localFingerprint,rows,duplicateCount:parsed.length-assets.length,missingCount,existingCount:rows.length-missingCount,neededBytes,fits,
      availableBytes:Math.max(0,usage.limit-usage.bytes-usage.previewBytes),availableCount:Math.max(0,1024-inventory.heads.length)}};
  }
  return Object.freeze({
    async inspect(namespace,file){return (await inspect(namespace,file)).plan;},
    async restore(namespace,file,proof,confirmed){
      if(confirmed!==true||!hash(proof?.fingerprint)||!hash(proof?.localFingerprint))fail('尚未明确确认本次原文件恢复');
      const expected={fingerprint:proof.fingerprint,localFingerprint:proof.localFingerprint},current=await inspect(namespace,file),plan=current.plan;
      if(!same(expected,{fingerprint:plan.fingerprint,localFingerprint:plan.localFingerprint}))fail('原文件或本机空间已变化，请重新核对');
      if(!plan.fits)fail('本机空间或文件名额不足，未恢复任何文件；请先备份整理');
      if(!plan.missingCount)return {restored:0,existing:plan.existingCount,ids:plan.rows.map(row=>row.id)};
      // Existing putFile validates the entire bundle and commits documents/heads/previews/usage atomically.
      // A late concurrent import can turn an addition into an identical no-op; nothing is overwritten.
      const saved=await store.putFile(namespace,current.text);
      const ids=[...new Set(saved.map(row=>row.assetId))];if(ids.length!==plan.rows.length||plan.rows.some(row=>!ids.includes(row.id)))fail('恢复结果未确认，请重新核对原文件');
      return {restored:plan.missingCount,existing:plan.existingCount,ids};
    },
  });
}

export function createVibeRestoreController({actions,plan,file,confirm=async()=>false,onClose,icons=()=>{},isCurrent=()=>true}){
  let host,disposed=false,busy=false,epoch=0,message='',complete=false;
  const live=()=>!disposed&&isCurrent()&&host?.isConnected;
  const run=callback=>async()=>{if(!live()||busy)return;const ticket=epoch,active=()=>live()&&ticket===epoch;busy=true;render();
    try{await callback(active);}catch(error){if(active())message=error?.message||'恢复结果未确认，请重新核对';}finally{if(active()){busy=false;render();}}};
  function render(){
    if(!live())return;
    host.innerHTML=`<section class="sd-vibe-review sd-vibe-restore"><header><h3>核对原文件备份</h3><button type="button" class="sd-icon-btn sd-vibe-restore-close" aria-label="返回文件空间"><i class="fa-solid fa-xmark"></i></button></header>
      <p role="status">${escape(message||(busy?'正在核对…':plan.fits?'文件有效，尚未写入本机':'空间或名额不足，未写入本机'))}</p>
      <p class="sd-vibe-review-file-info">当前账户 · ${plan.rows.length} 份原文件<br>本机已有 ${plan.existingCount} 份，缺少 ${plan.missingCount} 份；预计增加 ${bytes(plan.neededBytes)}。${plan.duplicateCount?`文件内 ${plan.duplicateCount} 份完全重复项只计一次。`:''}</p>
      ${!plan.fits?`<p class="sd-storage-pressure is-warning">可用名额 ${plan.availableCount} 份、内容预算 ${bytes(plan.availableBytes)}。请先返回备份整理，不会自动清理或部分恢复。</p>`:''}
      <div class="sd-vibe-review-rows">${plan.rows.map(row=>`<article><b>${escape(row.name)}</b><span>${row.exists?'本机已有 · 不覆盖':'本机缺少 · 待恢复'} · ${row.type==='image'?'含原图':'纯编码'} · ${row.variants} 个档位</span><small>${escape(row.id)}</small><small>${bytes(row.bytes+row.previewBytes)}</small></article>`).join('')}</div>
      <p class="sd-vibe-review-file-info">只恢复本设备当前账户的原文件；不新增库条目、不改选择/设置、不恢复费用请求或启动生成。仅同一原文件能还原旧编号，汇总文件不能替代旧备份；不同账户的历史引用不会自动改绑。</p>
      <footer class="sd-vibe-storage-tools"><button type="button" class="sd-btn sd-vibe-restore-refresh" ${busy?'disabled':''}>重新核对</button><button type="button" class="sd-btn sd-vibe-restore-confirm" ${busy||complete||!plan.fits||!plan.missingCount?'disabled':''}>恢复缺少的原文件</button></footer></section>`;
    host.querySelector('.sd-vibe-restore-close').onclick=()=>{epoch++;onClose();};
    host.querySelector('.sd-vibe-restore-refresh').onclick=run(async active=>{const next=await actions.inspectRestore(file);if(active()){plan=next;message='';complete=false;}});
    host.querySelector('.sd-vibe-restore-confirm').onclick=run(async active=>{
      const result=await actions.restore(plan,file,async(...args)=>{if(!active())return false;const yes=await confirm(...args);return active()&&yes===true;});if(!active())return;
      if(!result){message='已取消，未写入原文件';return;}complete=true;message=`原文件恢复完成：核对的 ${result.restored} 份缺失项已存入或已有相同内容。库条目、设置和费用记录未修改。`;
    });icons(host);
  }
  return {mount(node){this.detach();host=node;render();},detach(){epoch++;host=null;busy=false;},dispose(){this.detach();disposed=true;file=null;plan=null;}};
}
