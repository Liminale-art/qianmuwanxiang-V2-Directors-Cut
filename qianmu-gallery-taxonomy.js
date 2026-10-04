import {renderGalleryChoicePicker,bindGalleryChoicePicker} from './qianmu-gallery-choice-picker.js?v=1.59.440';
import {galleryCollectionChoices,applyGalleryCollectionTarget} from './qianmu-gallery-membership.js';

export function renderGalleryBulkCollections(collections){
  return `<details class="sd-gallery-bulk-target"><summary class="sd-icon-btn" title="加入合集" aria-label="加入合集"><i class="fa-solid fa-folder-plus"></i></summary>${renderGalleryChoicePicker({id:'bulk-collections',title:'合集',items:galleryCollectionChoices(collections),single:true,compact:true})}</details><button type="button" class="sd-icon-btn sd-gallery-remove-all-collections" title="移出自建合集" aria-label="移出自建合集"><i class="fa-solid fa-folder-minus"></i></button>`;
}
export function bindGalleryBulkCollections(root,options){
  return root.querySelector('.sd-gallery-bulk-target')?bindCompactGalleryBulkCollections(root,options):null;
}
function bindCompactGalleryBulkCollections(root,{readCollections,readRecords,readSelection,clearSelection,isCurrent,scope,save,changed,onError}){
  const frame=root.querySelector('.sd-gallery-bulk-target'),remove=root.querySelector('.sd-gallery-remove-all-collections');
  const initial=new Set(readSelection()),captured=new Map(),targets=new Map(readCollections().map(row=>[row.id,row]));let pending=false,picker;
  for(const record of readRecords())if(initial.has(record.id))captured.set(record.id,captured.has(record.id)?null:record);
  const apply=async target=>{
    if(pending||!isCurrent(frame)||!picker.current())return;
    const chosen=new Set(readSelection());if(!chosen.size)return;
    const records=readRecords().filter(record=>chosen.has(record.id));
    if(records.length!==chosen.size||records.some(record=>captured.get(record.id)!==record))throw Error('所选图片已变化，请重新选择');
    if(target&&(!targets.has(target)||!readCollections().includes(targets.get(target))))throw Error('目标合集已变化，请重新选择');
    const before=records.map(record=>({record,collectionIds:record.collectionIds,collectionId:record.collectionId}));
    pending=true;remove.disabled=true;
    try{
      const count=applyGalleryCollectionTarget(records,chosen,target);for(const row of before){row.applied=row.record.collectionIds;row.primary=row.record.collectionId;}await save();
      if(isCurrent(frame)&&picker.current()&&readSelection().size===chosen.size&&[...chosen].every(id=>readSelection().has(id))){clearSelection();changed(count,target);}
    }catch(error){for(const row of before)if(row.applied&&row.record.collectionIds===row.applied&&row.record.collectionId===row.primary){row.record.collectionIds=row.collectionIds;row.record.collectionId=row.collectionId;}throw error;}
    finally{pending=false;remove.disabled=!readSelection().size;picker.refresh();}
  };
  picker=bindGalleryChoicePicker(root,{id:'bulk-collections',readItems:()=>galleryCollectionChoices(readCollections()),single:true,isCurrent,scope,isBusy:()=>pending,onChange:values=>apply(values[0]),onError});
  remove.disabled=!readSelection().size;remove.addEventListener('click',()=>{if(!remove.disabled)return apply('').catch(error=>{if(isCurrent(frame)&&picker.current())onError(error);});});return picker;
}
export function bindGalleryKeywordChoices(root,state,{readWords,isCurrent,scope,save,changed,onError}){
  if(![...root.querySelectorAll('[data-gallery-picker]')].some(node=>node.dataset.galleryPicker==='keywords'))return null;
  const items=readWords().map(word=>({id:word,label:word}));
  return bindGalleryChoicePicker(root,{id:'keywords',readItems:()=>items,readSelected:()=>state.galleryTagFilters||[],isCurrent,scope,
    onChange:async(values,{verify})=>{verify();state.galleryTagFilters=values;await save();verify();changed();},onError});
}
