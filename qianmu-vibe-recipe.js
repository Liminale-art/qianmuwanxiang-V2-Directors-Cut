// Bounded source metadata only. A URL is not an immutable content receipt.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const id=value=>text(value,160)&&Boolean(value.trim());
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
const fail=message=>Object.assign(new Error(message),{code:'storyboard_vibe_recipe',submissionState:'not_submitted'});
function source(value){
  if(!text(value,4096)||!value.trim()||value!==value.trim()||/[\\]/.test(value))return '';
  if(/^(?:\/|\.\/|user\/|characters\/|images\/)/.test(value)&&!value.startsWith('//'))return value;
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?value:'';}catch(_){return '';}
}
const amount=(value,fallback)=>{const number=Number(value);return value!==''&&value!=null&&Number.isFinite(number)?Math.max(0,Math.min(1,number)):fallback;};
export function retainStoryboardVibeRecipe(value){
  if(!keys(value,['version','items'])||value.version!==1||!Array.isArray(value.items)||value.items.length>16)return {version:1,invalid:true};
  const seen=new Set(),items=[];
  for(const row of value.items){
    if(!keys(row,['id','name','previewUrl','strength','information'])||!id(row.id)||seen.has(row.id)||!text(row.name,100)||!source(row.previewUrl)
      ||![row.strength,row.information].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1))return {version:1,invalid:true};
    seen.add(row.id);items.push({id:row.id,name:row.name,previewUrl:row.previewUrl,strength:row.strength,information:row.information});
  }
  return {version:1,items};
}
export function captureStoryboardVibeRecipe(selectedIds,library){
  if(!Array.isArray(selectedIds)||selectedIds.length>16||!Array.isArray(library))throw fail('Vibe 选择无效，请重新选择');
  const recipe=retainStoryboardVibeRecipe({version:1,items:selectedIds.map(id=>{
    const row=library.find(item=>item?.id===id);return row?{id:row.id,name:row.name||'Vibe',previewUrl:row.previewUrl,
      strength:amount(row.strength,.6),information:amount(row.informationExtracted,1)}:null;
  })});
  if(recipe.invalid)throw fail('所选 Vibe 缺失或图源不可保存，请重新选择或上传');
  return recipe;
}
export function resolveStoryboardVibeRecipe(payload){
  const selected=payload?.selectedVibeIds??[];
  if(!Array.isArray(selected)||selected.length>16||selected.some(value=>!id(value))||new Set(selected).size!==selected.length)throw fail('Vibe 选择无效，请重新选择');
  if(!Object.hasOwn(payload||{},'vibeRecipe')){
    if(selected.length)throw fail('旧图未保存原 Vibe 配置，请在镜头台重新选择 Vibe 后生成');
    return [];
  }
  const recipe=retainStoryboardVibeRecipe(payload.vibeRecipe);
  if(recipe.invalid||JSON.stringify(recipe.items.map(row=>row.id))!==JSON.stringify(selected))throw fail('Vibe 原配方无效或选择已变化，请重新选择');
  return recipe.items;
}
