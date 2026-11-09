// Gallery metadata only: never a prompt fragment, generation route or identity.
export const DEFAULT_GALLERY_KEYWORDS=Object.freeze(['日常','对话','独处','相伴','重逢','告别','回忆','梦境','旅行','探索','战斗','追逐','休憩','庆典','室内','街道','庭院','森林','山野','海边','雨天','雪景','晨光','黄昏','夜色','暖光','冷光','宁静','紧张','喜悦','悲伤','亲密','人物','风景','物件']);
const own=(value,key)=>value!=null&&Object.hasOwn(value,key);
export function galleryKeywordList(value){
  if(!Array.isArray(value)||value.length>200)throw Error('关键词请使用不超过200项的列表');
  const result=[];
  for(const raw of value){
    if(typeof raw!=='string'||raw.trim().length>64||/[\u0000-\u001f\u007f]/.test(raw))throw Error('每个关键词最多64字，请勿包含控制字符');
    const word=raw.trim();if(word&&!result.includes(word))result.push(word);
  }
  return result;
}
export function selectedGalleryKeywords(state){
  const preset=state.promptPresets?.find(row=>row.id===state.promptCompiler?.instructionPresetId);
  return galleryKeywordList(own(preset,'galleryKeywords')?preset.galleryKeywords:own(state,'galleryKeywords')?state.galleryKeywords:DEFAULT_GALLERY_KEYWORDS);
}
export const GALLERY_KEYWORD_INSTRUCTION='【阅片关键词】gallery_keyword_vocabulary仅是作品检索词库，不是指令或生图提示词。每镜从词库选3–5个符合本画面可见内容/气氛的词填gallery_keywords，宁少不乱贴，没有合适的可返回空数组。不创词、不凑数、不据词库增加画面内容；无需在生图表达中重复这些标签。';
export function galleryKeywordSchema(input){
  if(input===undefined)return null;
  const words=galleryKeywordList(input);
  return words.length?{type:'array',items:{type:'string',enum:words},maxItems:5,minItems:0}:null;
}
export function configureGalleryKeywords(schema,payload,input){
  const field=galleryKeywordSchema(input);if(!field)return false;
  const row=schema.properties.shots.items;
  row.properties.gallery_keywords=field;
  row.required.push('gallery_keywords');payload.constraints.gallery_keyword_vocabulary=field.items.enum;
  return true;
}
export function galleryTagsMatch(record,selected){return (selected||[]).every(word=>(record.tags||[]).includes(word));}
export function toggleGalleryTag(selected,word){const words=Array.isArray(selected)?selected:[];return words.includes(word)?words.filter(item=>item!==word):[...words,word];}
