// Pure, request-scoped style selection. This is not narrative planning, model
// execution, persistence, or permission to alter a Comfy graph or image budget.
export const ENSEMBLE_LIBRARY_SCHEMA='qianmu.ensemble.library.v1';
export const ENSEMBLE_SELECTION_SCHEMA='qianmu.ensemble.chat-selection.v1';
export const ENSEMBLE_CURRENT_STYLE='current';
export const ENSEMBLE_SCHEME_LIMIT=128;
export const ENSEMBLE_ACTIVE_LIMIT=32;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_style_selection',submissionState:'not_submitted'});};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const id=(value,label)=>{if(typeof value!=='string'||!/^[A-Za-z0-9_.-]{1,160}$/.test(value))fail(`${label}无效`);return value;};
const text=(value,max,label,empty=false)=>{if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label}无效`);return value.trim();};
const namespace=value=>{const result=text(value,512,'账户');if(!/^st-user:\S/.test(result)||result!==value)fail('账户无效');return result;};
const flag=(value,otherwise=false)=>{if(value===undefined)return otherwise;if(typeof value!=='boolean')fail('方案开关无效');return value;};
const unique=(values,max,read,label)=>{if(!Array.isArray(values)||values.length>max)fail(`${label}数量无效`);const result=values.map(read);if(new Set(result).size!==result.length)fail(`${label}重复`);return result;};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function normalizeEnsembleLibrary(value){
  if(!object(value)||value.schema!==ENSEMBLE_LIBRARY_SCHEMA||!Array.isArray(value.schemes)||value.schemes.length>ENSEMBLE_SCHEME_LIMIT)fail('风格方案库无效');
  const owner=namespace(value.namespace),seen=new Set();
  const schemes=value.schemes.map(raw=>{
    if(!object(raw)||!object(raw.binding))fail('风格方案条目无效');
    const key=id(raw.id,'方案');if(key===ENSEMBLE_CURRENT_STYLE||seen.has(key))fail('风格方案编号重复或保留');seen.add(key);
    return {id:key,revision:id(raw.revision,'方案版本'),name:text(raw.name,80,'风格名'),description:text(raw.description??'',800,'适用说明',true),
      tags:unique(raw.tags??[],24,value=>text(value,80,'风格标签'),'风格标签'),archived:flag(raw.archived),
      // References only: the execution host must resolve and pin today's actual
      // route/artist configuration before offering it to this contract.
      binding:{routeId:id(raw.binding.routeId,'已存线路'),artistPresetId:raw.binding.artistPresetId? id(raw.binding.artistPresetId,'画师方案'):''}};
  });
  return {schema:ENSEMBLE_LIBRARY_SCHEMA,namespace:owner,schemes};
}
export function normalizeEnsembleChatSelection(value,{namespace:owner,chatKey}={}){
  if(!object(value)||value.schema!==ENSEMBLE_SELECTION_SCHEMA||namespace(value.namespace)!==namespace(owner)
    ||text(value.chatKey,1024,'聊天')!==text(chatKey,1024,'当前聊天'))fail('镜组选择不属于当前聊天');
  return {schema:ENSEMBLE_SELECTION_SCHEMA,namespace:owner,chatKey,revision:id(value.revision,'选择版本'),enabled:flag(value.enabled),
    schemeIds:unique(value.schemeIds??[],ENSEMBLE_ACTIVE_LIMIT,value=>{const key=id(value,'启用方案');if(key===ENSEMBLE_CURRENT_STYLE)fail('当前方案不应重复保存');return key;},'启用方案'),
    styleLock:flag(value.styleLock,true)};
}
function proof(value,{namespace:owner,chatKey,preparationId,revision}){
  return object(value)&&value.ready===true&&value.namespace===owner&&value.chatKey===chatKey&&value.preparationId===preparationId
    &&value.revision===revision&&hash(value.bindingKey)&&Array.isArray(value.promptFormats)&&value.promptFormats.length>0
    &&value.promptFormats.length<=2&&new Set(value.promptFormats).size===value.promptFormats.length
    &&value.promptFormats.every(format=>['tags','natural_language'].includes(format));
}

export function createEnsembleStyleSession({library,selection,namespace:owner,chatKey,preparationId,eligibility,base,guard}={}){
  owner=namespace(owner);chatKey=text(chatKey,1024,'当前聊天');preparationId=id(preparationId,'本次准备');
  if(typeof guard!=='function'||!(eligibility instanceof Map))fail('缺少当前风格技术核对');
  const read=()=>{
    const lib=normalizeEnsembleLibrary(library),choice=normalizeEnsembleChatSelection(selection,{namespace:owner,chatKey});
    if(lib.namespace!==owner)fail('方案库属于另一账户');
    if(!proof(base,{namespace:owner,chatKey,preparationId,revision:base?.revision}))fail('当前方案未通过本次技术核对');
    id(base.revision,'当前方案版本');
    const byId=new Map(lib.schemes.map(row=>[row.id,row])),entries=[],excluded=[];
    if(choice.enabled)for(const key of choice.schemeIds){
      const row=byId.get(key),check=eligibility.get(key);
      if(!row||row.archived){excluded.push({id:key,reason:row?'archived':'missing'});continue;}
      if(!proof(check,{namespace:owner,chatKey,preparationId,revision:row.revision})){excluded.push({id:key,reason:'technical_gate'});continue;}
      entries.push({scheme:row,proof:{bindingKey:check.bindingKey,promptFormats:[...check.promptFormats]}});
    }
    return {choice,entries,excluded,base:{revision:base.revision,bindingKey:base.bindingKey,promptFormats:[...base.promptFormats]}};
  };
  const captured=freeze(read()),identity=JSON.stringify(captured);
  const assertCurrent=()=>{
    const result=guard();
    if(result&&typeof result.then==='function'){void Promise.resolve(result).catch(()=>{});fail('风格选择需要同步的来源断言');}
    if(result===false)fail('风格选择来源已失效');
    if(JSON.stringify(read())!==identity)fail('风格方案、启用集合或技术核对已变化');
  };
  assertCurrent();
  const catalogue=freeze([{id:ENSEMBLE_CURRENT_STYLE,name:'当前方案',description:'未明确受益于其他风格时使用当前方案',tags:[]},
    ...captured.entries.map(({scheme})=>({id:scheme.id,name:scheme.name,description:scheme.description,tags:scheme.tags}))]);
  const available=new Map(captured.entries.map(row=>[row.scheme.id,{revision:row.scheme.revision,bindingKey:row.proof.bindingKey}]));
  available.set(ENSEMBLE_CURRENT_STYLE,{revision:captured.base.revision,bindingKey:captured.base.bindingKey});
  const normalizeShots=values=>unique(values,20,value=>id(value,'镜头'),'镜头');
  function responseSchema(shotIds){
    assertCurrent();const shots=normalizeShots(shotIds);
    return {type:'array',minItems:shots.length,maxItems:shots.length,items:{type:'object',additionalProperties:false,
      required:['shot_id','scheme_id','reason'],properties:{shot_id:{type:'string',enum:shots},scheme_id:{type:'string',enum:catalogue.map(row=>row.id)},reason:{type:'string',maxLength:600}}}};
  }
  function resolve(rows,shotIds){
    assertCurrent();const shots=normalizeShots(shotIds),byShot=new Map();
    if(!Array.isArray(rows)||rows.length!==shots.length)fail('风格选择不能增加或减少镜头');
    for(const row of rows){
      if(!object(row)||Object.keys(row).some(key=>!['shot_id','scheme_id','reason'].includes(key))||Object.keys(row).length!==3
        ||!shots.includes(row.shot_id)||byShot.has(row.shot_id)||!available.has(row.scheme_id))fail('风格选择包含未知、重复或未启用项');
      const reason=text(row.reason,600,'选择理由',true);if(row.scheme_id!==ENSEMBLE_CURRENT_STYLE&&!reason)fail('切换风格需说明叙事表现增益');
      byShot.set(row.shot_id,{shotId:row.shot_id,schemeId:row.scheme_id,...available.get(row.scheme_id),reason});
    }
    assertCurrent();return freeze({version:1,namespace:owner,chatKey,preparationId,selectionRevision:captured.choice.revision,
      executionAuthorized:false,assignments:shots.map(key=>byShot.get(key))});
  }
  return Object.freeze({catalogue,excluded:captured.excluded,styleLock:captured.choice.styleLock,assertCurrent,responseSchema,resolve,
    promptFormats:freeze([...new Set([...captured.base.promptFormats,...captured.entries.flatMap(row=>row.proof.promptFormats)])]),
    enabled:captured.choice.enabled&&captured.entries.length>0});
}
