import { createComfyWorkflowStore } from './qianmu-comfy-library.js';
import { pinComfyRouteWorkflow } from './qianmu-comfy-route.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const choices=(heads,selectedId)=>'<option value="">选择工作流</option>'+heads.map(row=>`<option value="${escape(row.id)}" ${row.id===selectedId?'selected':''}>${escape(row.name)}</option>`).join('');
export function renderComfyRoutePicker({heads=[],selectedId='',useReferences=false,hasReferences=false,message='',loading=false}){
  return `<div class="sd-comfy-route-picker"><h3>选择工作流</h3><label><span>工作流方案</span><select class="text_pole" data-comfy-route-pick="workflow" ${loading?'disabled':''}>${choices(heads,selectedId)}</select></label>
    ${hasReferences?`<label class="sd-comfy-route-check"><input type="checkbox" data-comfy-route-references ${useReferences?'checked':''}><span>使用参考图</span></label>`:''}
    <p role="status" aria-live="polite">${escape(message||(!heads.length&&!loading?'还没有工作流方案':''))}</p><button type="button" class="sd-btn" data-comfy-route-retry hidden>重试</button></div>`;
}

// Open the owned themed surface before network reads. Selecting a workflow uses
// its saved current recipe; version pinning remains an execution invariant, not
// a second user choice. Reopening an unchanged binding retains its exact recipe.
export async function openComfyRoutePicker({context,namespace,binding,hasReferences=false,defaultUseReferences=false,guard=async()=>{},createStore=createComfyWorkflowStore,mountAppearance}){
  if(!context?.Popup||!context.POPUP_TYPE)throw Error('当前 ST 不支持工作流选择面板');
  const store=createStore();let selectedId=binding?.id||'',selected=binding||null,useReferences=hasReferences&&defaultUseReferences===true,message='';
  try{
    for(;;){
      const wrap=document.createElement('div');wrap.innerHTML=renderComfyRoutePicker({selectedId,hasReferences,useReferences,message,loading:true});
      const select=wrap.querySelector('[data-comfy-route-pick=workflow]'),status=wrap.querySelector('[role=status]'),retry=wrap.querySelector('[data-comfy-route-retry]');
      let alive=true,heads=[],pending=null,loadError=null,changed=false;
      const load=()=>{
        if(pending)return pending;select.disabled=true;loadError=null;if(retry)retry.hidden=true;status.textContent='正在读取工作流…';
        pending=(async()=>{await guard();if(!alive)return;const rows=await store.list(namespace);await guard();heads=rows.filter(row=>!row.archived);
          if(alive){select.innerHTML=choices(heads,selectedId);select.value=heads.some(row=>row.id===selectedId)?selectedId:'';status.textContent=heads.length?'':'还没有工作流方案';}
        })().catch(error=>{loadError=error;if(alive){status.textContent='工作流读取失败，请重试';if(retry)retry.hidden=false;}}).finally(()=>{pending=null;if(alive)select.disabled=Boolean(loadError);});
        return pending;
      };
      select.addEventListener('change',()=>{changed=true;selectedId=select.value;selected=heads.find(row=>row.id===selectedId)||null;status.textContent='';});
      retry?.addEventListener('click',()=>void load());
      let result,releaseAppearance,loading;
      try{
        const popup=new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'选用',cancelButton:'取消'});popup.dlg?.classList.add('sd-comfy-route-dialog');
        const shown=popup.show();
        try{if(popup.dlg?.isConnected)releaseAppearance=mountAppearance?.(popup.dlg);}catch(_){console.warn('[千幕] 工作流选择面板外观未接入，保留原样式');}
        loading=load();result=await shown;
        if(result)await (pending||loading);
      }finally{alive=false;try{releaseAppearance?.();}catch(_){console.warn('[千幕] 工作流选择面板外观清理失败');}}
      if(!result)return null;await guard();
      if(loadError){message='工作流读取失败，请重试';continue;}
      selectedId=select.value;const head=heads.find(row=>row.id===selectedId);
      if(!head){message='请选择工作流';continue;}
      if(changed||!selected||selected.id!==head.id)selected=head;
      useReferences=hasReferences&&wrap.querySelector('[data-comfy-route-references]')?.checked===true;
      const recipe=await pinComfyRouteWorkflow({namespace,selection:selected,guard,createStore});await guard();
      return {recipe,roles:false,useReferences};
    }
  }finally{store.close();}
}
