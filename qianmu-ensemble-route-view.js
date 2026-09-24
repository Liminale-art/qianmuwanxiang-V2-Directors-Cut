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

export function renderEnsembleRoutePanel(){
  return '<div class="sd-storyboard-routing"><section class="sd-card"><div class="sd-ensemble-library-host" role="region" aria-label="镜组风格方案"></div></section></div>';
}
