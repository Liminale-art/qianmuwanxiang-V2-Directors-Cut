// Ephemeral gallery metadata, separate from visual facts and execution receipts.
// Persist only when the approved world shot enters the ordinary generation job.
import {galleryKeywordSchema} from './qianmu-gallery-keywords.js';
const metadata=new WeakMap();
export function rememberWorldGalleryKeywords(target,raw,input){
  const field=galleryKeywordSchema(input);
  if(!field)return target;
  if(!Array.isArray(raw)||raw.length>5||raw.some(word=>typeof word!=='string'||!field.items.enum.includes(word))){
    throw Object.assign(Error('阅片关键词须从当前词库选择，最多5项'),{code:'world_shot_preparation'});
  }
  metadata.set(target,[...new Set(raw)]);return target;
}
export function worldGalleryKeywords(target){return [...(metadata.get(target)||[])];}
export function carryWorldGalleryKeywords(target,source){metadata.set(target,worldGalleryKeywords(source));return target;}
