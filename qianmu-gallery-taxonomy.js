import {renderGalleryChoicePicker,bindGalleryChoicePicker} from './qianmu-gallery-choice-picker.js';
import {galleryCollectionChoices,applyGalleryCollectionTarget} from './qianmu-gallery-membership.js';

const bulkItems=collections=>[{id:'',label:'移出全部合集'},...galleryCollectionChoices(collections)];
export function renderGalleryBulkCollections(collections){
  return renderGalleryChoicePicker({id:'bulk-collections',title:'目标合集',items:bulkItems(collections),single:true});
}
export function bindGalleryBulkCollections(root,{readCollections,readRecords,readSelection,clearSelection,isCurrent,scope,save,changed,onError}){
  const button=root.querySelector('.sd-storyboard-gallery-move-selected');if(!button)return null;
  let picker,pending=false,targetRecord=null;
  const refreshButton=()=>{if(!isCurrent(button))return;const target=picker?.selected()[0];button.disabled=pending||!readSelection().size||target===undefined;button.textContent=target===''?'移出全部合集':'加入合集';};
  picker=bindGalleryChoicePicker(root,{id:'bulk-collections',readItems:()=>bulkItems(readCollections()),single:true,isCurrent,scope,isBusy:()=>pending,
    onChange:values=>{targetRecord=values[0]?readCollections().find(item=>item.id===values[0]):null;refreshButton();},onError});
  if(!picker)return null;
  if(picker.selected()[0])targetRecord=readCollections().find(item=>item.id===picker.selected()[0]);
  const initialSelection=new Set(readSelection()),captured=new Map();for(const record of readRecords())if(initialSelection.has(record.id))captured.set(record.id,captured.has(record.id)?null:record);
  button.addEventListener('click',async()=>{
    if(!isCurrent(button)||!picker.current()||button.disabled||pending)return;
    const target=picker.selected()[0],chosen=new Set(readSelection());if(target===undefined||!chosen.size)return;
    try{
      if(target&&(!targetRecord||!readCollections().includes(targetRecord)))throw Error('目标合集已变化，请重新选择');
      const records=readRecords(),expected=records.filter(record=>chosen.has(record.id));
      if(expected.length!==chosen.size||expected.some(record=>captured.get(record.id)!==record))throw Error('所选图片已变化，请重新选择');
      pending=true;refreshButton();picker.refresh();
      const count=applyGalleryCollectionTarget(records,chosen,target);if(!count)throw Error('所选图片已变化，请重新选择');
      await save();if(isCurrent(button)&&picker.current()&&readSelection().size===chosen.size&&[...chosen].every(id=>readSelection().has(id))){clearSelection();changed(count,target);}
    }catch(error){if(isCurrent(button)&&picker.current())onError(error);}
    finally{pending=false;refreshButton();picker.refresh();}
  });
  refreshButton();return picker;
}
export function bindGalleryKeywordChoices(root,state,{readWords,isCurrent,scope,save,changed,onError}){
  if(![...root.querySelectorAll('[data-gallery-picker]')].some(node=>node.dataset.galleryPicker==='keywords'))return null;
  const items=readWords().map(word=>({id:word,label:word}));
  return bindGalleryChoicePicker(root,{id:'keywords',readItems:()=>items,readSelected:()=>state.galleryTagFilters||[],isCurrent,scope,
    onChange:async(values,{verify})=>{verify();state.galleryTagFilters=values;await save();verify();changed();},onError});
}
