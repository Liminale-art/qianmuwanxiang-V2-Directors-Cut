import {VIBE_ASSET_LIMITS} from './qianmu-vibe-asset-store.js';
const fail=message=>Object.assign(new Error(message),{code:'vibe_storage_review',submissionState:'not_submitted'});
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const unsettled=row=>['reserved','submitting','unknown'].includes(row.status);
const size=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const bytes=value=>value>=1048576?`${(value/1048576).toFixed(2)} MiB`:value>=1024?`${(value/1024).toFixed(1)} KiB`:`${value} B`;
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function select(snapshot,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>VIBE_ASSET_LIMITS.count||new Set(ids).size!==ids.length)throw fail('请选择不同的 Vibe 文件');
  return ids.map(id=>{const row=snapshot.items.find(row=>row.id===id);if(!row)throw fail('所选文件已变化，请刷新');return row;});
}

// Both snapshots contain metadata only. No image/encoding body scan and no remote request.
export function createVibeStorageOperations({store,encodings,locks=globalThis.navigator?.locks}){
  async function read(namespace){
    const local=await store.inventory(namespace),{receipts,archived,reviewHistory}=await encodings.inventory(namespace),fingerprint=await hash([namespace,local,receipts,archived,reviewHistory]);
    const byRef=new Map(),bySource=new Map(),add=(map,key,row)=>{if(key){if(!map.has(key))map.set(key,new Set());map.get(key).add(row);}};
    for(const row of receipts){add(byRef,row.assetRef?.id,row);add(byRef,row.sourceAssetRef?.id,row);add(bySource,row.identity.sourceId,row);}
    const items=local.heads.map(head=>{
      const related=[...new Set([...(byRef.get(head.assetId)||[]),...(bySource.get(head.summary.sourceId)||[])])];
      return {id:head.assetId,name:head.summary.name,type:head.summary.type,bytes:head.bytes,previewBytes:head.previewBytes||0,
        createdAt:head.createdAt,variants:head.summary.variants.length,receiptCount:related.length,pending:related.filter(unsettled).length};
    });
    return {local,view:{version:1,namespace,fingerprint,items,receiptCount:receipts.length+archived.count,archivedReceiptCount:archived.count,historyReviewCount:reviewHistory?.reviews||0,receiptBytes:receipts.reduce((sum,row)=>sum+size(row),0)+archived.bytes+(reviewHistory?.bytes||0),
      pendingCount:receipts.filter(unsettled).length,usage:{count:local.usage.count,bytes:local.usage.bytes,previewBytes:local.usage.previewBytes,limit:local.usage.limit,countLimit:VIBE_ASSET_LIMITS.count}}};
  }
  return {
    async inventory(namespace){return (await read(namespace)).view;},
    async summary(namespace){
      const view=(await read(namespace)).view,assets={bytes:view.usage.bytes,count:view.items.length,originalCount:view.items.filter(row=>row.type==='image').length,encodingCount:view.items.filter(row=>row.type==='encoding').length},
        previews={bytes:view.usage.previewBytes,count:view.items.filter(row=>row.previewBytes>0).length},records={bytes:view.receiptBytes,count:view.receiptCount,archivedCount:view.archivedReceiptCount,pendingCount:view.pendingCount,reviewCount:view.historyReviewCount};
      return {version:1,status:'ready',namespace,assets,previews,records,bytes:assets.bytes+previews.bytes+records.bytes};
    },
    async remove(namespace,ids,proof,confirmed){
      ids=Array.isArray(ids)?[...ids]:ids;
      if(confirmed!==true||typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof))throw fail('尚未明确确认本次清理');
      if(typeof locks?.request!=='function')throw fail('浏览器不支持跨页协调，暂不能清理 Vibe 文件');
      return locks.request('qianmu:nai-maintenance',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw fail('仍有 NAI 请求正在等待或生成，请结束后再清理');
        const snapshot=await read(namespace);if(snapshot.view.fingerprint!==proof)throw fail('文件或编码记录已变化，未删除，请刷新后重新选择');
        const selected=select(snapshot.view,ids);if(selected.some(row=>row.pending))throw fail('所选文件关联未决编码，请先在编码记录中核查');
        return store.remove(namespace,ids,{expectedHeads:snapshot.local.heads.filter(head=>ids.includes(head.assetId))});
      });
    },
  };
}

export function createVibeStorageActions({namespace,call,guard,items=()=>[]}){
  // Only current-library references are known here; other chats/history are explicitly not claimed to be unreferenced.
  const library=()=>items().filter(row=>row.assetRef?.namespace===namespace).map(row=>({id:row.id,assetId:row.assetRef.id}));
  return {
    async list(){await guard();const result=await call('storage-inventory',{namespace});await guard();return {...result,library:library()};},
    async inspectRestore(file){await guard();const result=await call('restore-inspect',{namespace,file});await guard();return result;},
    async restore(plan,file,confirm){
      if(plan?.namespace!==namespace||!plan.fits||!plan.missingCount)throw fail('原文件恢复尚未就绪');
      const proof={fingerprint:plan.fingerprint,localFingerprint:plan.localFingerprint};await guard();
      const yes=await confirm('恢复原文件备份',`只把 ${plan.missingCount} 份缺失素材写入当前 ST 账户，不覆盖同编号已有文件。\n不更改库条目、设置、历史引用和费用记录，不重新编码或生成。\n同一原文件可恢复旧编号；其他账户的引用不自动改绑。确认恢复？`);
      await guard();if(yes!==true)return null;const result=await call('restore-originals',{namespace,file,proof,confirmed:true});await guard();return result;
    },
    async aggregate(snapshot,id){
      await guard();if(snapshot?.namespace!==namespace||select(snapshot,[id])[0].type!=='image')throw fail('请选择一份含原图的文件');
      const result=await call('aggregate-prepare',{namespace,id});await guard();return result;
    },
    async exportAggregate(plan,confirm){
      if(plan?.namespace!==namespace||plan.report?.conflictCount!==0||!(plan.file instanceof Blob)||plan.file.size<1||plan.file.size>64*1024*1024)throw fail('汇总尚未就绪或存在冲突');
      const {id,fingerprint,file}=plan;await guard();const yes=await confirm('导出全档汇总','这会导出当前账户、本设备已保存的同原图档位；名称、预览和默认值沿用所选基准文件。\n汇总是一个新素材，不会修改原文件、替换旧引用、清理记录或重新编码。\n它不能代替原文件备份来恢复旧镜头引用；清理前仍须另行导出原文件。确认下载？');
      await guard();if(yes!==true)return null;const result=await call('aggregate-verify',{namespace,id,proof:fingerprint});await guard();if(result?.verified!==true)throw fail('同源文件快照未确认');return file;
    },
    async export(snapshot,ids){
      await guard();if(snapshot?.namespace!==namespace)throw fail('文件不属于当前账户');select(snapshot,ids);
      if(ids.length>16)throw fail('每次最多导出 16 份，请分批保存');
      const file=await call('export',{namespace,ids,bundle:ids.length!==1});await guard();return file;
    },
    async remove(snapshot,ids,confirm){
      ids=Array.isArray(ids)?[...ids]:ids;
      await guard();if(snapshot?.namespace!==namespace)throw fail('文件不属于当前账户');const selected=select(snapshot,ids);
      if(selected.some(row=>row.pending))throw fail('所选文件关联未决编码，请先核查');
      if(!equal(library(),snapshot.library))throw fail('Vibe 库引用已变化，请刷新后重新选择');
      const referenced=snapshot.library.filter(row=>ids.includes(row.assetId)).length;
      const yes=await confirm('清理 Vibe 文件',`将删除 ${ids.length} 份本机文件及缩略图，约 ${bytes(selected.reduce((sum,row)=>sum+row.bytes+row.previewBytes,0))}。\n当前库有 ${referenced} 处引用，其他聊天和历史镜头也可能引用。相关 Vibe 将暂不可用，需重新导入同一原文件；已生成图片不删除。\n编码记录与未知费用保留，不会自动重新编码或生图。\n此操作无法撤销；若尚未备份，请取消并先导出原文件。确认清理？`);
      await guard();if(yes!==true)return {cancelled:true};
      if(!equal(library(),snapshot.library))throw fail('确认期间 Vibe 库引用已变化，未删除');
      const result=await call('storage-remove',{namespace,ids,proof:snapshot.fingerprint,confirmed:true});await guard();return result;
    },
  };
}

export function createVibeStorageController({actions,confirm=async()=>false,onClose,icons=()=>{},isCurrent=()=>true,createPreservation=null}){
  let host,disposed=false,epoch=0,busy=false,snapshot=null,message='',visible=40,preservation=null,restoration=null,aggregate=null,aggregateVisible=40;const selected=new Set(),urls=new Map();
  const live=()=>!disposed&&isCurrent()&&host?.isConnected;
  const run=callback=>async event=>{event?.preventDefault();if(!live()||busy)return;const ticket=epoch,active=()=>live()&&ticket===epoch;busy=true;render();
    try{await callback(active);}catch(error){if(active())message=error?.message||'操作未确认，请刷新核对';}finally{if(active()){busy=false;render();}}};
  async function refresh(active){const next=await actions.list();if(!active())return;snapshot=next;selected.clear();visible=40;message='';}
  function download(blob,name=`qianmu-vibe-backup.${selected.size===1?'naiv4vibe':'naiv4vibeBundle'}`){const url=URL.createObjectURL(blob),link=host.ownerDocument.createElement('a');link.href=url;link.download=name;link.click();urls.set(url,setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},30000));}
  function renderAggregate(){
    const report=aggregate.report;
    host.innerHTML=`<section class="sd-vibe-review sd-vibe-aggregate"><header><h3>同原图档位汇总</h3><button class="sd-icon-btn sd-vibe-aggregate-close" type="button" aria-label="返回文件空间"><i class="fa-solid fa-xmark"></i></button></header>
      <p role="status">${escape(message||(busy?'正在核对…':report.conflictCount?'存在冲突，原文件全部保留':'汇总已就绪，原文件与引用未改变'))}</p>
      <p class="sd-vibe-review-file-info">基准：${escape(report.name)}<br>${report.fileCount} 份同原图文件 · ${report.variantCount} 个唯一档位 · ${report.duplicateCount} 个重复档位已去重<br>仅本设备当前账户已保存的原图文件，不含云端、已删除或来源不明的纯编码。名称、预览、日期和默认值沿用基准文件。</p>
      ${report.metadataDifferenceCount?`<p class="sd-vibe-review-file-info">${report.metadataDifferenceCount} 份文件的名称/预览/日期/默认值与基准不同；原文件仍保留。汇总文件不替换它们。</p>`:''}
      ${report.conflictCount?`<p class="sd-storage-pressure is-warning">${report.conflictCount} 项编码冲突，未生成汇总文件。请返回逐项备份，不会自动改名或覆盖档位。</p><div class="sd-vibe-review-rows">${report.conflicts.map(item=>`<article><b>${item.kind==='slot'?'同名档位内容不同':'同模型/信息档位含不同编码'}</b><span>${escape(item.model)} · ${escape(item.variant)}</span><small>信息提取 ${item.information===null?'未说明':escape(item.information)}</small><small>${escape(item.first)}<br>${escape(item.second)}</small></article>`).join('')}</div>${report.conflictCount>report.conflicts.length?'<p class="sd-vibe-review-file-info">仅显示前 64 项冲突；所有冲突均已阻止导出。</p>':''}`:`<div class="sd-vibe-review-rows">${report.variants.slice(0,aggregateVisible).map(item=>`<article><span>${escape(item.model)} · 信息提取 ${item.information===null?'未说明':escape(item.information)}${item.customParams?' · 含自定义参数':''}</span><small>${escape(item.variant)}</small></article>`).join('')}</div>${report.variants.length>aggregateVisible?'<button type="button" class="sd-btn sd-vibe-aggregate-more">加载更多档位</button>':''}`}
      <p class="sd-vibe-review-file-info">汇总为新素材，不是恢复旧引用的原文件备份；清理前请另行导出原文件。这里不重新编码、不收费。</p>
      <button class="sd-btn sd-vibe-aggregate-export" type="button" ${busy||report.conflictCount?'disabled':''}>导出全档 .naiv4vibe</button></section>`;
    host.querySelector('.sd-vibe-aggregate-close').onclick=()=>{epoch++;busy=false;aggregate=null;message='';render();};
    host.querySelector('.sd-vibe-aggregate-more')?.addEventListener('click',()=>{aggregateVisible+=40;renderAggregate();});
    host.querySelector('.sd-vibe-aggregate-export').onclick=run(async active=>{const file=await actions.exportAggregate(aggregate,async(...args)=>{if(!active())return false;const yes=await confirm(...args);return active()&&yes===true;});if(!active())return;
      if(!file){message='已取消，原文件保留';return;}download(file,'qianmu-vibe-all-variants.naiv4vibe');message='已发起汇总下载，请确认文件已保存；原文件、费用记录和旧引用未改变。';});icons(host);
  }
  function render(){
    if(!live())return;if(preservation){preservation.mount(host);return;}if(restoration){restoration.mount(host);return;}if(aggregate){renderAggregate();return;}
    const rows=snapshot?.items||[],total=rows.reduce((sum,row)=>sum+row.bytes+row.previewBytes,0)+(snapshot?.receiptBytes||0);
    const blocked=rows.some(row=>selected.has(row.id)&&row.pending);
    const parts=[['含原图文件',rows.filter(row=>row.type==='image').reduce((sum,row)=>sum+row.bytes,0),'#87a9c4'],['纯编码文件',rows.filter(row=>row.type==='encoding').reduce((sum,row)=>sum+row.bytes,0),'#b29bc9'],['缩略图',snapshot?.usage.previewBytes||0,'#d6b878'],['编码记录',snapshot?.receiptBytes||0,'#8bad99']];
    host.innerHTML=`<section class="sd-vibe-storage">
      <header><h3>Vibe 文件空间</h3><button type="button" class="sd-icon-btn sd-vibe-storage-refresh" aria-label="刷新空间" ${busy?'disabled':''}><i class="fa-solid fa-rotate"></i></button><button type="button" class="sd-icon-btn sd-vibe-storage-close" aria-label="返回 Vibe 库"><i class="fa-solid fa-xmark"></i></button></header>
      <p role="status">${escape(message||(busy?'正在读取…':'本设备 · 当前 ST 账户。不含 VPS 磁盘及其他功能数据。'))}</p>
      ${createPreservation?`<button type="button" class="sd-btn sd-vibe-preserve-open" ${busy?'disabled':''}>原始数据保全</button>`:''}
      ${typeof actions.inspectRestore==='function'?`<label class="sd-btn sd-vibe-restore-open">核对/恢复原文件备份<input type="file" accept=".naiv4vibe,.naiv4vibeBundle,.json" hidden ${busy?'disabled':''}></label>`:''}
      ${snapshot?`<div class="sd-vibe-storage-meter" role="img" aria-label="Vibe 占用组成">${parts.map(([label,n,color])=>`<span style="width:${total?n/total*100:0}%;background:${color}" title="${label} ${bytes(n)}"></span>`).join('')}</div>
      <div class="sd-vibe-storage-legend">${parts.map(([label,n,color])=>`<span><i style="background:${color}"></i>${label} ${bytes(n)}</span>`).join('')}</div>
      <p>文件 ${rows.length} / ${snapshot.usage.countLimit} · ${bytes(snapshot.usage.bytes+snapshot.usage.previewBytes)} / ${bytes(snapshot.usage.limit)}<br>记录 ${snapshot.receiptCount} 条，其中归档 ${snapshot.archivedReceiptCount||0} 条、未决 ${snapshot.pendingCount} 条；另存核查明细 ${snapshot.historyReviewCount||0} 次。计值为内容大小，非浏览器实际磁盘占用或剩余空间。</p>
      <div class="sd-vibe-storage-tools"><button type="button" class="sd-btn sd-vibe-storage-select" ${busy?'disabled':''}>${selected.size?'清空选择':'选择未锁定项'}</button><button type="button" class="sd-btn sd-vibe-storage-export" ${busy||!selected.size?'disabled':''}>导出所选</button><button type="button" class="sd-btn sd-danger sd-vibe-storage-remove" ${busy||!selected.size||blocked?'disabled':''}>清理 ${selected.size} 项</button></div>
      ${typeof actions.aggregate==='function'?`<button type="button" class="sd-btn sd-vibe-storage-aggregate" ${busy||selected.size!==1||rows.find(row=>selected.has(row.id))?.type!=='image'?'disabled':''}>汇总同原图档位</button>`:''}
      <small>不自动清理。其他聊天和历史镜头仍可能引用这些文件；删除后需重新导入同一原文件。未决关联文件可导出，清理前须先核查。</small>
      <div class="sd-vibe-storage-list">${rows.slice(0,visible).map(row=>`<label><input type="checkbox" data-vibe-storage-id="${row.id}" ${selected.has(row.id)?'checked':''} ${busy?'disabled':''}><span><b>${escape(row.name||'未命名 Vibe')}</b><small>${bytes(row.bytes+row.previewBytes)} · ${row.type==='image'?'含原图':'纯编码'} · ${row.variants} 个编码档位</small><small>当前库引用 ${snapshot.library.filter(item=>item.assetId===row.id).length} · 未归档关联 ${row.receiptCount}${row.pending?` · 未决 ${row.pending}`:''}</small></span></label>`).join('')}</div>
      ${rows.length>visible?'<button type="button" class="sd-btn sd-vibe-storage-more">加载更多</button>':''}`:''}</section>`;
    host.querySelector('.sd-vibe-storage-close').onclick=()=>{epoch++;onClose();};
    host.querySelector('.sd-vibe-storage-refresh').onclick=run(refresh);
    host.querySelector('.sd-vibe-restore-open input')?.addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;
      void run(async active=>{const module=await import('./qianmu-vibe-restore.js');if(!active())return;const plan=await actions.inspectRestore(file);if(!active())return;
        restoration=module.createVibeRestoreController({actions,plan,file,confirm,icons,isCurrent,onClose:()=>{epoch++;busy=false;restoration?.dispose();restoration=null;render();void run(refresh)();}});
      })();
    });
    host.querySelector('.sd-vibe-preserve-open')?.addEventListener('click',run(async active=>{
      const next=await createPreservation(()=>{epoch++;busy=false;preservation?.dispose();preservation=null;render();});if(!active()){next.dispose();return;}preservation=next;
    }));
    host.querySelector('.sd-vibe-storage-select')?.addEventListener('click',()=>{if(selected.size)selected.clear();else rows.filter(row=>!row.pending).forEach(row=>selected.add(row.id));render();});
    for(const box of host.querySelectorAll('[data-vibe-storage-id]'))box.onchange=()=>{box.checked?selected.add(box.dataset.vibeStorageId):selected.delete(box.dataset.vibeStorageId);render();};
    host.querySelector('.sd-vibe-storage-export')?.addEventListener('click',run(async active=>{const file=await actions.export(snapshot,[...selected]);if(active()){download(file);message='已发起原文件下载，请确认文件已保存后再清理。';}}));
    host.querySelector('.sd-vibe-storage-aggregate')?.addEventListener('click',run(async active=>{const result=await actions.aggregate(snapshot,[...selected][0]);if(active()){aggregate=result;aggregateVisible=40;message='';}}));
    host.querySelector('.sd-vibe-storage-remove')?.addEventListener('click',run(async active=>{
      const result=await actions.remove(snapshot,[...selected],async(...args)=>{if(!active())return false;const yes=await confirm(...args);return active()&&yes===true;});if(!active())return;
      if(result.cancelled){message='已取消，原文件保留';return;}
      snapshot=null;selected.clear();message=`已清理 ${result.removed} 份文件，约 ${bytes(result.bytes)}；仅可通过重新导入原备份恢复。`;
      const outcome=message;try{await refresh(active);if(active())message=outcome;}catch(error){if(active())message=`${outcome} 空间刷新失败：${error.message}`;}
    }));
    host.querySelector('.sd-vibe-storage-more')?.addEventListener('click',()=>{visible+=40;render();});icons(host);
  }
  return {mount(node){this.detach();host=node;render();if(!preservation&&!restoration&&!aggregate)void run(refresh)();},detach(){epoch++;preservation?.detach();restoration?.detach();host=null;busy=false;},dispose(){this.detach();disposed=true;preservation?.dispose();preservation=null;restoration?.dispose();restoration=null;aggregate=null;snapshot=null;selected.clear();for(const [url,timer] of urls){clearTimeout(timer);URL.revokeObjectURL(url);}urls.clear();}};
}
