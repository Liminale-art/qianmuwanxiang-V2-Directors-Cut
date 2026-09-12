// Fresh generation only. Never apply this projection to archived jobs or retry payloads.
// This is not workflow validation: graph, reference and provenance checks still run afterwards.
const emptyLayer = () => ({positive:'',negative:''});
export function projectNewComfyExecution(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw Object.assign(new Error('Comfy 执行配置无效'),{code:'comfy_execution_profile'});
  }
  const projected=JSON.parse(JSON.stringify(profile));
  projected.comfyCharacterEnabled=false;
  delete projected.comfyCharacterActivation;
  // Keep the selected recipe identity intact; only its optional execution-time additions retire.
  if (projected.comfyRouteBinding != null || Object.hasOwn(projected,'comfyRoutePromptLayer')) {
    projected.comfyRoutePromptLayer=emptyLayer();
  }
  // Workbench defaults are outside the profile, so callers must also use this explicit empty layer.
  return {profile:projected,promptLayer:emptyLayer()};
}
