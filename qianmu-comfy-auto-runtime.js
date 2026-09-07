// Request-scoped candidate preparation. No provider submission, workflow edits, permanent locks or LLM calls.
import { createComfyPoolStore } from './qianmu-comfy-pool-store.js';
import { normalizeComfyAutoPool, selectComfyWorkflow, comfyCandidateExecutionKey, comfySelectionRequestKey } from './qianmu-comfy-selection.js';
import { normalizeComfyClassification, COMFY_CLASSIFICATION_VALUES } from './qianmu-comfy-classification.js';
import { normalizeComfyAutoBinding, comfyAutoError } from './qianmu-comfy-auto-binding.js';
import { assertComfyRouteNamespace, normalizeComfyRouteSelection, comfyRouteBindingKey } from './qianmu-comfy-route-contract.js';
import { readPinnedComfyRouteWorkflow, applyComfyRouteRecipe } from './qianmu-comfy-route.js';
import { normalizeStoryboardShotSpec, sanitizeStoryboardDiagnosticData } from './qianmu-storyboard.js';
import { normalizeStoryboardPromptFormats, resolveStoryboardPromptRendering } from './qianmu-prompt-formats.js';

export const COMFY_AUTO_PREPARATION_BYTES=8*1024*1024;
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=message=>{throw comfyAutoError(message);};
const message=(error,fallback)=>String(sanitizeStoryboardDiagnosticData(String(error?.message || fallback).slice(0,2000))).slice(0,180);
async function hash(pool) {
  if (!globalThis.crypto?.subtle) fail('请使用 HTTPS 或本机地址核对候选方案');
  const bytes=new TextEncoder().encode(JSON.stringify(pool));
  if(bytes.byteLength>256*1024)fail('候选方案过大，请拆分后选择');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function readPool({namespace,selection,guard=async()=>{},createStore=createComfyPoolStore}, expected=null) {
  namespace=assertComfyRouteNamespace(namespace);selection=normalizeComfyRouteSelection(selection);
  await guard();const store=createStore();
  try {
    const [heads,versions,value]=await Promise.all([store.list(namespace),store.versions(namespace,selection.id),store.load(namespace,selection.id,selection.revision)]);await guard();
    const active=rows=>rows.some(row=>row.namespace===namespace && row.id===selection.id && row.archived===false);
    const version=versions.find(row=>row.namespace===namespace && row.id===selection.id && row.revision===selection.revision && row.version===selection.version);
    if(!active(heads)||!version||!value||value.id!==selection.id||value.revision!==selection.revision||value.version!==selection.version) fail('所选候选方案版本已不存在或已归档，请重新选择');
    const pool=normalizeComfyAutoPool(value.pool);
    if(pool.namespace!==namespace||pool.id!==selection.id||pool.revision!==selection.revision)fail('候选方案正文与所选版本不符');
    const poolHash=await hash(pool);await guard();
    const binding=normalizeComfyAutoBinding({schemaVersion:1,namespace,...selection,name:version.name,poolHash});
    if(expected && (expected.namespace!==namespace||expected.poolHash!==poolHash))fail('候选方案内容与原选定版本不符，请重新选择');
    if(!active(await store.list(namespace)))fail('候选方案已变化，请重新选择');await guard();
    return freeze({binding:expected || binding,pool});
  } finally {store.close();}
}
export function pinComfyAutoPool(options) {return readPool(options);}
export async function readPinnedComfyAutoPool({binding,...options}) {
  const captured=normalizeComfyAutoBinding(binding);
  if(captured.namespace!==options.namespace)fail('候选方案属于另一账户，请重新选择');
  return readPool({...options,selection:captured},captured);
}

export async function prepareComfyAutoSession({binding,namespace,guard=async()=>{},createStore,readRecipe=readPinnedComfyRouteWorkflow,
  maxBytes=COMFY_AUTO_PREPARATION_BYTES}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>COMFY_AUTO_PREPARATION_BYTES)fail('候选工作流准备额度无效');
  let closed=false;const current=async()=>{if(closed)fail('候选准备已结束');await guard();if(closed)fail('候选准备已结束');};
  const chosen=await readPinnedComfyAutoPool({binding,namespace,guard:current,createStore});
  const pool=copy(chosen.pool),recipes=new Map(),candidates=new Map(),issues=[];let usedBytes=0;
  // The caller requested a selection session, not global auto-generation. Selection outcomes remain unauthorized.
  pool.enabled=true;
  try {
    for(const candidate of pool.candidates.filter(row=>row.enabled)) {
      const key=comfyRouteBindingKey(candidate.target.comfyWorkflowBinding);
      try {
        let recipe=recipes.get(key);
        if(!recipe){recipe=await readRecipe({namespace,binding:candidate.target.comfyWorkflowBinding,guard:current});await current();}
        const declared=normalizeComfyClassification(recipe.document.classification || {version:1});
        if(JSON.stringify(declared)!==JSON.stringify(candidate.classification))fail('分类与固定工作流版本不符');
        if(!declared.promptFormat||!declared.contentClasses.length)fail('工作流缺少内容范围或提示格式声明');
        applyComfyRouteRecipe({},candidate.target,recipe);
        // Rejected declarations must not consume the retained-document budget of valid candidates.
        if(!recipes.has(key)){
          const size=new TextEncoder().encode(JSON.stringify(recipe.document)).byteLength;
          if(usedBytes+size>maxBytes)throw Object.assign(comfyAutoError('参与候选的工作流合计超过 8 MB，请拆分方案'),{code:'comfy_auto_capacity'});
          usedBytes+=size;recipes.set(key,freeze(recipe));
        }
        candidates.set(candidate.id,{candidate,recipe,executionKey:await comfyCandidateExecutionKey(candidate)});await current();
      }catch(error){
        await current();if(error.code==='comfy_auto_capacity')throw error;
        issues.push({candidateId:candidate.id,reason:'recipe_unavailable',message:message(error,'候选配置不可用')});
      }
    }
    if(!candidates.size)fail('没有可用的参与候选，请核对版本和分类');
    // Release documents referenced only by rejected candidates; never keep a cross-request workflow cache.
    const used=new Set([...candidates.values()].map(row=>comfyRouteBindingKey(row.candidate.target.comfyWorkflowBinding)));
    for(const key of recipes.keys())if(!used.has(key))recipes.delete(key);
    const promptFormats=freeze(normalizeStoryboardPromptFormats([...new Set([...candidates.values()].map(row=>row.candidate.classification.promptFormat))]));
    const preparationId=crypto.randomUUID();await current();
    return Object.freeze({binding:chosen.binding,promptFormats,issues:freeze(issues),preparationId,executionAuthorized:false,
      async select({shotSpec,scope=null,lock=null,adultAllowed=false,probe}={}) {
        if(typeof probe!=='function')fail('缺少逐镜技术检查');
        if(shotSpec?.schema!=='qianmu.storyboard.plan.v1'||!Array.isArray(shotSpec.characters)||shotSpec.characters.length>12||typeof shotSpec.sensitive!=='boolean')fail('此镜缺少完整取景事实，请先提取');
        const source=JSON.stringify([shotSpec,scope,lock]),shot=normalizeStoryboardShotSpec(shotSpec),capturedScope=scope ? copy(scope):null,capturedLock=lock?copy(lock):null;
        const live=async()=>{await current();if(source!==JSON.stringify([shotSpec,scope,lock]))fail('本镜事实或续场范围已变化，请重新准备');};
        const requirements={version:1,visualKind:COMFY_CLASSIFICATION_VALUES.visualKinds.includes(shot.subjectKind)?shot.subjectKind:'unknown',
          visibleSubjects:shot.characters.length,subjectIds:shot.characters.map(row=>row.id),narrativeLayer:shot.narrativeLayer,
          contentClass:shot.sensitive?'adult':'sfw',promptFormats};
        const requestKey=await comfySelectionRequestKey(requirements,capturedScope,namespace),eligibility=new Map();await live();
        const diagnostics=[...issues];
        const choose=()=>selectComfyWorkflow({pool,namespace,requirements,eligibility,preparationId,scope:capturedScope,lock:capturedLock,adultAllowed:adultAllowed===true});
        const preliminary=await choose();await live();
        if(['lock_pool_changed','lock_scope_mismatch','scene_layer_mismatch','content_unknown','content_not_authorized'].includes(preliminary.reason))return freeze({...preliminary,preparationId,requestKey,diagnostics});
        for(const {candidate,recipe,executionKey} of candidates.values()) {
          if(pool.styleLock && capturedLock && candidate.id!==capturedLock.candidateId)continue;
          const classification=candidate.classification;
          if(shot.sensitive && adultAllowed!==true || !classification.contentClasses.includes(requirements.contentClass)
            || classification.maxSubjects!==null && shot.characters.length>classification.maxSubjects)continue;
          try {
            await resolveStoryboardPromptRendering(shot,shot.promptRenderingPack,classification.promptFormat,{guard:live});
            const result=await probe({candidate:freeze(copy(candidate)),recipe,shot:freeze(copy(shot)),guard:live});await live();
            const automaticEligible=result?.automaticEligible===true;
            eligibility.set(candidate.id,{preparationId,requestKey,executionKey,automaticEligible});
            if(!automaticEligible)diagnostics.push({candidateId:candidate.id,reason:'technical_gate',message:'当前镜头未通过技术检查'});
          }catch(error){await live();diagnostics.push({candidateId:candidate.id,reason:error.code==='storyboard_prompt_format'?'prompt_format_unavailable':'technical_gate',message:message(error,'当前镜头未通过技术检查')});}
        }
        const result=await choose();await live();
        return freeze({...result,preparationId,requestKey,diagnostics});
      },
      apply(target,base){if(closed)fail('候选准备已结束');const recipe=recipes.get(comfyRouteBindingKey(target.comfyWorkflowBinding));return applyComfyRouteRecipe(base,target,recipe);},
      assertCurrent:current,
      close(){closed=true;recipes.clear();candidates.clear();},
    });
  }catch(error){closed=true;recipes.clear();candidates.clear();throw error;}
}
