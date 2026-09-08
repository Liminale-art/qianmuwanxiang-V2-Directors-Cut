const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderUserAliasReview({preview,busy,accepted,notice}){
  const total=preview?.total||0,offset=preview?.offset||0;
  return `<header><b>核对 USER 地址</b><button type="button" class="sd-icon-btn" data-alias-action="close" aria-label="关闭"><i data-qm-icon="qm-regular-x"></i></button></header><main>
    <p>只统一同一个头像文件的地址写法，不按同名合并不同人设。默认绑定与每个聊天的覆盖分别处理；旧关系完整保存为迁移凭据，可查看导出，暂不提供一键撤销。</p>
    <p>${preview?(total?`${total} 条原绑定 · ${preview.groups} 组 · 待选择 ${preview.unresolved} 组`:'未发现需要整理的等价头像地址'):'正在核对本机绑定…'}${preview?.missing?` · ${preview.missing} 个人设不在ST目录中，请先核对原头像文件`:''}</p>
    <fieldset ${busy?'disabled':''}>${(preview?.rows||[]).map((row,index)=>`<label class="sd-user-alias-item"><input type="radio" name="${row.groupId}" data-alias-choice="${index}" ${row.selected?'checked':''} ${row.present?'':'disabled'}><span><b>${escape(row.archiveName||row.archiveId||'不使用档案（显式解除）')}</b><small>${row.scope==='default'?'默认绑定':`聊天 · ${escape(row.chatKey)}`}</small><small>${escape(row.sourceKey)}</small><small>统一为 ${escape(row.targetKey)}</small><small>${row.conflict?'同组存在不同档案，请明确选择':row.selected?'此组绑定一致，确认后整理':'此组绑定一致，原关系仍留凭据'}${row.present?'':' · 人设未找到'}</small></span></label>`).join('')}
    ${total?`<label class="sd-bundle-review"><input type="checkbox" data-alias-accepted ${accepted?'checked':''}>我确认已核对全部${total}条关系。同组只采用所选档案，其他原关系保留在凭据中；不修改ST人设、档案内容和历史画面。</label>`:''}</fieldset>
    </main><footer><p role="status">${escape(notice||(busy?'正在后台核对…':'不会自动重试或删除历史凭据。'))}</p><div class="sd-user-alias-pages"><button type="button" class="sd-btn" data-alias-action="previous" ${busy||!offset?'disabled':''}>上一页</button><span>${total?`${offset+1}–${Math.min(offset+24,total)} / ${total}`:'0 项'}</span><button type="button" class="sd-btn" data-alias-action="next" ${busy||offset+24>=total?'disabled':''}>下一页</button><button type="button" class="sd-btn" data-alias-action="refresh" ${busy?'disabled':''}>重新核对</button><button type="button" class="sd-btn" data-alias-action="apply" ${busy||!accepted||!preview?.ready?'disabled':''}>确认整理</button></div></footer>`;
}
export function openUserAliasReview({parent,run,icons=()=>{}}){
  const dialog=document.createElement('dialog');dialog.className='sd-bundle-dialog sd-user-alias-dialog';dialog.setAttribute('aria-label','核对USER地址');
  const abort=new AbortController(),state={preview:null,choices:{},busy:false,accepted:false,notice:''};let closed=false,resolve;const finished=new Promise(done=>resolve=done);
  const close=()=>{if(closed)return;closed=true;abort.abort();if(dialog.open)dialog.close();dialog.remove();resolve();};
  const draw=(scroll=0)=>{if(closed)return;if(!dialog.isConnected){close();return;}dialog.innerHTML=renderUserAliasReview(state);icons(dialog);dialog.querySelector('main').scrollTop=scroll;};
  async function work(action,offset=0){
    if(closed||state.busy||action==='apply'&&(!state.preview?.ready||!state.accepted))return;
    const scroll=action==='preview'&&offset===state.preview?.offset?dialog.querySelector('main').scrollTop:0;
    const approved=state.preview;state.busy=true;state.accepted=false;state.notice='';draw(scroll);
    try{
      if(action==='apply'){
        const result=await run('user-alias-apply',{input:{choices:state.choices,digest:approved.digest,confirmed:true},signal:abort.signal});
        state.choices={};state.notice=`已核对整理 ${result.before} 条原绑定，保留 ${result.after} 条有效绑定。原关系可在储存空间→迁移映射凭据中查看与导出。`;
      }
      state.preview=await run('user-alias-preview',{input:{choices:state.choices,offset},signal:abort.signal});
    }catch(error){state.preview=null;state.choices={};state.notice=error?.message||'整理结果未确认，请重新核对';}
    finally{state.busy=false;draw(scroll);}
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);
  dialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-alias-action]')?.dataset.aliasAction;
    if(action==='close')close();else if(action==='refresh')void work('preview');else if(action==='apply')void work('apply');
    else if(['previous','next'].includes(action)&&state.preview){const offset=state.preview.offset+(action==='next'?24:-24);if(offset>=0&&offset<state.preview.total)void work('preview',offset);}
  });
  dialog.addEventListener('change',event=>{
    if(state.busy)return;
    if(event.target.matches('[data-alias-accepted]')){state.accepted=event.target.checked;dialog.querySelector('[data-alias-action="apply"]').disabled=!state.accepted||!state.preview?.ready;}
    else if(event.target.matches('[data-alias-choice]')){const row=state.preview?.rows[Number(event.target.dataset.aliasChoice)];if(row){state.choices[row.groupId]=row.candidateId;void work('preview',state.preview.offset);}}
  });
  parent.append(dialog);draw();try{dialog.showModal();}catch(error){close();throw error;}void work('preview');return {close,finished,get isOpen(){return !closed&&dialog.isConnected;}};
}
