import {createEnsembleStorage} from './qianmu-ensemble-storage.js?v=1.59.338';
import {prepareEnsembleStyleBindings} from './qianmu-ensemble-bindings.js?v=1.59.338';
import {resolveStoryboardProfileBinding} from './qianmu-storyboard.js?v=1.59.338';

const copy=value=>JSON.parse(JSON.stringify(value));
const key=route=>{
  // Explicit capability IDs added by job creation must retain the same identity.
  // Keep remote aliases, presets and the complete fixed recipe/reference binding.
  let capability=route.capabilityModelId||'';
  try{capability=resolveStoryboardProfileBinding(route.providerId,{model:route.modelId,capabilityModelId:capability}).capabilityModelId;}catch(_){/* Invalid optional routes are excluded by binding validation. */}
  return JSON.stringify([route.providerId,route.modelId,capability,route.connectionPresetId||'',route.parameterPresetId||'',route.comfyWorkflowBinding,route.comfyCharacterEnabled===true,route.comfyReferences??null]);
};
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_host',submissionState:'not_submitted'});};

// Explicit new-library mode only. The old mode incurs no account-file reads.
// Each optional route owns its preparation: a broken workflow cannot discard
// another route's recipes or silently borrow the current Comfy workbench.
export async function prepareStoryboardEnsembleSession(state,inputGuard,d,{plan=null,automatic=false}={}){
  if(state.routing?.styleLibrary!==true)return null;
  const chatKey=String(d.getChatKey()||'');if(!chatKey)fail('镜组需要当前聊天');
  let closed=false,choices,bindings;const slots=new Map();
  const check=()=>{inputGuard.assertCurrent();if(closed||d.storyboardState()!==state||String(d.getChatKey()||'')!==chatKey)fail('镜组准备来源已变化');return true;};
  const identity=await d.featureRuntime.load('imageAdmission');check();
  const namespace=await identity.resolveImageAccountNamespace();check();
  const guard=async()=>{check();if(await identity.resolveImageAccountNamespace()!==namespace)fail('镜组准备账户已变化');check();return true;};
  const close=()=>{if(closed)return;closed=true;bindings?.close();choices?.close();for(const row of slots.values())row.input.comfyAuto?.close();};
  try{
    choices=await createEnsembleStorage({namespace,chatKey,isCurrent:check,resolveNamespace:identity.resolveImageAccountNamespace});
    const selection=await choices.readSelection();await guard();
    const library=selection.value.enabled?(await choices.readLibrary()).value:{schema:'qianmu.ensemble.library.v1',namespace,schemes:[]};await guard();
    const current=d.storyboardProviderProfile(state),base={providerId:state.source,modelId:current.model,capabilityModelId:current.capabilityModelId,connectionPresetId:'',parameterPresetId:''};
    async function prepare(route,required=false){
      const id=key(route);if(slots.has(id))return slots.get(id);
      const input=Object.create(inputGuard);input.comfyRoutes=null;input.comfyAuto=null;
      const row={route:copy(route),input,ready:false};slots.set(id,row);
      try{
        await d.storyboardPrepareComfyRoutes(state,input,[route]);await guard();
        if(route.providerId==='comfy'){
          const reports=await d.storyboardPreflightComfyForCompiler(state,current,plan,input,automatic,null,[route]);await guard();
          if(!(Array.isArray(reports)?reports:[reports]).some(report=>report?.localConfigurationReady===true))fail('工作流未通过绘制预检');
        }
        row.ready=true;
      }catch(error){await guard();input.comfyAuto?.close();input.comfyAuto=null;if(required)throw error;}
      return row;
    }
    const main=await prepare(base,true);
    if(selection.value.enabled)for(const id of selection.value.schemeIds){
      const scheme=library.schemes.find(row=>row.id===id&&!row.archived),routes=scheme?state.routing.rules.filter(row=>row.id===scheme.binding.routeId&&row.enabled!==false):[];
      if(routes.length===1)await prepare(routes[0].target);
    }
    const prepared={
      apply(route,profile){check();const row=slots.get(key(route));
        // Automatic Comfy candidates are frozen by the current workbench slot.
        if(!row&&main.input.comfyAuto?.candidates.some(item=>key(item.target)===key(route)))return main.input.comfyRoutes.apply(route,profile);
        if(!row?.ready||!row.input.comfyRoutes)fail('风格工作流未通过本次准备');return row.input.comfyRoutes.apply(route,profile);},
      get promptFormats(){return [...new Set([...slots.values()].filter(row=>row.ready).flatMap(row=>row.input.comfyRoutes?.promptFormats||[]))];},
      get candidates(){return main.input.comfyAuto?.candidates||[];},
      async assertCurrent(){await guard();for(const row of slots.values())if(row.ready)await row.input.comfyRoutes?.assertCurrent();await guard();},
    };
    bindings=await prepareEnsembleStyleBindings({library,selection:selection.value,namespace,chatKey,preparationId:d.uid('ensemble-preparation'),readState:()=>state,
      assertCurrent:check,guard,resolveProfile:({route})=>{if(!slots.get(key(route))?.ready)fail('此方案暂不可用');return d.storyboardResolveRoutingProfile(state,route,null,prepared);},
      verifyTarget:async descriptor=>{await guard();const row=slots.get(key(descriptor.route));return {ready:row?.ready===true,
        promptFormats:descriptor.profile.comfyRoutePromptFormat?[descriptor.profile.comfyRoutePromptFormat]:row?.input.comfyRoutes?.promptFormats||[]};},
    });await guard();
    inputGuard.comfyRoutes=prepared;inputGuard.comfyAuto=main.input.comfyAuto;
    const result=Object.freeze({session:bindings.session,useReference:bindings.useReference,unavailable:Object.freeze([...new Map([...bindings.session.excluded,...bindings.unavailable].map(row=>[row.id,row])).values()]),
      async assertCurrent(){await guard();await bindings.assertCurrent();await prepared.assertCurrent();},close});
    inputGuard.ensemble=result;return result;
  }catch(error){close();throw error;}
}
