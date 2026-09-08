import {CHARACTER_CATEGORIES,newCharacterArchive,normalizeCharacterArchive,selectCharacterBinding,exportCharacterArchive,importCharacterArchive} from './qianmu-character-archive.js';
import {createCharacterArchiveStore} from './qianmu-character-archive-store.js';
import {comfyCharacterEditorRecipe,newComfyCharacterImplementation,renderComfyCharacterEditor,captureComfyCharacterEditor,saveComfyCharacterEditor} from './qianmu-comfy-character-view.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const clone=value=>JSON.parse(JSON.stringify(value));
const icon=(action,label,glyph,attrs='')=>`<button type="button" class="sd-icon-btn" data-archive-action="${action}" title="${escape(label)}" aria-label="${escape(label)}" ${attrs}><i data-qm-icon="qm-regular-${({upload:'upload-simple',download:'download-simple'})[glyph]||glyph}"></i></button>`;
const safeImage=value=>{
  if(typeof value!=='string'||!/^\/(?:user\/images\/|characters\/|User(?:%20| )Avatars\/)/.test(value)||/[\u0000-\u001f\\?#]/.test(value))return '';
  try{for(const part of value.split('/').slice(1)){const decoded=decodeURIComponent(part);if(!decoded||decoded==='.'||decoded==='..'||/[\\/%\u0000-\u001f\u007f]/.test(decoded))return '';}}catch(_){return '';}
  return value;
};
const status=view=>`<p class="sd-character-status" role="status">${escape(view.error||'参考图须在支持的镜头台启用；性征暂不参与生成')}</p>`;
const field=(name,label,value,max,textarea=false)=>`<label><span>${label}</span>${textarea?`<textarea class="text_pole" data-archive-field="${name}" maxlength="${max}">${escape(value)}</textarea>`:`<input class="text_pole" data-archive-field="${name}" maxlength="${max}" value="${escape(value)}">`}</label>`;

export async function saveCharacterReference(file,{save,guard,createBitmap=globalThis.createImageBitmap,createCanvas=()=>document.createElement('canvas')}={}) {
  if(typeof createBitmap!=='function')throw Error('当前浏览器不能生成档案封面，请更换浏览器后上传');
  const {saveStaticReferenceFile}=await import('./qianmu-comfy-references.js');await guard();
  const reference=await saveStaticReferenceFile(file,{save,guard});
  const bitmap=await createBitmap(file);let previewFile;
  try{
    await guard();if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>32000000)throw Error('参考图像素过大，请缩小至 3200 万像素以内');
    const canvas=createCanvas(),scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height));
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('封面处理超时，请重试')),10000);canvas.toBlob(value=>{clearTimeout(timer);value?resolve(value):reject(Error('封面处理失败'));},'image/webp',0.8);});
    if(blob.size>256*1024)throw Error('档案封面过大，请换图后重试');previewFile=new File([blob],'preview.webp',{type:blob.type});
  }finally{bitmap.close();}
  await guard();const preview=await saveStaticReferenceFile(previewFile,{save,guard});return {reference,preview:{...preview,sourceSha256:reference.sha256}};
}

export function renderCharacterArchive(view,{identity=()=>''}={}) {
  const disabled=view.busy?'disabled':'';
  if(view.restoring){
    const r=view.restoring,p=r.preview,phase={prepared:'已确认',originals:'原图核对',workflows:'工作流核对',metadata:'档案提交核对',verified:'已完成核对'}[r.record?.phase]||'';
    const conflicts=p?.conflicts||[],bindings=p?.bindingReview||[],page=r.page||0,offset=page*24,limit=offset+24;
    return `<div class="sd-character-library sd-character-restore" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
      <div class="sd-character-tools">${icon('restore-cancel','返回角色库','x')}<b>恢复角色库</b><span class="sd-character-spacer"></span>${icon('restore-file','选择角色资源备份','folder')}</div>
      <section class="sd-card"><div class="sd-storyboard-card-body">
        <p>同一 ST 账户恢复档案、原图与固定工作流。旧环境与原备份请先保留，不含 API 授权或模型文件。</p>
        ${r.record?`<div class="sd-character-tools"><span>${escape(phase)} · ${escape(new Date(r.record.updatedAt).toLocaleString())}</span>${icon('restore-dismiss','结束此恢复核对记录','trash')}</div><p>阶段表示最近一次开始核对的位置，不代表全部保存成功；续接时仍逐件核对。</p>`:''}
        ${r.fileName?`<p class="sd-character-identifier">${escape(r.fileName)}</p>`:''}
        ${p?`<p>档案与绑定：新增 ${p.summary.added} · 替换 ${p.summary.replaced} · 保留 ${p.summary.kept}</p>${p.needsRecheck?'<p>选择仅更新预览；选定后核对本机库与原件，再确认恢复。</p>':`<p>原图 ${p.images.length} 个路径 · 缺件 ${p.images.filter(row=>row.state==='missing').length}${p.workflowSummary?` · 工作流新增版本 ${p.workflowSummary.addedVersions}`:''}</p>`}`:''}
      </div></section>
      ${conflicts.length?`<section class="sd-card"><summary><b>逐项确认冲突 · ${conflicts.length}</b></summary><div class="sd-storyboard-card-body sd-character-restore-items">${conflicts.slice(offset,limit).map((row,index)=>`<label>
        <span>${escape(row.kind==='archive'?`${row.localName} v${row.localVersion} → ${row.incomingName} v${row.incomingVersion}`:`${row.category.toUpperCase()} · ${row.subjectKey} · ${row.chatKey||'默认绑定'}`)}</span>
        ${row.kind==='binding'?`<small>${escape(row.localArchiveId||'不绑定')} → ${escape(row.incomingArchiveId||'不绑定')}</small>`:''}
        <select class="text_pole" data-archive-restore-decision="${offset+index}"><option value="" ${!row.choice?'selected':''}>请选择</option><option value="local" ${row.choice==='local'?'selected':''}>保留本机</option><option value="incoming" ${row.choice==='incoming'?'selected':''}>使用备份</option></select></label>`).join('')}</div></section>`:''}
      ${bindings.length?`<section class="sd-card"><summary><b>原身份与聊天绑定 · ${bindings.length}</b></summary><div class="sd-storyboard-card-body sd-character-restore-items">${bindings.slice(offset,limit).map(row=>`<p><b>${escape(row.category.toUpperCase())}</b> · ${escape(row.subjectKey)}<br>${escape(row.scope==='chat'?row.chatKey:'角色默认')} → ${escape(row.archiveId||'明确不绑定')}</p>`).join('')}</div>
        <label class="sd-character-restore-review"><input type="checkbox" data-archive-restore-reviewed ${r.bindingsReviewed?'checked':''}><span>我确认此备份来自当前 ST 原环境，已核对全部 ${bindings.length} 处原身份及聊天标识。这里只恢复原标识，不自动验证所有角色文件／历史聊天；同名不代表同一身份，不确定时取消。</span></label></section>`:''}
      ${p?.images.some(row=>row.state==='conflict')?'<p role="alert">原图位置已有不同内容，不能覆盖；请保留双方原件核对。</p>':''}
      ${page||Math.max(conflicts.length,bindings.length)>24?`<div class="sd-character-tools"><button type="button" class="sd-btn" data-archive-action="restore-previous" ${page?'':'disabled'}>上一页</button><span>${page+1} / ${Math.ceil(Math.max(conflicts.length,bindings.length)/24)}</span><button type="button" class="sd-btn" data-archive-action="restore-more" ${Math.max(conflicts.length,bindings.length)>limit?'':'disabled'}>下一页</button></div>`:''}
      <div class="sd-character-tools"><button type="button" class="sd-btn" data-archive-action="restore-preview" ${r.session?'':'disabled'}>${p?.needsRecheck?'核对选择与原件':'重新核对'}</button><button type="button" class="sd-btn" data-archive-action="restore-commit" ${p?.ready&&(!bindings.length||r.bindingsReviewed)?'':'disabled'}>确认恢复</button></div>${status(view)}
    </fieldset><input type="file" data-archive-backup-file accept=".json,application/json" hidden></div>`;
  }
  if(view.comfyEditor)return `<div class="sd-character-library sd-character-editor" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>${renderComfyCharacterEditor(view.comfyEditor,icon)}${status(view)}</fieldset></div>`;
  if(view.draft){
    const draft=view.draft,doc=draft.document,cover=safeImage(doc.imagegen.reference?.url),bindings=view.bindings.filter(row=>row.archiveId===draft.id);
    return `<div class="sd-character-library sd-character-editor" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
      <div class="sd-character-tools">${icon('cancel','取消编辑','x')}<b>${doc.category.toUpperCase()}${draft.version?` · v${draft.version}`:''}</b><span class="sd-character-spacer"></span>${icon('copy','复制档案','copy')}${icon('export','导出档案','download')}${draft.id?icon('delete','删除档案','trash'):''}${icon('save','保存档案','floppy-disk')}</div>
      <section class="sd-card"><div class="sd-storyboard-card-body sd-character-detail-grid">
        <div class="sd-character-cover-field"><label class="sd-character-cover-upload" aria-label="上传参考图">${cover?`<img src="${escape(cover)}" alt="参考图">`:'<i data-qm-icon="qm-regular-image"></i>'}<input type="file" data-archive-image accept="image/png,image/jpeg,image/webp" class="sd-reader-native-file"></label>${cover?icon('clear-image','移除参考图选择','x'):''}</div>
        <div class="sd-character-main-fields">${field('name','档案名',doc.name,80)}${field('appearance','角色形象',doc.imagegen.appearance,12000,true)}${field('sensitiveAppearance','性征',doc.imagegen.sensitiveAppearance,6000,true)}</div>
        <div class="sd-character-full">${field('negative','模型接口专属负面',doc.imagegen.negative,6000,true)}</div>
      </div></section>
      <details class="sd-card"><summary><b>NAI 参考设置</b></summary><div class="sd-storyboard-card-body"><div class="sd-character-reference-settings">
        <label><span>强度</span><input class="text_pole" type="number" min="0" max="1" step="0.05" data-archive-field="referenceStrength" value="${escape(doc.imagegen.novelReference?.strength ?? 0.6)}"></label>
        <label><span>保真度</span><input class="text_pole" type="number" min="0" max="1" step="0.05" data-archive-field="referenceFidelity" value="${escape(doc.imagegen.novelReference?.fidelity ?? 1)}"></label>
      </div></div></details>
      <details class="sd-card"><summary><b>Comfy 实现</b></summary><div class="sd-storyboard-card-body">
        ${(doc.comfy?.implementations||[]).map((impl,index)=>`<div class="sd-comfy-role-heading"><button type="button" class="sd-btn" data-archive-action="comfy-edit" data-item-index="${index}">${escape(impl.name)} · v${impl.workflow.version}</button>${icon('comfy-remove','移除此实现','x',`data-item-index="${index}"`)}</div>`).join('')}
        <button type="button" class="sd-btn" data-archive-action="comfy-new" ${(doc.comfy?.implementations?.length||0)>=8?'disabled':''}>绑定当前 Comfy 方案</button>
      </div></details>
      <details class="sd-card"><summary><b>绑定与识别</b></summary><div class="sd-storyboard-card-body">
        ${field('aliases','别名 / 称呼',doc.aliases.join('，'),1943)}
        <label><span>年龄状态</span><select class="text_pole" data-archive-field="ageStatus">${[['unknown','未确认'],['adult','已确认成年'],['minor','未成年']].map(([id,label])=>`<option value="${id}" ${doc.ageStatus===id?'selected':''}>${label}</option>`).join('')}</select></label>
        ${draft.id?`<p class="sd-character-identifier">${escape(`archive:${draft.id}`)}</p>`:''}
        ${bindings.slice(0,view.bindingShown||24).map((row,index)=>`<div class="sd-character-binding-row"><span>${escape(row.category.toUpperCase())} · ${escape(row.scope==='chat'?'当前聊天级':'角色默认')}<small>${escape(row.subjectKey)}${row.chatKey?` · ${escape(row.chatKey)}`:''}</small></span>${icon('unbind','解除此绑定','x',`data-binding-index="${index}"`)}</div>`).join('')}
        ${bindings.length>(view.bindingShown||24)?'<button type="button" class="sd-btn" data-archive-action="more-bindings">更多绑定</button>':''}
      </div></details>
      ${status(view)}
    </fieldset></div>`;
  }
  const picker=view.bindingEditor;
  return `<div class="sd-character-library" aria-busy="${Boolean(view.busy)}"><fieldset ${disabled}>
    <section class="sd-card sd-character-current"><div class="sd-storyboard-card-body">${view.subjects.map((subject,index)=>{
      const binding=selectCharacterBinding(view.bindings,subject,view.chatKey),bound=view.rows.find(row=>row.id===binding?.archiveId);
      return `<div class="sd-character-current-person">${identity(subject.category.toUpperCase(),subject.name,safeImage(subject.avatar),subject.category==='user'?'fa-user':'fa-circle-user')}<button type="button" class="sd-character-binding-name" data-archive-action="binding" data-subject-index="${index}" ${subject.subjectKey?'':'disabled'}>${escape(bound?.name||'未绑定')}</button></div>`;
    }).join('')}</div></section>
    ${picker?`<section class="sd-card"><div class="sd-storyboard-card-body sd-character-picker">
      <b>${escape(picker.subject.name)}</b><label><span>绑定范围</span><select class="text_pole" data-archive-binding="scope"><option value="chat" ${picker.scope==='chat'?'selected':''} ${view.chatKey?'':'disabled'}>当前聊天</option><option value="default" ${picker.scope==='default'?'selected':''}>该角色默认</option></select></label>
      <label><span>角色档案</span><select class="text_pole" data-archive-binding="archiveId"><option value="">不绑定</option>${view.rows.filter(row=>row.category===picker.subject.category).map(row=>`<option value="${escape(row.id)}" ${picker.archiveId===row.id?'selected':''}>${escape(row.name)}</option>`).join('')}</select></label>
      <div class="sd-character-tools">${icon('binding-cancel','取消绑定选择','x')}<button type="button" class="sd-btn" data-archive-action="inherit" ${picker.scope==='chat'?'':'disabled'}>沿用默认</button><span class="sd-character-spacer"></span>${icon('binding-save','保存绑定','floppy-disk')}</div>
    </div></section>`:''}
    <div class="sd-character-tools"><input class="text_pole" type="search" data-archive-search value="${escape(view.search)}" aria-label="搜索角色档案">${icon('backup-library','备份角色库与原图','download')}${icon('restore-library','恢复角色库与原图','folder')}${icon('refresh','刷新角色库','arrows-clockwise')}${icon('import','导入角色档案','upload')}</div>
    ${CHARACTER_CATEGORIES.map(category=>{
      const query=view.search.toLocaleLowerCase(),rows=view.rows.filter(row=>row.category===category&&(!query||[row.name,...row.aliases].join(' ').toLocaleLowerCase().includes(query))),shown=rows.slice(0,view.shown[category]||24);
      return `<details class="sd-card sd-character-category is-${category}" data-archive-category="${category}" ${view.collapsed[category]?'':'open'}><summary><b>${category.toUpperCase()}</b><span>${rows.length}</span>${icon('new',`新建 ${category.toUpperCase()} 档案`,'plus',`data-category="${category}"`)}</summary>
        <div class="sd-character-grid">${shown.map(row=>{
          const subject=view.subjects.find(subject=>selectCharacterBinding(view.bindings,subject,view.chatKey)?.archiveId===row.id),cover=safeImage(row.cover)||safeImage(subject?.avatar);
          return `<button type="button" class="sd-character-file ${subject?'is-bound':''}" data-archive-action="edit" data-archive-id="${escape(row.id)}"><span class="sd-character-file-image">${cover?`<img src="${escape(cover)}" alt="" loading="lazy" decoding="async">`:'<i data-qm-icon="qm-regular-user"></i>'}</span><b>${escape(row.name)}</b></button>`;
        }).join('')}${rows.length>shown.length?`<button type="button" class="sd-btn sd-character-more" data-archive-action="more" data-category="${category}">更多</button>`:''}</div></details>`;
    }).join('')}
    ${status(view)}
  </fieldset><input type="file" data-archive-file accept=".json,application/json" hidden></div>`;
}

export function createCharacterArchiveController({resolveNamespace,getContext,getScope,isCurrent=()=>true,onIcons=()=>{},identity,notify=()=>{},confirm=async()=>false,download,saveReference,loadComfyRecipe,requestHeaders=()=>({}),
  onCollapse=()=>{},collapsed={},store=createCharacterArchiveStore()}={}) {
  const view={rows:[],bindings:[],subjects:[],chatKey:'',search:'',draft:null,bindingEditor:null,collapsed:{...collapsed},shown:{},bindingShown:24,busy:false,error:''};
  let host=null,namespace='',entry=0,disposed=false,verified=-1;const scrolls={list:0,editor:0,restore:0};
  const clearRestore=()=>{const r=view.restoring;r?.session?.close();r?.workflows?.close();r?.journal?.close();view.restoring=null;};
  const visible=()=>!disposed&&host?.isConnected&&isCurrent();
  const position=()=>host?.closest('.sd-storyboard-scroll');
  const scrollMode=()=>view.restoring?'restore':view.draft?'editor':'list';
  const remember=()=>{scrolls[scrollMode()]=position()?.scrollTop||0;};
  const restore=()=>{const node=position();if(node)node.scrollTop=scrolls[scrollMode()];};
  const draw=()=>{
    if(!visible())return;
    if(verified!==entry)host.innerHTML=`<div role="status">${escape(view.error||'正在读取角色库')}<button type="button" class="sd-btn" data-archive-action="refresh">重试</button></div>`;
    else host.innerHTML=renderCharacterArchive(view,{identity});
    bind();onIcons(host);
  };
  async function authorize(expected=entry) {
    const next=await resolveNamespace();
    if(!visible()||expected!==entry)throw Error('页面已切换，操作未继续');
    if(namespace&&next!==namespace){clearRestore();view.draft=null;view.comfyEditor=null;view.rows=[];view.bindings=[];view.bindingEditor=null;verified=-1;namespace=next;throw Error('账户已切换，请刷新角色库');}
    namespace=next;
    const context=await getContext();
    if(!visible()||expected!==entry)throw Error('页面已切换，操作未继续');
    if(view.chatKey!==context.chatKey)view.bindingEditor=null;
    view.chatKey=context.chatKey;view.subjects=context.subjects;verified=entry;return next;
  }
  const loadList=async expected=>{const [rows,bindings]=await Promise.all([store.list(namespace),store.bindings(namespace)]);await authorize(expected);view.rows=rows;view.bindings=bindings;};
  const run=async work=>{
    if(view.busy||!visible())return;const expected=entry;view.busy=true;view.error='';draw();
    const guard=()=>authorize(expected);
    try{await guard();await work(guard,expected);}catch(error){if(visible()&&expected===entry){view.error=error.message||'角色库操作失败';notify(view.error,'warning');}}
    finally{view.busy=false;if(expected===entry)draw();else if(visible())void run((_guard,next)=>loadList(next));}
  };
  const edit=(document,head={})=>{remember();view.draft={id:head.id||'',revision:head.revision||'',version:head.version||0,document:clone(document),dirty:false};view.bindingEditor=null;view.bindingShown=24;scrolls.editor=0;};
  const toList=()=>{remember();view.draft=null;};
  const exportDocument=doc=>{const data=exportCharacterArchive(doc);download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`${doc.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_')}.character.qianmu.json`);if(data.comfyOmitted)notify('已导出文字档案，参考图与 Comfy 实现请在目标环境重新绑定','info');else if(data.referenceOmitted)notify('已导出文字档案，参考图请在目标环境重新选择','info');};
  const currentBinding=picker=>view.bindings.find(row=>row.category===picker.subject.category&&row.subjectKey===picker.subject.subjectKey&&row.scope===picker.scope&&row.chatKey===(picker.scope==='chat'?view.chatKey:''));
  async function act(action,button) {
    if(action==='import'){if(!view.busy)host.querySelector('[data-archive-file]')?.click();return;}
    if(action==='restore-file'){if(!view.busy)host.querySelector('[data-archive-backup-file]')?.click();return;}
    if(view.comfyEditor)captureComfyCharacterEditor(host,view.comfyEditor);
    await run(async(guard,expected)=>{
      const id=button?.dataset.archiveId,category=button?.dataset.category;
      const itemIndex=Number(button?.dataset.itemIndex),editor=view.comfyEditor;
      if(action==='restore-library'&&!view.draft){
        const module=await import('./qianmu-storyboard-package-journal.js');await guard();clearRestore();remember();
        scrolls.restore=0;view.restoring={journal:module.createStoryboardPackageJournal(),record:null,session:null,preview:null,choices:{},bindingsReviewed:false,page:0};
        view.restoring.record=await view.restoring.journal.loadResource(namespace);await guard();return;
      }
      if(action==='restore-cancel'){clearRestore();await loadList(expected);return;}
      if(action==='restore-more'){view.restoring.page++;return;}
      if(action==='restore-previous'){view.restoring.page=Math.max(0,view.restoring.page-1);return;}
      if(action==='restore-dismiss'){
        const r=view.restoring,account=namespace;
        if(!r?.record||!await confirm('结束此恢复核对记录？已保存的档案、工作流和图片不会删除或回滚；请保留原备份，未完成部分需重新核对。'))return;
        await guard();await r.journal.dismissResource(r.record,{confirmed:true,isCurrent:()=>visible()&&entry===expected&&namespace===account});await guard();
        r.record=null;r.preview=null;return;
      }
      if(action==='restore-preview'){
        const r=view.restoring;if(!r?.session)return;r.preview=null;r.bindingsReviewed=false;
        try{r.preview=await r.session.preview(r.choices);r.record=r.preview.record;await guard();}
        catch(error){if(error?.code==='character_archive_choice_stale')r.choices={};throw error;}
        return;
      }
      if(action==='restore-commit'){
        const r=view.restoring;if(!r?.session||!r.preview?.ready)return;
        if(!await confirm(`按已确认选择恢复角色库？将保留未纳入的本机档案；同名不同原图不会覆盖。分步恢复不能跨库整体撤销，中断请保留原包核对续接。本操作不启动生成，也不改变镜头台开关；原有自动设置仍然有效。`))return;
        await guard();
        try{const result=await r.session.restore(r.preview,{confirmed:true,bindingsReviewed:r.bindingsReviewed});await guard();r.record=result.checkpoint;view.bindingEditor=null;await loadList(expected);notify('角色库与原图已恢复并核对','success');r.preview=null;}
        finally{if(visible()&&expected===entry&&view.restoring===r){r.preview=null;r.choices={};r.bindingsReviewed=false;r.page=0;r.record=await r.journal.loadResource(namespace);}}
        return;
      }
      if(action==='backup-library'&&!view.draft){
        const account=namespace,chatKey=view.chatKey,isSame=()=>Boolean(visible()&&entry===expected&&namespace===account&&view.chatKey===chatKey);
        const codec=await import('./qianmu-character-backup-file.js');await guard();
        const library=await store.backup(account,{isCurrent:isSame}),census=codec.collectCharacterBackupDependencies(library);await guard();
        if(!await confirm(`备份全部已保存的 ${library.usage.count} 份角色档案、${library.usage.bindings} 处绑定及 ${census.images.length} 份参考图/封面原件？包含普通形象、性征与 Comfy 实现，仅保存到本机文件，请妥善保管。不含模型/LoRA 磁盘文件、API 连接与授权。请使用“恢复角色库与原图”入口核对同账户恢复；实测前保留旧环境和原文件。`))return;
        await guard();let workflows=null;
        if(census.workflows.length){
          const module=await import('./qianmu-comfy-library.js');await guard();const workflowStore=module.createComfyWorkflowStore();
          try{workflows=codec.selectCharacterBackupWorkflows(library,await workflowStore.backup(account,{isCurrent:isSame}));}finally{workflowStore.close();}
        }
        const result=await codec.buildCharacterBackupFile(library,{workflows,guard});await guard();if(!isSame())throw Error('角色备份页面已变化');
        await download(result.file,'qianmu-character-resources.json');return;
      }
      if(action==='comfy-new'||action==='comfy-edit'||action==='comfy-rebind'){
        if(!view.draft||typeof loadComfyRecipe!=='function')throw Error('请先在 Comfy 镜头台应用已保存的工作流方案');
        const previous=action==='comfy-edit'?view.draft.document.comfy?.implementations[itemIndex]:null;
        if(action==='comfy-rebind'&&!await confirm('改绑当前 Comfy 方案会清空此草稿的节点选择，继续？'))return;
        await guard();const recipe=comfyCharacterEditorRecipe(await loadComfyRecipe(previous?.workflow||null,namespace,guard));await guard();
        if(!editor){remember();view.comfyReturnScroll=scrolls.editor;scrolls.editor=0;}
        view.comfyEditor={index:action==='comfy-edit'?itemIndex:editor?.index??-1,recipe,implementation:previous?clone(previous):newComfyCharacterImplementation(recipe)};return;
      }
      if(action==='comfy-cancel'){view.comfyEditor=null;scrolls.editor=view.comfyReturnScroll||0;return;}
      if(action==='comfy-remove'){
        const rows=view.draft?.document.comfy?.implementations;if(!rows?.[itemIndex])throw Error('角色实现已变化');
        rows.splice(itemIndex,1);view.draft.dirty=true;return;
      }
      if(action==='comfy-save'){
        const implementation=saveComfyCharacterEditor(editor),doc=view.draft.document;
        doc.comfy ||= {version:1,implementations:[]};const rows=clone(doc.comfy.implementations);
        if(rows.some((row,index)=>index!==editor.index&&row.workflow.id===implementation.workflow.id&&row.workflow.revision===implementation.workflow.revision))throw Error('此工作流版本已经绑定，请编辑原实现');
        if(editor.index<0)rows.push(implementation);else rows[editor.index]=implementation;
        doc.comfy=normalizeCharacterArchive({...doc,comfy:{version:1,implementations:rows}}).comfy;
        view.draft.dirty=true;view.comfyEditor=null;scrolls.editor=view.comfyReturnScroll||0;notify('实现已加入草稿，请保存角色档案','info');return;
      }
      if(action==='comfy-add-lora'){
        const row=editor.recipe.targets.loras.find(item=>!editor.implementation.loras.some(lora=>lora.nodeId===item.nodeId));
        if(!row||editor.implementation.loras.length>=8)throw Error('没有可添加的空闲 LoRA 节点');
        const graph=JSON.parse(editor.recipe.document.workflow);
        editor.implementation.loras.push({nodeId:row.nodeId,classType:row.classType,loraName:graph[row.nodeId].inputs.lora_name||'',strengthModel:1,strengthClip:row.classType==='LoraLoader'?1:null});return;
      }
      if(action==='comfy-add-text'){
        const row=editor.recipe.targets.conditioning.find(item=>!editor.implementation.conditioning.some(text=>text.nodeId===item.nodeId));
        if(!row||editor.implementation.conditioning.length>=8)throw Error('没有可添加的空闲人物词节点');
        editor.implementation.conditioning.push({nodeId:row.nodeId,kind:'positive',text:''});return;
      }
      if(action==='comfy-remove-lora'){editor.implementation.loras.splice(itemIndex,1);return;}
      if(action==='comfy-remove-text'){editor.implementation.conditioning.splice(itemIndex,1);return;}
      if(action==='refresh'){await loadList(expected);return;}
      if(action==='new'){edit(newCharacterArchive(category));return;}
      if(action==='more'){view.shown[category]=(view.shown[category]||24)+24;return;}
      if(action==='more-bindings'){view.bindingShown+=24;return;}
      if(action==='edit'){const saved=await store.load(namespace,id);await guard();if(!saved)throw Error('档案已不存在，请刷新列表');edit(saved.document,saved.head);return;}
      if(action==='cancel'){if(view.draft?.dirty&&!await confirm('放弃尚未保存的档案修改？'))return;await guard();toList();await loadList(expected);return;}
      if(action==='copy'){const doc=normalizeCharacterArchive(view.draft.document);edit({...doc,name:`${doc.name.slice(0,74)} 副本`});view.draft.dirty=true;return;}
      if(action==='clear-image'){view.draft.document.imagegen.reference=null;view.draft.document.imagegen.preview=null;view.draft.dirty=true;return;}
      if(action==='export'){exportDocument(view.draft.document);return;}
      if(action==='save'){const draft=view.draft;await store.save(namespace,{id:draft.id,expectedRevision:draft.revision,document:draft.document});await guard();notify('档案已保存','success');toList();await loadList(expected);return;}
      if(action==='delete'){const draft=view.draft;if(!draft.id)return;if(!await confirm('删除此档案？档案文字不可恢复；参考图文件和历史成片不会删除。'))return;await guard();await store.remove(namespace,draft.id,draft.revision);await guard();toList();await loadList(expected);notify('档案已删除，参考文件保留','success');return;}
      if(action==='unbind'){
        const rows=view.bindings.filter(row=>row.archiveId===view.draft.id),row=rows[Number(button.dataset.bindingIndex)];if(!row)throw Error('绑定已变化');
        if(!await confirm('解除此绑定？当前聊天级解除后将沿用角色默认绑定。'))return;await guard();
        await store.bind(namespace,{target:row,expectedRevision:row.revision,inherit:true});await loadList(expected);return;
      }
      if(action==='binding'){
        const subject=view.subjects[Number(button.dataset.subjectIndex)];if(!subject?.subjectKey)return;
        const scope=view.chatKey?'chat':'default',row=selectCharacterBinding(view.bindings,subject,view.chatKey);
        view.bindingEditor={subject,scope,archiveId:row?.archiveId||''};return;
      }
      if(action==='binding-cancel'){view.bindingEditor=null;return;}
      if(action==='binding-save'||action==='inherit'){
        const picker=view.bindingEditor;if(!picker)return;
        const target={category:picker.subject.category,subjectKey:picker.subject.subjectKey,scope:picker.scope,chatKey:view.chatKey};
        await store.bind(namespace,{target,archiveId:picker.archiveId,expectedRevision:currentBinding(picker)?.revision||'',inherit:action==='inherit'});
        await guard();view.bindingEditor=null;await loadList(expected);notify('绑定已保存','success');return;
      }
    });restore();
  }
  function bind() {
    host.querySelectorAll('[data-archive-action]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void act(button.dataset.archiveAction,button);}));
    host.querySelector('.sd-comfy-role-editor')?.addEventListener('input',()=>{if(view.comfyEditor)captureComfyCharacterEditor(host,view.comfyEditor);});
    host.querySelectorAll('[data-comfy-lora-node]').forEach(input=>input.addEventListener('change',()=>{if(view.comfyEditor){captureComfyCharacterEditor(host,view.comfyEditor);draw();}}));
    host.querySelectorAll('[data-archive-category]').forEach(details=>details.addEventListener('toggle',()=>{if(!visible()||!host.contains(details))return;const key=details.dataset.archiveCategory,next=!details.open;if(Boolean(view.collapsed[key])===next)return;view.collapsed[key]=next;onCollapse({...view.collapsed});}));
    host.querySelector('[data-archive-search]')?.addEventListener('input',event=>{const start=event.target.selectionStart;view.search=event.target.value;draw();const input=host.querySelector('[data-archive-search]');input?.focus();try{input?.setSelectionRange(start,start);}catch(_){}});
    host.querySelectorAll('[data-archive-field]').forEach(field=>field.addEventListener('input',()=>{
      if(!view.draft)return;const key=field.dataset.archiveField,doc=view.draft.document;view.draft.dirty=true;
      if(key==='name'||key==='ageStatus')doc[key]=field.value;
      else if(key==='aliases')doc.aliases=field.value.split(/[,，\n]/).map(value=>value.trim()).filter(Boolean);
      else if(['appearance','negative','sensitiveAppearance'].includes(key))doc.imagegen[key]=field.value;
      else if(key==='referenceStrength'||key==='referenceFidelity'){
        doc.imagegen.novelReference ||= {strength:0.6,fidelity:1};
        doc.imagegen.novelReference[key==='referenceStrength'?'strength':'fidelity']=field.value===''?'invalid':Number(field.value);
      }
    }));
    host.querySelectorAll('[data-archive-binding]').forEach(field=>field.addEventListener('change',()=>{if(!view.bindingEditor)return;view.bindingEditor[field.dataset.archiveBinding]=field.value;if(field.dataset.archiveBinding==='scope'){const row=currentBinding(view.bindingEditor);view.bindingEditor.archiveId=row?.archiveId||'';draw();}}));
    host.querySelector('[data-archive-restore-reviewed]')?.addEventListener('change',event=>{if(!view.restoring)return;view.restoring.bindingsReviewed=event.target.checked;draw();});
    host.querySelectorAll('[data-archive-restore-decision]').forEach(field=>field.addEventListener('change',()=>{
      const r=view.restoring,row=r?.preview?.conflicts[Number(field.dataset.archiveRestoreDecision)];if(!row)return;
      if(view.busy)return;remember();
      if(field.value)r.choices[row.key]=field.value;else delete r.choices[row.key];r.bindingsReviewed=false;
      r.preview={...r.preview,ready:false,needsRecheck:true,planDigest:''};
      void run(async guard=>{r.preview=await r.session.choose(r.choices);await guard();}).then(()=>{if(visible()&&view.restoring===r)restore();});
    }));
    host.querySelector('[data-archive-backup-file]')?.addEventListener('change',event=>{const file=event.target.files?.[0],r=view.restoring;if(!file||!r)return;void run(async(guard,expected)=>{
      r.session?.close();r.workflows?.close();r.session=null;r.workflows=null;r.preview=null;r.choices={};r.bindingsReviewed=false;r.page=0;r.fileName=file.name;scrolls.restore=0;
      const [files,module,imageModule]=await Promise.all([import('./qianmu-character-backup-file.js'),import('./qianmu-character-backup-restore.js'),import('./qianmu-image-restore-client.js')]);await guard();
      const account=namespace,chatKey=view.chatKey,scope=getScope?.();
      const same=()=>Boolean(visible()&&entry===expected&&namespace===account&&view.chatKey===chatKey&&view.restoring===r&&(!getScope||getScope()===scope));
      const active=async()=>{
        if(!same())throw Error('角色恢复页面或聊天已变化');
        // Restore checks identity frequently; the production scope token avoids rereading avatars or scanning the chat DOM each time.
        if(!getScope||await resolveNamespace()!==account)await guard();
        if(!same())throw Error('角色恢复页面或聊天已变化');
      };
      const packet=await files.readCharacterBackupFile(file,{guard:active});await active();
      if(packet.workflows){const library=await import('./qianmu-comfy-library.js');await active();r.workflows=library.createComfyWorkflowStore();}
      r.session=await module.createCharacterRestoreSession(account,packet,{store,workflowStore:r.workflows,journal:r.journal,
        images:imageModule.createImageRestoreClient({namespace:account,headers:requestHeaders,guard:active}),guard:active,isCurrent:same});
      await active();r.preview=await r.session.preview();r.record=r.preview.record;await active();restore();
    });});
    host.querySelector('[data-archive-file]')?.addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;void run(async guard=>{
      if(file.size>128*1024)throw Error('档案文件须小于 128 KB');const imported=importCharacterArchive(await file.text());await guard();edit(imported.document);view.draft.dirty=true;if(imported.comfyOmitted)notify('文字档案已载入，请重新绑定参考图与 Comfy 实现','info');else if(imported.referenceOmitted)notify('文字档案已载入，请重新选择参考图','info');
    });});
    host.querySelector('[data-archive-image]')?.addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;const draft=view.draft;void run(async guard=>{
      const result=await saveReference(file,guard);await guard();if(view.draft!==draft)throw Error('编辑页已变化，原档案未修改');draft.document.imagegen.reference=result.reference;draft.document.imagegen.preview=result.preview;draft.dirty=true;
    });});
  }
  return Object.freeze({
    mount(element){if(disposed)return;const changed=host!==element;if(changed&&view.restoring){clearRestore();notify('恢复页面已重建，请重新选择原备份核对；已保存部分保留','info');}host=element;if(changed)entry++;draw();if(changed||verified!==entry)void run((_guard,expected)=>loadList(expected));},
    detach(){remember();clearRestore();host=null;entry++;},
    dispose(){clearRestore();disposed=true;host=null;view.draft=null;view.comfyEditor=null;entry++;store.close();},
  });
}
