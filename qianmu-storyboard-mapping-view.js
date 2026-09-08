const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const name=kind=>kind==='environment'?'环境映射':'角色 / USER 映射';
const stamp=value=>escape(new Date(value).toLocaleString());
const button=(action,label,disabled=false)=>`<button type="button" class="sd-btn" data-mapping-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
const pair=(label,value)=>`<div><small>${label}</small><span>${escape(value)}</span></div>`;
function metadata(head,formatBytes){
  return `<section class="sd-mapping-meta">${head.scope?pair('类型',head.scope==='local-user-alias-resolution'?'本机USER等价地址整理':'原包USER来源整理与目标映射'):''}${pair('首次确认',new Date(head.createdAt).toLocaleString())}${pair(head.scope==='local-user-alias-resolution'?'原绑定快照指纹':'原包指纹',head.sourceDigest)}${pair('聊天指纹',head.chatHash)}${pair('凭据指纹',head.digest)}${pair('记录内容',formatBytes(head.bytes))}</section>`;
}
function bindingDetail(row,scope){
  return `<section class="sd-mapping-item"><b>${row.source.category.toUpperCase()} · ${row.source.scope==='default'?'默认绑定':'指定聊天'}</b>${pair('调整前',row.source.subjectKey)}${row.canonical?pair('来源统一地址',row.canonical.subjectKey):''}${pair('调整后',row.target.subjectKey)}${pair('原角色档案',row.source.archiveId||'不使用档案（显式解除）')}${scope?pair('采用的档案',row.target.archiveId||'不使用档案（显式解除）'):''}${row.source.scope==='chat'?pair('原绑定聊天',row.source.chatKey):''}${pair('原版本',row.source.revision)}${row.canonical?pair('来源派生版本',row.canonical.revision):''}${pair('派生版本',row.target.revision)}${scope==='local-user-alias-resolution'?'':pair('原资料摘要',row.sourceHash||'未取得原资料')+pair('目标资料摘要',row.targetHash||'未取得目标资料')}</section>`;
}
export function renderMappingRegistry({list,detail,busy,notice,query,kind},formatBytes){
  const current=detail||list,offset=current?.offset||0,total=current?.total||0;
  const items=detail?detail.rows.map(row=>detail.head.kind==='environment'?`<section class="sd-mapping-item">${pair('来源安装',row.sourceInstance)}${pair('来源账户标记',row.sourceAccount)}${pair('目标安装',row.targetInstance)}${pair('目标账户标记',row.targetAccount)}</section>`
    :bindingDetail(row,detail.head.scope)).join('')
    :(list?.rows||[]).map((head,index)=>`<button type="button" class="sd-btn sd-mapping-item" data-mapping-open="${index}" ${busy?'disabled':''}><b>${head.scope==='bundle-user-alias-resolution'?'原包USER整理与映射':head.scope==='local-user-alias-resolution'?'USER地址整理':name(head.kind)}</b><small>${stamp(head.createdAt)} · ${escape(formatBytes(head.bytes))}</small><small>${head.scope==='local-user-alias-resolution'?'原绑定':'原包'} ${head.sourceDigest.slice(0,12)} · ${head.mappings} 项${head.bindings?` / ${head.bindings} 条绑定`:''}</small><small>聊天 ${head.chatHash.slice(0,12)}</small></button>`).join('');
  return `<header><b>迁移映射凭据</b><button type="button" class="sd-icon-btn" data-mapping-action="close" title="关闭" aria-label="关闭"><i data-qm-icon="qm-regular-x"></i></button></header>
    <main><p>仅记录已确认的来源与目标关系，不代表恢复已经完成，也不会自动重绑或续跑旧任务。</p>
    ${detail?`${button('back','返回目录',busy)}${metadata(detail.head,formatBytes)}`:`<fieldset class="sd-mapping-search" ${busy?'disabled':''}><select data-mapping-kind aria-label="凭据类型">${['all','environment','subjects'].map(value=>`<option value="${value}" ${kind===value?'selected':''}>${value==='all'?'全部凭据':name(value)}</option>`).join('')}</select><input type="search" data-mapping-query maxlength="160" aria-label="按原包、聊天或凭据指纹检索" placeholder="原包 / 聊天 / 凭据指纹" value="${escape(query)}">${button('search','查找',busy)}</fieldset><p>${list?`${list.storage.count} 份 · ${escape(formatBytes(list.storage.bytes))}（记录内容及目录索引，不含素材与数据库内部开销）`:'正在读取目录…'}</p>`}
    <div class="sd-mapping-items">${items}</div>
    </main><footer><p role="status">${escape(notice||(busy?'正在后台核验…':detail?'导出完整原凭据，不含角色正文、原图或连接密钥。导出文件用于保全核对，当前不提供凭据文件单独导入。':'可按指纹检索；打开详情时重新核验原记录。'))}</p>
    <div class="sd-mapping-pages">${button('previous','上一页',busy||!offset)}<span>${total?`${offset+1}–${Math.min(offset+24,total)} / ${total}`:'0 项'}</span>${button('next','下一页',busy||offset+24>=total)}${detail?button('export','导出凭据',busy):button('refresh','刷新',busy)}</div></footer>`;
}

export function openMappingRegistry({parent,run,icons=()=>{},formatBytes}){
  const dialog=document.createElement('dialog');dialog.className='sd-bundle-dialog sd-mapping-dialog';dialog.setAttribute('aria-label','迁移映射凭据');
  const controller=new AbortController(),state={list:null,detail:null,busy:false,notice:'',query:'',kind:'all'};
  let closed=false,resolve,listScroll=0,downloadUrl=null,downloadTimer;
  const finished=new Promise(done=>resolve=done);
  const releaseDownload=()=>{clearTimeout(downloadTimer);if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=null;};
  const close=()=>{if(closed)return;closed=true;controller.abort();releaseDownload();if(dialog.open)dialog.close();dialog.remove();resolve();};
  const draw=(scroll=dialog.querySelector('main')?.scrollTop||0)=>{if(closed)return;if(!dialog.isConnected){close();return;}dialog.innerHTML=renderMappingRegistry(state,formatBytes);icons(dialog);dialog.querySelector('main').scrollTop=scroll;};
  const remember=()=>{const input=dialog.querySelector('[data-mapping-query]');if(input){state.query=input.value;state.kind=dialog.querySelector('[data-mapping-kind]').value;}};
  async function work(action,input,scroll=0){
    if(closed||state.busy)return;remember();state.busy=true;state.notice='';draw();
    try{
      const result=await run(action,{input,signal:controller.signal});if(closed||!dialog.isConnected)return;
      if(action==='mapping-export'){
        releaseDownload();downloadUrl=URL.createObjectURL(result.file);const anchor=document.createElement('a');anchor.href=downloadUrl;anchor.download=result.filename;dialog.append(anchor);anchor.click();anchor.remove();downloadTimer=setTimeout(releaseDownload,10000);state.notice='已交给浏览器下载，请确认文件已保存。原凭据和绑定未改动。';
      }else if(action==='mapping-detail')state.detail=result;
      else{state.list=result;state.detail=null;state.query=result.query;state.kind=result.kind;}
    }catch(error){state.notice=error?.message||'迁移凭据核对失败，请保留原记录';}
    finally{state.busy=false;draw(scroll);}
  }
  const list=(offset=0)=>{remember();void work('mapping-list',{kind:state.kind,query:state.query,offset});};
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);
  dialog.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.target.matches('[data-mapping-query]')){event.preventDefault();list();}});
  dialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-mapping-action]')?.dataset.mappingAction;
    if(action==='close'){close();return;}if(state.busy)return;
    const open=event.target.closest('[data-mapping-open]');
    if(open){const head=state.list?.rows[Number(open.dataset.mappingOpen)];if(head){listScroll=dialog.querySelector('main').scrollTop;void work('mapping-detail',{kind:head.kind,digest:head.digest,offset:0});}return;}
    if(action==='back'){state.detail=null;state.notice='';draw(listScroll);return;}
    if(['search','refresh'].includes(action)){list();return;}
    if(action==='export'&&state.detail){const head=state.detail.head;void work('mapping-export',{kind:head.kind,digest:head.digest},dialog.querySelector('main').scrollTop);return;}
    if(['previous','next'].includes(action)){
      const current=state.detail||state.list;if(!current)return;const offset=current.offset+(action==='next'?24:-24);if(offset<0||offset>=current.total)return;
      if(state.detail)void work('mapping-detail',{kind:state.detail.head.kind,digest:state.detail.head.digest,offset});else void work('mapping-list',{kind:state.list.kind,query:state.list.query,offset});
    }
  });
  parent.append(dialog);draw();try{dialog.showModal();}catch(error){close();throw error;}list();
  return {finished,close,get isOpen(){return !closed&&dialog.isConnected;}};
}
