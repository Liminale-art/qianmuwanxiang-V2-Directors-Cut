// Named still-frame policies. Bindings carry their own policy so a standalone
// prompt-preset export never depends on a same-named library on another device.
export const DEFAULT_COMPOSITION_SCHEME='qianmu:composition-default';
const copy=value=>structuredClone(value);
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function normalizeCompositionScheme(value,normalize){
  if(!value||!text(value.id,100)||!text(value.name,80)||!value.policy||typeof value.policy!=='object')return null;
  const policy=normalize(value.policy);
  if(String(value.policy.ruleOverride||'').length>12000)return null;
  if(Object.keys(policy).some(key=>!equal(value.policy[key],policy[key])))return null;
  return {id:value.id,name:value.name.trim(),policy};
}
export function normalizeCompositionLibrary(value,normalize){
  const seen=new Set();return (Array.isArray(value)?value:[]).map(row=>normalizeCompositionScheme(row,normalize))
    .filter(row=>row&&row.id!==DEFAULT_COMPOSITION_SCHEME&&!seen.has(row.id)&&seen.add(row.id)).slice(0,100);
}
export function compositionScheme(state,id,normalize){
  if(id===DEFAULT_COMPOSITION_SCHEME)return {id,name:'千幕默认',policy:normalize({})};
  return normalizeCompositionScheme(state.compositionSchemes?.find(row=>row.id===id),normalize);
}
export function selectCompositionScheme(state,id,normalize){
  if(!id){state.compositionSchemeId='';return true;}
  const scheme=compositionScheme(state,id,normalize);if(!scheme)throw Error('构景方案不可用，请重新选择');
  state.compositionSchemeId=id;state.compositionPolicy=copy(scheme.policy);return true;
}
export function applyBoundComposition(state,preset,normalize){
  if(!preset?.compositionBinding)return false;
  const binding=normalizeCompositionScheme(preset.compositionBinding,normalize);if(!binding)throw Error('预设的构景绑定无效，未替换当前配置');
  state.compositionPolicy=copy(binding.policy);
  const local=compositionScheme(state,binding.id,normalize);
  state.compositionSchemeId=local&&equal(local.policy,binding.policy)?local.id:'';
  return true;
}
export function bindCurrentComposition(state,preset,enabled,normalize){
  if(!preset)throw Error('请先选择一个取景预设');
  if(!enabled){delete preset.compositionBinding;return;}
  const scheme=compositionScheme(state,state.compositionSchemeId,normalize);
  if(!scheme)throw Error('请先选择或保存一个构景方案');
  preset.compositionBinding={...scheme,policy:normalize(state.compositionPolicy)};
}
export function saveCompositionScheme(state,name,{id,createId,normalize}={}){
  if(!text(name,80))throw Error('方案名须为1–80字，不含控制字符');
  const previous=id?state.compositionSchemes?.find(row=>row.id===id):null;
  if(id&&!previous)throw Error('不能覆盖默认或已删除的方案');
  if(!previous&&(state.compositionSchemes?.length||0)>=100)throw Error('构景方案已达100项，请先整理');
  if(state.compositionSchemes?.some(row=>row.id!==id&&row.name===name.trim()))throw Error('已有同名构景方案');
  const next={id:previous?.id||createId(),name:name.trim(),policy:normalize(state.compositionPolicy)};
  if(!normalizeCompositionScheme(next,normalize)||next.id===DEFAULT_COMPOSITION_SCHEME)throw Error('构景方案标识无效');
  if(!previous&&state.compositionSchemes?.some(row=>row.id===next.id))throw Error('构景方案标识重复，未覆盖原方案');
  state.compositionSchemes=previous?state.compositionSchemes.map(row=>row.id===id?next:row):[...(state.compositionSchemes||[]),next];
  // An explicit save updates bindings to this exact local revision only. A
  // foreign imported binding with the same id keeps its own frozen contents.
  if(previous)for(const preset of state.promptPresets||[])if(equal(preset.compositionBinding,previous))preset.compositionBinding=copy(next);
  state.compositionSchemeId=next.id;return next;
}
export function deleteCompositionScheme(state,id){
  const old=state.compositionSchemes?.find(row=>row.id===id);if(!old)throw Error('该方案不可删除');
  state.compositionSchemes=state.compositionSchemes.filter(row=>row.id!==id);
  // Preserve active policy and preset snapshots; deleting the reusable library
  // entry is not permission to rewrite those configurations.
  if(state.compositionSchemeId===id)state.compositionSchemeId='';
}
export function updateCompositionPolicy(state,field,value,normalize){
  const next={...state.compositionPolicy};
  if(field==='allowedRatioIds'&&(!Array.isArray(value)||!value.length))throw Error('至少保留一种画幅');
  if(field==='ruleOverride'&&String(value).length>12000)throw Error('个人修订最多12000字，未截断内容');
  if(!['mode','fixedRatioId','allowedRatioIds','preferredRatioId','groupStrategy','ruleOverride'].includes(field))throw Error('未知构景设置');
  next[field]=value;if(field==='ruleOverride')next.userEdited=Boolean(value.trim());
  state.compositionPolicy=normalize(next);
}
export function importedCompositionPolicy(state,preset,legacy,normalize){
  const next={compositionPolicy:copy(state.compositionPolicy),compositionSchemeId:state.compositionSchemeId,compositionSchemes:state.compositionSchemes};
  if(legacy?.id==='qianmu:composition-law'){
    const rule=String(legacy.ruleOverride||'').trim();if(rule.length>12000)throw Error('导入的构景修订超过12000字，未截断');
    next.compositionPolicy=normalize({...next.compositionPolicy,ruleOverride:rule,userEdited:Boolean(rule)});next.compositionSchemeId='';
  }
  applyBoundComposition(next,preset,normalize);return {compositionPolicy:next.compositionPolicy,compositionSchemeId:next.compositionSchemeId};
}
