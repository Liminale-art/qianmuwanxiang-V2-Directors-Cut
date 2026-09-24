const copy=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const option=(id,name,selected)=>`<option value="${escape(id)}" ${selected?'selected':''}>${escape(name)}</option>`;

export function renderEnsembleTargetPicker({target,providers,models=[],connections=[],parameters=[],message='',busy=false}){
  const comfy=target.providerId==='comfy',binding=target.comfyWorkflowBinding;
  return `<section class="sd-ensemble-target-picker"><h3>生成方式</h3><div class="sd-ensemble-target-fields"><label><span>生图渠道</span><select class="text_pole" data-ensemble-target="providerId" ${busy?'disabled':''}>${Object.values(providers).map(row=>option(row.id,row.label,row.id===target.providerId)).join('')}</select></label>
    ${comfy?`<label><span>工作流</span><button type="button" class="sd-btn" data-ensemble-pick-workflow ${busy?'disabled':''}>${escape(binding&&!binding.invalid?binding.name:'选择工作流')}</button></label>`:`<label><span>模型</span><input class="text_pole" data-ensemble-target="modelId" value="${escape(target.modelId)}" maxlength="240" spellcheck="false" ${models.length?'list="sd-ensemble-target-models"':''} ${busy?'disabled':''}>${models.length?`<datalist id="sd-ensemble-target-models">${models.map(row=>option(row.id,row.label||row.id,false)).join('')}</datalist>`:''}</label>${models.length&&!models.some(row=>row.id===target.modelId)?`<label><span>模型类型</span><select class="text_pole" data-ensemble-target="capabilityModelId" ${busy?'disabled':''}>${models.map(row=>option(row.id,row.label||row.id,row.id===target.capabilityModelId)).join('')}</select></label>`:''}`}
    <label><span>API 预设</span><select class="text_pole" data-ensemble-target="connectionPresetId" ${busy?'disabled':''}>${option('','当前连接',!target.connectionPresetId)}${target.connectionPresetId&&!connections.some(row=>row.id===target.connectionPresetId)?option(target.connectionPresetId,'请重新选择',true):''}${connections.map(row=>option(row.id,row.name,row.id===target.connectionPresetId)).join('')}</select></label>
    ${!comfy&&parameters.length?`<label><span>绘制预设</span><select class="text_pole" data-ensemble-target="parameterPresetId" ${busy?'disabled':''}>${option('','当前参数',!target.parameterPresetId)}${target.parameterPresetId&&!parameters.some(row=>row.id===target.parameterPresetId)?option(target.parameterPresetId,'请重新选择',true):''}${parameters.map(row=>option(row.id,row.name,row.id===target.parameterPresetId)).join('')}</select></label>`:''}</div><p role="status" aria-live="polite">${escape(message)}</p></section>`;
}

// Edits a private draft. The host validates capabilities and persists only after
// the user saves the enclosing style; opening or cancelling writes nothing.
export async function openEnsembleTargetPicker({context,target,providers,defaultTarget,models=()=>[],connections=()=>[],parameterPresets=()=>[],pickWorkflow,validateTarget,guard=async()=>{},mountAppearance}={}){
  if(!context?.Popup||!context.POPUP_TYPE||typeof defaultTarget!=='function'||typeof validateTarget!=='function')throw Error('生成设置暂不可用');
  await guard();let draft=copy(target||defaultTarget()),message='';
  for(;;){
    const wrap=document.createElement('div');let alive=true,busy=false;
    const paint=()=>{if(alive)wrap.innerHTML=renderEnsembleTargetPicker({target:draft,providers,models:models(draft.providerId),connections:connections(draft.providerId),parameters:parameterPresets(draft),message,busy});};
    paint();
    const change=event=>{
      const key=event.target.dataset?.ensembleTarget;if(!key||busy)return;
      if(key==='providerId'){if(!Object.hasOwn(providers,event.target.value))return;draft=copy(defaultTarget(event.target.value));message='';paint();}
      else if(key==='modelId'){draft.modelId=String(event.target.value).trim();const known=models(draft.providerId).find(row=>row.id===draft.modelId);if(known)draft.capabilityModelId=known.id;draft.parameterPresetId='';message='';paint();}
      else if(key==='capabilityModelId'){if(!models(draft.providerId).some(row=>row.id===event.target.value))return;draft.capabilityModelId=event.target.value;draft.parameterPresetId='';message='';paint();}
      else if(['connectionPresetId','parameterPresetId'].includes(key))draft[key]=String(event.target.value);
    };
    const click=async event=>{
      if(!event.target.closest?.('[data-ensemble-pick-workflow]')||busy||typeof pickWorkflow!=='function')return;
      busy=true;message='';paint();
      try{await guard();const picked=await pickWorkflow(copy(draft));await guard();if(alive&&picked)draft=copy(picked);}
      catch(error){if(alive)message=error?.message||'工作流未选择，请重试';}
      finally{busy=false;paint();}
    };
    wrap.addEventListener('change',change);wrap.addEventListener('click',click);
    let result,releaseAppearance;
    try{
      const popup=new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'选用',cancelButton:'取消'});popup.dlg?.classList.add('sd-ensemble-target-dialog');
      const shown=popup.show();try{if(popup.dlg?.isConnected)releaseAppearance=mountAppearance?.(popup.dlg);}catch(_){console.warn('[千幕] 生成设置外观未接入');}result=await shown;
    }finally{alive=false;wrap.removeEventListener('change',change);wrap.removeEventListener('click',click);try{releaseAppearance?.();}catch(_){console.warn('[千幕] 生成设置外观清理失败');}}
    await guard();if(!result)return null;
    if(busy){message='请先完成工作流选择';continue;}
    try{
      if(draft.providerId==='comfy'&&(!draft.comfyWorkflowBinding||draft.comfyWorkflowBinding.invalid))throw Error('请选择工作流');
      const validated=await validateTarget(copy(draft));await guard();
      return {target:copy(validated?.target||draft),artistCapable:validated?.artistCapable===true,label:validated?.label||''};
    }catch(error){message=error?.message||'请检查生成设置';}
  }
}
