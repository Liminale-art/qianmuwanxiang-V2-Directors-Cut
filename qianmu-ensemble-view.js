import {qianmuIconMarkup} from './qianmu-icon-renderer.js';
import {createEnsembleLibraryEditor} from './qianmu-ensemble-editor.js?v=1.59.276';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const glyph=name=>qianmuIconMarkup(`qm-regular-${name}`);
const icon=(action,label,name,disabled=false,extra='')=>`<button type="button" class="sd-ensemble-icon" data-ensemble-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${disabled?'disabled':''} ${extra}>${glyph(name)}</button>`;
const option=(value,label,selected,disabled=false)=>`<option value="${escape(value)}" ${selected?'selected':''} ${disabled?'disabled':''}>${escape(label)}</option>`;
export function renderEnsembleSchemeList(view){
  const needle=view.search.trim().toLocaleLowerCase(),selected=new Set(view.selection?.schemeIds||[]);
  const rows=(view.library?.schemes||[]).filter(row=>row.archived===view.archived&&(!needle||[row.name,row.description,...row.tags].some(text=>text.toLocaleLowerCase().includes(needle))));
  if(!view.ready)return `<p class="sd-ensemble-empty">${view.busy?'正在读取方案库…':'暂未读取，点击刷新重试。'}</p>`;
  if(!rows.length)return `<p class="sd-ensemble-empty">${needle?'没有匹配的风格方案':view.archived?'暂无归档方案':'还没有风格方案，点击＋建立一个。'}</p>`;
  return rows.map(row=>`<article class="sd-ensemble-scheme ${selected.has(row.id)&&!row.archived?'is-selected':''}"><div class="sd-ensemble-scheme-copy"><b>${escape(row.name)}</b>${row.description?`<p>${escape(row.description)}</p>`:''}<div class="sd-ensemble-tags">${row.tags.map(tag=>`<span>${escape(tag)}</span>`).join('')}</div></div><div class="sd-ensemble-scheme-actions">${icon('edit','编辑 '+row.name,'pencil-simple',view.busy,`data-id="${escape(row.id)}"`)}${row.archived?icon('archive','恢复 '+row.name,'arrow-counter-clockwise',view.busy,`data-id="${escape(row.id)}"`):`<button type="button" class="sd-ensemble-select" data-ensemble-action="toggle" data-id="${escape(row.id)}" aria-label="本聊天启用 ${escape(row.name)}" aria-pressed="${selected.has(row.id)}" ${view.busy||!view.chatKey?'disabled':''}>${selected.has(row.id)?'已选':'选用'}</button>`}</div></article>`).join('');
}
function form(view){
  const draft=view.draft;if(!draft)return '';const route=view.targets.find(row=>row.id===draft.binding.routeId),artistId=draft.binding.artistPresetId;
  return `<section class="sd-ensemble-editor"><header><b>${view.library.schemes.some(row=>row.id===draft.id)?'编辑风格方案':'新建风格方案'}</b>${icon('cancel','返回方案库','x',view.busy)}</header><div class="sd-ensemble-fields"><label><span>风格名</span><input class="text_pole" data-ensemble-field="name" maxlength="80" value="${escape(draft.name)}" ${view.busy?'disabled':''}></label><label><span>适用画面</span><textarea class="text_pole" data-ensemble-field="description" maxlength="800" rows="3" ${view.busy?'disabled':''}>${escape(draft.description)}</textarea></label><label><span>风格标签</span><input class="text_pole" data-ensemble-field="tagText" maxlength="2000" placeholder="用逗号分隔" value="${escape(draft.tagText)}" ${view.busy?'disabled':''}></label><div class="sd-ensemble-binding-fields"><label><span>绘制线路</span><select class="text_pole" data-ensemble-field="routeId" ${view.busy?'disabled':''}>${option('','选择已有线路',!draft.binding.routeId)}${draft.binding.routeId&&!route?option(draft.binding.routeId,'原线路已失效',true,true):''}${view.targets.map(row=>option(row.id,`${row.name} · ${row.providerLabel||''}`,row.id===draft.binding.routeId,row.available===false)).join('')}</select></label><label><span>画师绑定</span><select class="text_pole" data-ensemble-field="artistPresetId" ${view.busy?'disabled':''}>${option('','沿用当前画师设置',!artistId)}${artistId&&(!route?.artistCapable||!view.artists.some(row=>row.id===artistId))?option(artistId,'原画师绑定不适用',true,true):''}${route?.artistCapable?view.artists.map(row=>option(row.id,row.name,row.id===artistId)).join(''):''}</select></label></div></div><small>复用已存线路；方案不保存 Key，不改变正文分镜或镜头数量。</small><footer>${view.library.schemes.some(row=>row.id===draft.id)?icon('archive',draft.archived?'恢复方案':'归档方案',draft.archived?'arrow-counter-clockwise':'archive',view.busy,`data-id="${escape(draft.id)}"`):'<span></span>'}<button type="button" class="sd-ensemble-save" data-ensemble-action="save" ${view.busy||view.needsRefresh?'disabled':''}>${glyph('floppy-disk')}<span>保存方案</span></button></footer></section>`;
}
export function renderEnsembleLibrary(view){
  const blocked=view.busy||!view.ready,choice=view.selection;
  return `<section class="sd-ensemble-library" aria-label="镜组风格方案" aria-busy="${view.busy}"><div class="sd-ensemble-chat"><button type="button" data-ensemble-action="enabled" class="sd-ensemble-choice" aria-pressed="${Boolean(choice?.enabled)}" ${blocked||!view.chatKey?'disabled':''}>本聊天镜组</button><button type="button" data-ensemble-action="lock" class="sd-ensemble-choice" aria-pressed="${choice?.styleLock!==false}" ${blocked||!view.chatKey?'disabled':''}>连续风格锁</button></div>${!view.chatKey?'<small>进入聊天后可选择本聊天的风格方案；方案库仍可编辑。</small>':''}<div class="sd-ensemble-toolbar"><input type="search" class="text_pole" data-ensemble-search aria-label="搜索风格方案" placeholder="搜索风格方案" value="${escape(view.search)}" ${blocked?'disabled':''}>${icon('refresh','刷新方案库','arrows-clockwise',view.busy)}${icon('add','添加风格方案','plus',blocked)}</div><div class="sd-ensemble-status" role="status" aria-live="polite">${escape(view.error||view.message||'')}</div>${form(view)}<div class="sd-ensemble-list-tools"><span>全局方案库</span><label><input type="checkbox" data-ensemble-archived ${view.archived?'checked':''} ${blocked?'disabled':''}>已归档</label></div><div data-ensemble-list>${renderEnsembleSchemeList(view)}</div></section>`;
}

// The host supplies an owned themed root and a reusable verified ST store.
// This mount does not open storage, start model work, or install document hooks.
export function mountEnsembleLibrary(root,options){
  let alive=true,model;
  function paint(view,kind){
    if(!alive)return;
    if(kind==='draft'){const status=root.querySelector('[role=status]');if(status)status.textContent=view.error||view.message;return;}
    if(kind==='list'){const list=root.querySelector('[data-ensemble-list]');if(list){list.innerHTML=renderEnsembleSchemeList(view);return;}}
    const top=root.scrollTop,focus=root.ownerDocument?.activeElement,field=root.contains(focus)?focus?.dataset?.ensembleField:null;
    root.innerHTML=renderEnsembleLibrary(view);root.scrollTop=top;if(field)root.querySelector(`[data-ensemble-field="${field}"]`)?.focus({preventScroll:true});
  }
  model=options.model||createEnsembleLibraryEditor(options);const unsubscribe=model.subscribe(paint);paint(model.snapshot(),'view');
  const report=error=>{if(alive){const status=root.querySelector('[role=status]');if(status)status.textContent=['ensemble_editor','storyboard_style_selection'].includes(error?.code)?error.message:'操作未完成，草稿保留，请刷新后核对。';}};
  const click=event=>{const button=event.target.closest?.('[data-ensemble-action]');if(!button||!root.contains(button)||button.disabled)return;
    const action=button.dataset.ensembleAction,id=button.dataset.id;
    try{let result;const view=model.snapshot();
      if(action==='add'||action==='edit')result=model.edit(action==='edit'?id:'');
      else if(action==='cancel')result=model.cancelEdit();else if(action==='save')result=model.save();
      else if(action==='archive')result=model.archive(id);else if(action==='refresh')result=model.refresh();
      else if(action==='toggle')result=model.toggleScheme(id);else if(action==='enabled')result=model.setEnabled(!view.selection?.enabled);
      else if(action==='lock')result=model.setStyleLock(view.selection?.styleLock===false);
      result?.catch?.(report);
    }catch(error){report(error);}
  };
  const input=event=>{try{const field=event.target.dataset?.ensembleField;if(field&&event.target.tagName!=='SELECT')model.setField(field,event.target.value);else if(event.target.matches?.('[data-ensemble-search]'))model.setSearch(event.target.value);}catch(error){report(error);}};
  const change=event=>{try{const field=event.target.dataset?.ensembleField;if(field&&event.target.tagName==='SELECT')model.setField(field,event.target.value);else if(event.target.matches?.('[data-ensemble-archived]'))model.showArchived(event.target.checked);}catch(error){report(error);}};
  root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);
  const ready=model.load();ready.catch(report);
  return {ready,model,close(){alive=false;unsubscribe();root.removeEventListener('click',click);root.removeEventListener('input',input);root.removeEventListener('change',change);if(!options.model)model.close();}};
}
