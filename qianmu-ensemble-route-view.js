const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

export function ensembleRouteTargets(state,{providers,resolveBinding,getCapabilities}){
  return state.routing.rules.map(row=>{
    const route=row.target||{};let available=row.enabled!==false,artistCapable=false;
    try{const binding=resolveBinding(route.providerId,{model:route.modelId,capabilityModelId:route.capabilityModelId});
      const group=state.connections[route.providerId],matches=route.connectionPresetId?group.presets.filter(item=>item.id===route.connectionPresetId):[group.draft];
      available&&=matches.length===1;
      artistCapable=getCapabilities(route.providerId,binding.capabilityModelId,undefined,matches[0]).supportsArtistSyntax;
      if(route.providerId==='comfy')available&&=Boolean(route.comfyWorkflowBinding&&!route.comfyWorkflowBinding.invalid);
    }catch(_){available=false;}
    return {id:row.id,name:row.name,providerLabel:providers[route.providerId]?.label||route.providerId,available,artistCapable};
  });
}

export function renderEnsembleRoutePanel(state,{targetOptions,shotTypes,templates,policy}){
  const routing=state.routing,legacy=routing.enabled&&routing.styleLibrary!==true;
  const rows=routing.rules.map(rule=>`<article class="sd-storyboard-route-rule" data-storyboard-route-rule="${escape(rule.id)}"><div><input class="text_pole sd-storyboard-route-name" aria-label="线路名称" value="${escape(rule.name||'')}" placeholder="线路名称">${legacy?`<select class="text_pole sd-storyboard-route-type"><option value="">所有镜头</option>${Object.entries(shotTypes).map(([id,label])=>`<option value="${id}" ${rule.shotTypes?.[0]===id?'selected':''}>${label}</option>`).join('')}</select>`:''}<button type="button" class="sd-icon-btn sd-danger sd-storyboard-delete-route" title="删除线路" aria-label="删除线路"><i class="fa-solid fa-trash-can"></i></button></div><div class="sd-storyboard-route-target">${targetOptions(rule.target)}</div><label class="sd-switch-row"><span>线路可用</span><input type="checkbox" class="sd-storyboard-route-enabled" ${rule.enabled!==false?'checked':''}></label></article>`).join('');
  return `<div class="sd-storyboard-routing"><section class="sd-card"><div class="sd-ensemble-library-host" role="region" aria-label="镜组风格方案"></div></section>${legacy?'<p class="sd-storyboard-safety-notice">当前保留原镜组分工。启用上方「本聊天镜组」后使用风格方案，原线路与历史任务不会删除。</p>':''}<details class="sd-card" data-storyboard-card="routing-rules" ${state.collapsedCards['routing-rules']?'':'open'}><summary><span><b>${legacy?'原镜组配置':'绘制线路'}</b><small>${routing.rules.length?`${routing.rules.length} 条`:'为风格方案绑定模型'}</small></span></summary><div class="sd-storyboard-card-body"><p class="sd-storyboard-safety-notice">受限制模型会适配为安全但叙事一致的画面，不在生成结果下重复提示。</p>${legacy?`<label class="sd-switch-row"><span>保留原分工</span><input type="checkbox" class="sd-storyboard-routing-enabled" checked></label><label><span>原镜组模板</span><select class="text_pole sd-storyboard-route-template">${Object.values(templates).map(row=>`<option value="${row.id}" ${routing.templateId===row.id?'selected':''}>${row.label}</option>`).join('')}</select></label>`:''}<div class="sd-storyboard-route-rules">${rows||'<p class="sd-storyboard-empty-inline">添加绘制线路后，可在风格方案中选择；未启用镜组时仍使用镜头台当前模型。</p>'}</div><button type="button" class="sd-btn sd-primary sd-storyboard-add-route"><i class="fa-solid fa-plus"></i>添加绘制线路</button><small>Comfy 风格需绑定固定工作流；镜头数量与同时生成数沿用镜头台（${policy.minImages}～${policy.maxImages} 张，同时 ${policy.concurrency}）。</small><label class="sd-switch-row"><span>手动生成多镜头前确认</span><input type="checkbox" class="sd-storyboard-route-confirm" ${routing.confirmMultipleRequests!==false?'checked':''}></label></div></details></div>`;
}
