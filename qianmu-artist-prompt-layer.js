// Frozen syntax boundaries, not ownership of matching words elsewhere in a scene.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,limit)=>typeof value==='string'&&value.length<=limit&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export function retainStoryboardArtistPromptLayer(value){
  if(!object(value)||value.invalid||value.version!==1||Object.keys(value).some(key=>!['version','positivePrefix','negativePrefix'].includes(key))
    ||!text(value.positivePrefix,24000)||!text(value.negativePrefix,12000))return {version:1,invalid:true};
  return {version:1,positivePrefix:value.positivePrefix.trim(),negativePrefix:value.negativePrefix.trim()};
}
function removePrefix(value,prefix){
  if(!prefix)return value;
  if(value===prefix)return '';
  return value.startsWith(prefix+', ')?value.slice(prefix.length+2):null;
}
export function resolveStoryboardArtistPromptBase(layer,prompt,negative){
  if(!text(prompt,24000)||!text(negative,12000))throw new Error('原画面提示过长或无效，请在镜头台核对');
  const value=retainStoryboardArtistPromptLayer(layer),raw={prompt:prompt.trim(),negative:negative.trim()};
  if(value.invalid)return {...raw,needsReview:true,reason:layer==null?'missing':'invalid'};
  const positive=removePrefix(raw.prompt,value.positivePrefix),excluded=removePrefix(raw.negative,value.negativePrefix);
  if(positive===null||excluded===null)return {...raw,needsReview:true,reason:'edited'};
  return {prompt:positive,negative:excluded,needsReview:false};
}
export function captureStoryboardArtistPromptLayer({positivePrefix,negativePrefix,prompt,negative}){
  const layer=retainStoryboardArtistPromptLayer({version:1,positivePrefix,negativePrefix});
  try{return resolveStoryboardArtistPromptBase(layer,prompt,negative).needsReview?{version:1,invalid:true}:layer;}
  catch(_){return {version:1,invalid:true};}
}
