import {DEFAULT_COMPOSITION_SCHEME,selectCompositionScheme,bindCurrentComposition,saveCompositionScheme,deleteCompositionScheme,updateCompositionPolicy} from './qianmu-composition-schemes.js';
const nameDrafts=new WeakMap();
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const strategyLabels={single:'统一主画幅',main_secondary:'主画幅 + 强调画幅',montage:'自由组合'};
export function renderCompositionSelector(state){
  const id=state.compositionSchemeId||'';
  const changed=row=>id===row.id&&JSON.stringify(row.policy)!==JSON.stringify(state.compositionPolicy)?'（已调整）':'';
  return `<label class="sd-composition-selector"><span>构景之律</span><select class="text_pole" data-composition-select aria-label="构景方案"><option value="" ${!id?'selected':''}>当前构景</option><option value="${DEFAULT_COMPOSITION_SCHEME}" ${id===DEFAULT_COMPOSITION_SCHEME?'selected':''}>千幕默认</option>${(state.compositionSchemes||[]).map(row=>`<option value="${escape(row.id)}" ${id===row.id?'selected':''}>${escape(row.name)}${changed(row)}</option>`).join('')}</select></label>`;
}
export function renderCompositionEditor(state,{ratios}={}){
  const policy=state.compositionPolicy,selected=state.compositionSchemes?.find(row=>row.id===state.compositionSchemeId),preset=state.promptPresets?.find(row=>row.id===state.promptCompiler?.instructionPresetId);
  const options=(rows,current)=>rows.map(row=>`<option value="${row.id}" ${row.id===current?'selected':''}>${escape(row.label)}</option>`).join('');
  const binding=preset?.compositionBinding;
  return `<details class="sd-card sd-storyboard-preset-entry sd-composition-editor" data-composition-editor ${state.collapsedCards?.['composition-editor']===false?'open':''}>
    <summary><b>构景之律</b><small>${escape(selected?.name||(state.compositionSchemeId===DEFAULT_COMPOSITION_SCHEME?'千幕默认':'当前构景'))}</small></summary>
    <div class="sd-storyboard-card-body">
      ${renderCompositionSelector(state)}
      <div class="sd-composition-save-row"><input class="text_pole" data-composition-name aria-label="构景方案名" maxlength="80" placeholder="方案名" value="${escape(nameDrafts.get(state)??selected?.name??'')}"><button class="sd-btn" type="button" data-composition-action="new">另存方案</button><button class="sd-icon-btn" type="button" data-composition-action="save" title="更新方案" aria-label="更新方案" ${selected?'':'disabled'}><i class="fa-solid fa-floppy-disk"></i></button><button class="sd-icon-btn" type="button" data-composition-action="delete" title="删除方案" aria-label="删除方案" ${selected?'':'disabled'}><i class="fa-solid fa-trash-can"></i></button></div>
      ${preset?`<label class="sd-option-chip sd-composition-binding"><input type="checkbox" data-composition-bind ${binding?'checked':''}><span>${binding?'已绑定：'+escape(binding.name||'构景方案'):'绑定当前方案'}</span></label><small>切换取景预设时应用绑定；临时调整不会改写绑定。</small>`:'<small>选择取景预设后，可将构景方案与它绑定。</small>'}
      <div class="sd-storyboard-composition-mode" role="radiogroup" aria-label="比例分配方式">${[['smart','智能分配'],['fixed','固定比例']].map(([value,label])=>`<label class="sd-option-chip"><input type="radio" name="qm-composition-mode" data-composition-field="mode" value="${value}" ${policy.mode===value?'checked':''}><span>${label}</span></label>`).join('')}</div>
      ${policy.mode==='fixed'?`<label><span>固定比例</span><select class="text_pole" data-composition-field="fixedRatioId">${options(ratios,policy.fixedRatioId)}</select></label>`:`<div class="sd-composition-pair"><label><span>优先主画幅</span><select class="text_pole" data-composition-field="preferredRatioId">${options(ratios.filter(row=>policy.allowedRatioIds.includes(row.id)),policy.preferredRatioId)}</select></label><label><span>画幅策略</span><select class="text_pole" data-composition-field="groupStrategy">${Object.entries(strategyLabels).map(([value,label])=>`<option value="${value}" ${policy.groupStrategy===value?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="sd-storyboard-composition-ratios" aria-label="允许的画幅">${ratios.map(row=>`<label class="sd-option-chip"><input type="checkbox" data-composition-ratio value="${row.id}" ${policy.allowedRatioIds.includes(row.id)?'checked':''}><span>${escape(row.label)}</span></label>`).join('')}</div>`}
      <label><span>个人修订</span><textarea class="text_pole" rows="3" data-composition-field="ruleOverride" spellcheck="false">${escape(policy.ruleOverride)}</textarea></label><div role="status" data-composition-status></div>
    </div></details>`;
}
export function bindCompositionEditor(root,state,{normalize,current=()=>true,save=()=>{},render=()=>{},createId}={}){
  const presetId=state.promptCompiler?.instructionPresetId;
  const owned=()=>current()&&presetId===state.promptCompiler?.instructionPresetId;
  const apply=action=>{
    if(!owned())return;
    // Native toggle dispatch is deferred. Capture the live state before a
    // control's change repaints, and ignore toggle events from replaced cards.
    const editor=root.querySelector('[data-composition-editor]');
    if(editor){state.collapsedCards||={};state.collapsedCards['composition-editor']=!editor.open;}
    const previous={compositionPolicy:state.compositionPolicy,compositionSchemeId:state.compositionSchemeId,compositionSchemes:state.compositionSchemes};
    const bindings=(state.promptPresets||[]).map(preset=>({preset,owns:Object.hasOwn(preset,'compositionBinding'),value:structuredClone(preset.compositionBinding)}));
    try{action();save();}catch(error){
      Object.assign(state,previous);
      for(const row of bindings)if(row.owns)row.preset.compositionBinding=row.value;else delete row.preset.compositionBinding;
      root.querySelectorAll('[data-composition-ratio]').forEach(field=>field.checked=state.compositionPolicy.allowedRatioIds.includes(field.value));
      const binding=root.querySelector('[data-composition-bind]');if(binding)binding.checked=Boolean(state.promptPresets.find(row=>row.id===presetId)?.compositionBinding);
      const status=root.querySelector('[data-composition-status]');if(status)status.textContent=error.message;
      return;
    }
    render();
  };
  root.querySelector('[data-composition-name]')?.addEventListener('input',event=>{if(owned())nameDrafts.set(state,event.target.value);});
  root.querySelectorAll('[data-composition-select]').forEach(field=>field.addEventListener('change',()=>apply(()=>{selectCompositionScheme(state,field.value,normalize);nameDrafts.delete(state);} )));
  root.querySelectorAll('[data-composition-field]').forEach(field=>field.addEventListener('change',()=>apply(()=>updateCompositionPolicy(state,field.dataset.compositionField,field.value,normalize))));
  root.querySelectorAll('[data-composition-ratio]').forEach(field=>field.addEventListener('change',()=>apply(()=>updateCompositionPolicy(state,'allowedRatioIds',[...root.querySelectorAll('[data-composition-ratio]:checked')].map(row=>row.value),normalize))));
  root.querySelector('[data-composition-bind]')?.addEventListener('change',event=>apply(()=>bindCurrentComposition(state,state.promptPresets.find(row=>row.id===presetId),event.target.checked,normalize)));
  root.querySelectorAll('[data-composition-action]').forEach(button=>button.addEventListener('click',()=>apply(()=>{
    const action=button.dataset.compositionAction;if(action==='delete'){deleteCompositionScheme(state,state.compositionSchemeId);nameDrafts.delete(state);return;}
    saveCompositionScheme(state,root.querySelector('[data-composition-name]').value,{id:action==='save'?state.compositionSchemeId:undefined,createId,normalize});nameDrafts.delete(state);
  })));
  const details=root.querySelector('[data-composition-editor]');details?.addEventListener('toggle',()=>{if(details.isConnected&&owned()&&state.collapsedCards?.['composition-editor']!==!details.open){state.collapsedCards||={};state.collapsedCards['composition-editor']=!details.open;save();}});
}
