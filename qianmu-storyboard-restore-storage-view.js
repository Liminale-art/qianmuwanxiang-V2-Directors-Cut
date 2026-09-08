const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const names={configuration:'配置恢复副本',vibes:'Vibe 素材暂存记录',characters:'角色恢复记录',bundle:'联包恢复记录'};
const phases={prepared:'已准备',staging:'素材暂存中',assets_ready:'素材已核对',applied:'配置已应用，待刷新核对',uncertain:'配置保存未确认',originals:'原图阶段',workflows:'工作流阶段',pools:'候选阶段',metadata:'档案阶段',vibes:'Vibe 阶段',verified:'原件已核对'};
export function renderRestoreStorageReview({summary,busy,notice,selected,accepted,chatHash},formatBytes){
  return `<header><b>分镜恢复记录</b><button type="button" class="sd-icon-btn" data-restore-storage="close" title="关闭" aria-label="关闭"><i data-qm-icon="qm-regular-x"></i></button></header>
    <main><p>当前账户 · ${summary?`${summary.count} 条 · ${escape(formatBytes(summary.bytes))}`:'尚未完成盘点'}。计值为记录内容大小，不包含它们引用的图片、Vibe 原文件、工作流或角色库。</p>
    <p>结束记录不会回滚已应用配置，也不会删除素材。删除配置恢复副本后，无法再通过“核对导入”比较或恢复此前配置；未完成的恢复请优先核对原包。</p>
    <fieldset ${busy?'disabled':''}>${(summary?.items||[]).map((row,index)=>`<label class="sd-restore-storage-item"><input type="checkbox" data-restore-item="${index}" ${selected.has(index)?'checked':''}><span><b>${names[row.kind]}</b><small>${escape(phases[row.phase])} · ${escape(formatBytes(row.bytes))}</small><small>${row.chatHash?(row.chatHash===chatHash?'当前聊天':`其他聊天 · ${escape(row.chatHash.slice(0,10))}`):'账户级角色库'} · 原包 ${escape(row.fileHash.slice(0,10))}</small><small>${escape(new Date(row.updatedAt).toLocaleString())}</small></span></label>`).join('')}
    <label class="sd-bundle-review"><input type="checkbox" data-restore-loss ${accepted?'checked':''}>我确认结束所选记录，放弃其恢复核对能力；已有配置及原件保持原状。</label></fieldset></main>
    <footer><p role="status">${escape(notice||(busy?'正在后台核对…':'不自动清理，不续跑历史任务。'))}</p><div><button type="button" class="sd-btn" data-restore-storage="refresh" ${busy?'disabled':''}>刷新</button><button type="button" class="sd-btn" data-restore-storage="clear" ${busy||!selected.size||!accepted?'disabled':''}>结束所选记录</button></div></footer>`;
}

export function openRestoreStorageManager({parent,chatHash,run,icons=()=>{},formatBytes}){
  const dialog=document.createElement('dialog');dialog.className='sd-bundle-dialog sd-restore-storage-dialog';dialog.setAttribute('aria-label','分镜恢复记录');
  const controller=new AbortController(),view={summary:null,busy:false,notice:'',selected:new Set(),accepted:false,chatHash};
  let closed=false,resolve;const finished=new Promise(done=>resolve=done);
  const close=()=>{if(closed)return;closed=true;controller.abort();if(dialog.open)dialog.close();dialog.remove();resolve();};
  const draw=()=>{if(closed)return;if(!dialog.isConnected){close();return;}const scroll=dialog.querySelector('main')?.scrollTop||0;dialog.innerHTML=renderRestoreStorageReview(view,formatBytes);dialog.querySelector('main').scrollTop=scroll;icons(dialog);};
  async function work(action){
    if(closed||view.busy)return;if(action==='clear'&&(!view.accepted||!view.selected.size))return;
    const selected=[...view.selected].map(index=>{const {kind,key,fingerprint}=view.summary.items[index];return {kind,key,fingerprint};});
    view.busy=true;view.notice='';draw();
    try{
      if(action==='clear'){
        const result=await run('clear',{selected,confirmed:true,recoveryLossAccepted:true,signal:controller.signal});
        view.notice=`已结束 ${result.removed.length} 条记录，原图和配置未删除。${result.complete?'':` ${result.error}；其余请重新核对。`}`;
      }
      view.summary=await run('inspect',{signal:controller.signal});
    }catch(error){view.summary=null;view.notice=error?.message||'记录核对未完成，请刷新';}
    finally{view.selected.clear();view.accepted=false;view.busy=false;draw();}
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);
  dialog.addEventListener('click',event=>{const action=event.target.closest('[data-restore-storage]')?.dataset.restoreStorage;if(action==='close')close();else if(action==='refresh')void work('inspect');else if(action==='clear')void work('clear');});
  dialog.addEventListener('change',event=>{
    if(view.busy)return;const input=event.target;
    if(input.matches('[data-restore-item]')){const index=Number(input.dataset.restoreItem);if(!view.summary?.items[index])return;input.checked?view.selected.add(index):view.selected.delete(index);view.accepted=false;dialog.querySelector('[data-restore-loss]').checked=false;}
    else if(input.matches('[data-restore-loss]'))view.accepted=input.checked;
    dialog.querySelector('[data-restore-storage="clear"]').disabled=!view.selected.size||!view.accepted;
  });
  parent.append(dialog);draw();try{dialog.showModal();}catch(error){close();throw error;}void work('inspect');
  return {finished,close,get isOpen(){return !closed&&dialog.isConnected;}};
}
