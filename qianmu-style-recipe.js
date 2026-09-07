import {resolveStoryboardJobModelIdentity,getStoryboardCapabilities} from './qianmu-storyboard.js';
import {retainStoryboardArtistPromptLayer,resolveStoryboardArtistPromptBase} from './qianmu-artist-prompt-layer.js';
import {resolveStoryboardVibeRecipe} from './qianmu-vibe-recipe.js';

const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const fail=message=>Object.assign(new Error(message),{code:'storyboard_style_recipe'});
const trim=value=>String(value??'').trim();
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const begins=(value,prefix)=>!prefix||value===prefix||value.startsWith(prefix+', ');

export function readStoryboardStyleRecipe(snapshot,record={}){
  const model=resolveStoryboardJobModelIdentity(snapshot);
  if(model.modelFamily!=='novel'||!getStoryboardCapabilities('novel',model.capabilityModelId,undefined,snapshot.connection).supportsArtistSyntax)throw fail('仅支持 NAI 原生画面风格配置');
  const payload=snapshot.payload||{},warnings=[];
  const prompt=trim(record.finalPrompt||payload.prompt||snapshot.prompt),negative=trim(payload.negative??snapshot.negative);
  const rawArtist=Object.hasOwn(payload,'artistString')?payload.artistString:snapshot.artistString;
  const artist=text(rawArtist,6000)&&begins(prompt,rawArtist.trim())?rawArtist.trim():null;
  let positive=null,excluded=null;
  const layer=retainStoryboardArtistPromptLayer(payload.artistPromptLayer);
  try{
    if(!layer.invalid&&!resolveStoryboardArtistPromptBase(layer,prompt,negative).needsReview){
      if(artist!==null&&begins(layer.positivePrefix,artist))positive=artist?layer.positivePrefix===artist?'':layer.positivePrefix.slice(artist.length+2):layer.positivePrefix;
      excluded=layer.negativePrefix;
    }
  }catch(_){/* A partial historic recipe cannot authorize reconstructing unknown text. */}
  if(positive!==null&&!text(positive,12000))positive=null;
  let vibes=null;
  try{if(!Object.hasOwn(payload,'selectedVibeIds'))throw fail('missing');vibes=resolveStoryboardVibeRecipe(payload);}catch(_){warnings.push('原 Vibe 配置缺失或无效，不套用当前库里的替代项。');}
  if(artist===null||positive===null||excluded===null)warnings.push('原风格层不完整，仅可套用下方可确认的部分。');
  return {version:1,artist,positive,negative:excluded,vibes,warnings};
}

export function storyboardStyleChoices(recipe,target){
  if(!target?.capabilities?.supportsArtistSyntax)throw fail('请先在镜头台选择支持画师语法的 NAI 模型');
  const fields={},warnings=[...recipe.warnings];
  const baked=Boolean(target.baked);
  for(const name of ['artist','positive','negative'])fields[name]=recipe[name]!==null&&!baked;
  fields.vibes=recipe.vibes!==null&&target.capabilities.supportsVibe
    &&!(recipe.vibes.length&&target.referenceEnabled);
  if(baked)warnings.push('当前提示含手写风格，需先在镜头台核对；这里不拆改当前画面提示。');
  if(recipe.vibes?.length&&!target.capabilities.supportsVibe)warnings.push('当前模型不支持 Vibe，保留当前隐藏选择。');
  if(recipe.vibes?.length&&target.referenceEnabled)warnings.push('Vibe 与当前角色精确参考冲突；保留参考设置，不套用 Vibe。');
  return {fields,warnings};
}

export function renderStoryboardStyleReview(recipe,target,selection=null){
  const {fields,warnings}=storyboardStyleChoices(recipe,target);
  const rows=[['artist','画师串'],['positive','正面风格词'],['negative','负面风格词'],['vibes','Vibe']];
  return `<section class="sd-world-shot-dialog sd-style-recipe-review"><h3>套用风格配置</h3><small>只替换勾选项，不更改场景、人物、模型、API 或种子，不立即生图。逐镜指定仍优先。</small><div class="sd-style-recipe-fields">${rows.map(([name,label])=>{
    const value=recipe[name];const display=value===null?'原配置未保存':name==='vibes'?value.length?value.map(item=>`${item.name} · 强度 ${item.strength} / 信息 ${item.information}`).join('\n'):'不使用 Vibe':value||'空（清除当前项）';
    return `<label><span><input type="checkbox" data-style-field="${name}" ${fields[name]?'':'disabled'} ${fields[name]&&(selection?selection[name]:true)?'checked':''}><b>${label}</b></span><pre>${escape(display)}</pre></label>`;
  }).join('')}</div>${warnings.map(message=>`<p role="note">${escape(message)}</p>`).join('')}</section>`;
}

export async function openStoryboardStyleReview(recipe,target,{context,guard=async()=>{}}={}){
  if(!context?.Popup||!context?.POPUP_TYPE)throw fail('当前 ST 不支持风格核对，请在镜头台手动设置');
  const allowed=storyboardStyleChoices(recipe,target).fields;
  if(!Object.values(allowed).some(Boolean))throw fail('没有可套用的配置，请先在镜头台核对模型或手写提示');
  await guard();const wrap=document.createElement('div');wrap.innerHTML=renderStoryboardStyleReview(recipe,target);
  const confirmed=await new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'套用所选',cancelButton:'取消'}).show();
  await guard();if(!confirmed)return null;
  const choice=Object.fromEntries(Object.keys(allowed).map(name=>[name,allowed[name]&&Boolean(wrap.querySelector(`[data-style-field=${name}]`)?.checked)]));
  return Object.values(choice).some(Boolean)?choice:null;
}

// Plan all changes before writing any state. Libraries are copied, never modified in place.
export function planStoryboardStyleApplication(state,recipe,target,choice,{uid,now=Date.now()}={}){
  const allowed=storyboardStyleChoices(recipe,target).fields;
  for(const name of ['artist','positive','negative','vibes'])if(choice[name]&&!allowed[name])throw fail('所选风格不再适用于当前模型或提示');
  const patch={},used=new Set([...state.artistPresets,...state.vibeLibrary].map(row=>row.id));
  const newId=prefix=>{const value=uid?.(prefix);if(typeof value!=='string'||!value||value.length>160||used.has(value)||!/^[\w.-]+$/.test(value))throw fail('无法创建独立配置，请重试');used.add(value);return value;};
  if(choice.artist||choice.positive||choice.negative){
    const artist=choice.artist?recipe.artist:target.artist,positive=choice.positive?recipe.positive:target.positive,negative=choice.negative?recipe.negative:target.negative;
    if(!text(artist,6000)||!text(positive,12000)||!text(negative,12000))throw fail('风格文字超出保存范围，请先核对');
    // Empty artist fields otherwise fall back to defaults; explicitly preserve chosen empty values.
    const defaults={...(state.promptDefaults[target.defaultsKey]||{})};
    if(!artist||positive==='')defaults.positive=positive;
    if(!artist||negative==='')defaults.negative=negative;
    patch.promptDefaults={...state.promptDefaults,[target.defaultsKey]:defaults};
    patch.selectedArtistPresetId='';patch.selectedArtistPoolId='';
    patch.promptDraft={...state.promptDraft,artistString:artist};
    if(artist){
      let saved=state.artistPresets.find(row=>trim(row.value)===artist&&trim(row.positivePrompt)===positive&&trim(row.negativePrompt)===negative);
      if(!saved){
        if(state.artistPresets.length>=200)throw fail('画师库已满，请先整理后套用');
        let name='图片风格',suffix=2;while(state.artistPresets.some(row=>row.name===name))name=`图片风格 ${suffix++}`;
        saved={id:newId('shotartist'),name,value:artist,positivePrompt:positive,negativePrompt:negative,previewUrl:'',note:'',tags:[],collectionIds:[],collectionId:'',createdAt:now,updatedAt:now};
        patch.artistPresets=[...state.artistPresets,saved];
      }
      patch.selectedArtistPresetId=saved.id;
    }
  }
  if(choice.vibes){
    const library=[...state.vibeLibrary],ids=[];
    for(const item of recipe.vibes){
      let saved=library.find(row=>!ids.includes(row.id)&&row.previewUrl===item.previewUrl&&row.strength===item.strength&&row.informationExtracted===item.information
        &&JSON.stringify(row.assetRef||null)===JSON.stringify(item.assetRef||null)
        &&(!row.providerIds?.length||row.providerIds.includes('novel'))&&(!row.modelIds?.length||row.modelIds.includes(target.modelId)));
      if(!saved){
        if(library.length>=500)throw fail('Vibe 库已满，请先整理后套用');
        saved={id:newId('shotvibe'),name:item.name,previewUrl:item.previewUrl,...(item.assetRef?{assetRef:{...item.assetRef}}:{}),strength:item.strength,informationExtracted:item.information,providerIds:['novel'],modelIds:[],assetId:'',tags:[],notes:'',createdAt:now,updatedAt:now};library.push(saved);
      }
      ids.push(saved.id);
    }
    if(new Set(ids).size!==ids.length)throw fail('原配方含重复 Vibe，请在镜头台确认后选择');
    patch.vibeLibrary=library;patch.selectedVibeIds=ids;
  }
  return patch;
}
