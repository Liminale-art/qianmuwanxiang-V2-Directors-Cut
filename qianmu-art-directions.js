// Program-owned visual defaults, not scene facts or an extra model request.
// These two renderings express the same intent; Comfy keeps its own workflow.
export const STORYBOARD_ART_DIRECTIONS=Object.freeze([
  Object.freeze({id:'anime',name:'千幕 · 动漫插画',
    tags:'anime illustration, expressive lineart, coherent cel shading, carefully painted textures',
    natural:'Render as a polished anime illustration, with expressive linework, coherent cel shading and carefully painted textures. Preserve the described composition, lighting, palette, identities and interactions.'}),
  Object.freeze({id:'cg',name:'千幕 · 艺术化 CG',
    tags:'stylized 3d, cinematic game art, detailed materials, physically based rendering, expressive character design',
    natural:'Render as stylized cinematic CG, with expressive character design, detailed materials and high-quality physically based rendering, like a next-generation game cinematic rather than an everyday photograph. Preserve the described composition, lighting, palette, identities and interactions.'}),
]);
export function retainStoryboardArtDirection(value){
  return value===''||STORYBOARD_ART_DIRECTIONS.some(row=>row.id===value)?value:'[invalid]';
}
export function storyboardArtDirectionDefaults(defaults,profile,source,{customArtist=false}={}){
  if(source==='comfy'||!Object.hasOwn(profile||{},'artDirection')||profile.artDirection==='')return defaults;
  const direction=STORYBOARD_ART_DIRECTIONS.find(row=>row.id===profile.artDirection);
  if(!direction)throw Error('内置画风不可用，请重新选择；未更换为其他画风');
  if(customArtist)return defaults;
  if(!['novel','banana','seedream','openai'].includes(source))throw Error('当前生图系列未支持内置画风');
  const prefix=source==='novel'?direction.tags:direction.natural;
  const positive=[prefix,defaults.positive].filter(Boolean).join(source==='novel'?', ':'\n\n');
  if(positive.length>12000)throw Error('画风与正面默认词合计超过12000字，请调整；未截断内容');
  return {...defaults,positive};
}
export function selectStoryboardArtDirection(state,profile,value){
  if(state.source==='comfy')throw Error('Comfy 画风由工作流控制');
  if(retainStoryboardArtDirection(value)==='[invalid]')throw Error('请选择有效的内置画风');
  profile.artDirection=value;
  // A non-NAI choice must not erase the remembered custom NAI artist.
  if(state.source==='novel'){
    state.selectedArtistPresetId='';state.selectedArtistPoolId='';state.promptDraft.artistString='';
    if(!state.promptDraft.userEditedCompiled)state.promptDraft.artistPositiveBaked=false;
    if(!state.promptDraft.userEditedNegative)state.promptDraft.artistNegativeBaked=false;
  }
}
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderStoryboardArtDirectionChoice(state,profile,capabilities){
  if(state.source==='comfy')return '';
  const artist=capabilities.supportsArtistSyntax;
  const selected=artist&&state.selectedArtistPoolId?'pool:'+state.selectedArtistPoolId:artist&&state.selectedArtistPresetId?'artist:'+state.selectedArtistPresetId:
    profile.artDirection?'direction:'+profile.artDirection:'';
  const option=(value,label)=>`<option value="${escape(value)}" ${selected===value?'selected':''}>${escape(label)}</option>`;
  const builtins=STORYBOARD_ART_DIRECTIONS.map(row=>option('direction:'+row.id,row.name)).join('');
  const invalid=profile.artDirection&&retainStoryboardArtDirection(profile.artDirection)==='[invalid]'?option('direction:'+profile.artDirection,'原画风不可用，请重新选择'):'';
  const pools=artist&&state.artistPools.length?`<optgroup label="画师方案">${state.artistPools.map(row=>option('pool:'+row.id,row.name)).join('')}</optgroup>`:'';
  const artists=artist&&state.artistPresets.length?`<optgroup label="画师串">${state.artistPresets.map(row=>option('artist:'+row.id,row.name)).join('')}</optgroup>`:'';
  const select=`<select class="text_pole sd-storyboard-art-choice${artist?' sd-storyboard-artist-preset':''}" aria-label="${artist?'画师串或内置画风':'内置画风'}">${option('',artist?'不附加画师或内置画风':'不附加内置画风')}${invalid}<optgroup label="千幕内置">${builtins}</optgroup>${pools}${artists}</select>`;
  return artist?`<div class="sd-storyboard-inline-control"><button type="button" class="sd-icon-btn sd-storyboard-open-artist-library" title="画师库" aria-label="画师库"><i class="fa-solid fa-images"></i></button>${select}<button type="button" class="sd-icon-btn sd-storyboard-edit-selected-artist" title="编辑当前画师设置" aria-label="编辑当前画师设置" ${state.selectedArtistPresetId||state.selectedArtistPoolId?'':'disabled'}><i class="fa-solid fa-pen"></i></button></div>`:`<label><span>内置画风</span>${select}</label>`;
}
