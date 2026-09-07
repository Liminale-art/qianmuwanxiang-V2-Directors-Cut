// Lightweight settings/snapshot reference only. No database, image codec or worker at startup.
export const VIBE_ENCODING_MODELS=Object.freeze({
  'nai-diffusion-4-curated-preview':'v4curated','nai-diffusion-4-full':'v4full',
  'nai-diffusion-4-5-curated':'v4-5curated','nai-diffusion-4-5-full':'v4-5full',
});
export function retainVibeAssetRef(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(name=>!['version','namespace','id'].includes(name))
    ||value.version!==1||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)
    ||typeof value.namespace!=='string'||!/^st-user:.+/.test(value.namespace)||value.namespace.length>512||/[\u0000-\u001f\u007f]/.test(value.namespace))return {version:1,invalid:true};
  return {version:1,namespace:value.namespace,id:value.id};
}
