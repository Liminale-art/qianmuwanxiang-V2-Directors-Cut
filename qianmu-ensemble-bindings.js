import {createEnsembleStyleSession,normalizeEnsembleLibrary,normalizeEnsembleChatSelection,ENSEMBLE_CURRENT_STYLE} from './qianmu-ensemble-selection.js?v=1.59.313';
import {resolveStoryboardProfileBinding,resolveStoryboardConnectionBinding,getStoryboardCapabilities} from './qianmu-storyboard.js?v=1.59.313';
import {normalizeStoryboardPromptFormats,negotiateStoryboardPromptFormats} from './qianmu-prompt-formats.js';
import {comfyRouteBindingKey} from './qianmu-comfy-route-contract.js';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=(message,code='ensemble_binding')=>{throw Object.assign(Error(message),{code,submissionState:'not_submitted'});};
function synchronous(value){if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});fail('镜组配置读取须同步完成');}return value;}
function serialized(value){let result;try{result=JSON.stringify(value);}catch(_){fail('镜组绑定不能保存为快照');}if(typeof result!=='string'||new TextEncoder().encode(result).byteLength>2*1024*1024)fail('单个镜组绑定过大');return result;}
const copy=value=>JSON.parse(serialized(value));
async function digest(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}

// Read-only bridge between descriptive choices and the host's real profile
// resolver/preflight. No requests are submitted and no configuration is saved.
// Private snapshots never enter the LLM catalogue, receipt or public result.
// The host must still use its complete source guard and normal image admission.
export async function prepareEnsembleStyleBindings({library,selection,namespace,chatKey,preparationId,readState,resolveProfile,verifyTarget,assertCurrent,guard}={}){
  if([readState,resolveProfile,verifyTarget,assertCurrent,guard].some(fn=>typeof fn!=='function')||!globalThis.crypto?.subtle)fail('镜组执行核对环境不完整');
  let closed=false;const pinned=new Map(),eligibility=new Map(),issued=new WeakSet(),unavailable=[];
  const readChoices=()=>{
    const lib=normalizeEnsembleLibrary(library),choice=normalizeEnsembleChatSelection(selection,{namespace,chatKey});
    if(lib.namespace!==namespace)fail('镜组库账户不一致');
    const byId=new Map(lib.schemes.map(row=>[row.id,row]));
    return {choice,schemes:choice.enabled?choice.schemeIds.map(id=>byId.get(id)||{id,missing:true}):[]};
  };
  const original=readChoices(),choiceKey=serialized(original);
  const sync=()=>{
    if(closed||synchronous(assertCurrent())===false)fail('镜组来源已变化','ensemble_binding_changed');
    if(serialized(readChoices())!==choiceKey)fail('镜组启用集合或方案已变化','ensemble_binding_changed');
  };
  const check=async()=>{sync();if(await guard()===false)fail('镜组账户或来源已变化','ensemble_binding_changed');sync();};
  function capture(scheme){
    sync();const state=synchronous(readState());if(!object(state))fail('镜头台配置不可读取');
    const isBase=scheme.id===ENSEMBLE_CURRENT_STYLE;
    let route;
    if(isBase){const current=state.profiles?.[state.source];if(!object(current))fail('当前模型配置不存在');const binding=resolveStoryboardProfileBinding(state.source,current);route={providerId:state.source,modelId:binding.remoteModelId,capabilityModelId:binding.capabilityModelId,connectionPresetId:'',parameterPresetId:''};}
    else{
      const rows=state.routing?.rules?.filter(row=>row.id===scheme.binding.routeId)||[];
      if(rows.length!==1||!object(rows[0].target))fail('方案绑定的线路不存在或重复','ensemble_missing_route');
      if(rows[0].enabled===false)fail('方案绑定的线路已停用','ensemble_disabled_route');
      route=copy(rows[0].target);
    }
    if(typeof route.modelId!=='string'||!route.modelId.trim())fail('方案没有明确模型，不使用默认模型代替');
    const identity=resolveStoryboardProfileBinding(route.providerId,{model:route.modelId,capabilityModelId:route.capabilityModelId});
    const profile=synchronous(resolveProfile({state,route:copy(route),isBase}));if(!object(profile))fail('镜组绘制配置未完成核对');
    const actual=resolveStoryboardProfileBinding(route.providerId,profile);
    if(actual.remoteModelId!==identity.remoteModelId||actual.capabilityModelId!==identity.capabilityModelId)fail('方案模型与实际绘制配置不一致');
    if(route.providerId==='comfy'&&!isBase){
      if(!route.comfyWorkflowBinding||comfyRouteBindingKey(route.comfyWorkflowBinding)!==comfyRouteBindingKey(profile.comfyRouteBinding))fail('Comfy风格须绑定核对后的固定工作流，不能借用当前工作台');
      if(route.comfyWorkflowBinding.namespace!==namespace)fail('工作流属于另一账户');
    }
    const group=state.connections?.[route.providerId];
    const matched=route.connectionPresetId?group?.presets?.filter(row=>row.id===route.connectionPresetId):null;
    if(matched&&matched.length!==1)fail('方案API预设不存在或重复','ensemble_missing_connection');
    const connection=route.connectionPresetId?matched?.[0]:group?.draft||group?.presets?.find(row=>row.id===group.activePresetId);
    if(!object(connection))fail('方案API预设不存在，不改用其他连接','ensemble_missing_connection');
    const protocol=resolveStoryboardConnectionBinding(route.providerId,connection);
    const artistId=isBase?'':scheme.binding.artistPresetId;
    let artist=null;
    if(artistId){
      if(!getStoryboardCapabilities(route.providerId,identity.capabilityModelId,undefined,connection).supportsArtistSyntax)fail('当前方案模型不支持绑定的画师语法');
      const rows=state.artistPresets?.filter(row=>row.id===artistId)||[];
      if(rows.length!==1)fail('方案绑定的画师不存在或重复','ensemble_missing_artist');artist=rows[0];
    }
    return copy({route,identity,profile,connection,protocol,artist,...(isBase&&route.providerId==='comfy'&&state.comfyAutoEnabled===true?{automaticWorkflowSelection:state.comfyPoolSelection}: {})});
  }
  function assertPins(){sync();for(const {scheme,text} of pinned.values())if(serialized(capture(scheme))!==text)fail('方案模型、API、参数、画师或工作流已变化','ensemble_binding_changed');}
  await check();
  const baseScheme={id:ENSEMBLE_CURRENT_STYLE,revision:'current'};
  for(const scheme of [baseScheme,...original.schemes]){
    await check();
    if(scheme.missing||scheme.archived)continue;
    let descriptor,text;
    try{
      descriptor=freeze(capture(scheme));text=serialized(descriptor);
      const report=await verifyTarget(descriptor,{namespace,chatKey,preparationId,guard:check});await check();
      if(serialized(capture(scheme))!==text)fail('核对期间方案配置已变化','ensemble_binding_changed');
      if(!object(report)||report.ready!==true)fail('方案未通过实际绘制预检','ensemble_not_ready');
      const formats=descriptor.route.providerId==='comfy'?normalizeStoryboardPromptFormats(report.promptFormats):negotiateStoryboardPromptFormats([{providerId:descriptor.route.providerId}]).formats;
      if(!formats.length)fail('工作流尚未声明提示表达格式','ensemble_unknown_format');
      const total=[...pinned.values()].reduce((sum,item)=>sum+item.text.length,0)+text.length;
      if(total>8*1024*1024)fail('本次镜组绑定总量过大');
      const bindingKey=await digest(text);await check();
      if(serialized(capture(scheme))!==text)fail('冻结期间方案配置已变化','ensemble_binding_changed');
      const revision=scheme.id===ENSEMBLE_CURRENT_STYLE?'current-'+bindingKey:scheme.revision;
      const proof=freeze({namespace,chatKey,preparationId,revision,ready:true,bindingKey,promptFormats:formats});
      pinned.set(scheme.id,{scheme,descriptor,text,proof});if(scheme.id!==ENSEMBLE_CURRENT_STYLE)eligibility.set(scheme.id,proof);
    }catch(error){
      await check();
      if(error?.code==='ensemble_binding_changed'||scheme.id===ENSEMBLE_CURRENT_STYLE)throw error;
      // No raw provider errors/URLs/headers enter display metadata or the LLM.
      unavailable.push({id:scheme.id,reason:['ensemble_missing_route','ensemble_disabled_route','ensemble_missing_connection','ensemble_missing_artist','ensemble_unknown_format'].includes(error?.code)?error.code:'ensemble_not_ready'});
    }
  }
  await check();assertPins();
  const inner=createEnsembleStyleSession({library,selection,namespace,chatKey,preparationId,eligibility,base:pinned.get(ENSEMBLE_CURRENT_STYLE).proof,guard:assertPins});
  async function resolveAssignment(receipt,shotId){
      if(!issued.has(receipt))fail('不是本次模型选择的已核对结果');
      await check();inner.assertCurrent();
      const assignment=receipt.assignments.find(row=>row.shotId===shotId),record=assignment&&pinned.get(assignment.schemeId);
      if(!record||record.proof.bindingKey!==assignment.bindingKey||record.proof.revision!==assignment.revision)fail('此镜没有有效风格绑定');
      return freeze({shotId,schemeId:assignment.schemeId,bindingKey:assignment.bindingKey,route:copy(record.descriptor.route),
        artistPresetId:record.descriptor.artist?.id||'',executionAuthorized:false});
  }
  const session=Object.freeze({...inner,resolve(rows,shotIds){const result=inner.resolve(rows,shotIds);issued.add(result);return result;},resolveAssignment});
  return Object.freeze({session,unavailable:freeze(unavailable),executionAuthorized:false,resolveAssignment,
    useReference:[...pinned.values()].some(row=>row.descriptor.route.providerId==='novel'&&row.descriptor.profile.characterReferenceEnabled===true),
    async assertCurrent(){await check();inner.assertCurrent();},
    close(){closed=true;pinned.clear();eligibility.clear();},
  });
}
