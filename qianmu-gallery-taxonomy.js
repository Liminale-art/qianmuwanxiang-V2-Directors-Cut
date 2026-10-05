import {renderGalleryChoicePicker,bindGalleryChoicePicker} from './qianmu-gallery-choice-picker.js?v=1.59.440';
import {galleryCollectionChoices,applyGalleryCollectionTarget} from './qianmu-gallery-membership.js';
import {htmlEscape as escape} from './qianmu-storyboard-utils.js';

// One live toolbar owns its transient surfaces. Capture outside clicks before a
// child can rerender; never treat selecting a card as clicking empty space.
export function bindGalleryToolbar(root,{isCurrent=()=>true,selectionActive=()=>false,leaveSelection=()=>{},tagsChanged=()=>{},applyIcons=()=>{}}={}){
  root._sdGalleryToolbarCleanup?.();
  const toolbar=root.querySelector('.sd-storyboard-gallery-tools');if(!toolbar)return;
  const document=root.ownerDocument,Controller=document.defaultView.AbortController,controller=new Controller(),options={signal:controller.signal};
  const popovers=[...toolbar.querySelectorAll('.sd-gallery-toolbar-popover')];
  const closePopovers=except=>{for(const node of popovers)if(node!==except){node.open=false;node.querySelector('summary')?.setAttribute('aria-expanded','false');}if(!except?.classList.contains('sd-gallery-tags-popover'))tagsChanged(false);};
  const clearMode=()=>{
    if(!selectionActive())return;
    leaveSelection();root.querySelector('.sd-storyboard-gallery-bulk')?.remove();
    for(const card of root.querySelectorAll('.sd-storyboard-gallery-card')){card.classList.remove('selected','is-selecting');for(const attr of ['role','aria-checked','aria-label','tabindex'])card.removeAttribute(attr);const preview=card.querySelector('.sd-storyboard-preview-record');if(preview){preview.removeAttribute('tabindex');preview.setAttribute('aria-label','打开画面详情');preview.disabled=!preview.querySelector('img');}}
    const toggle=toolbar.querySelector('.sd-storyboard-gallery-select-mode');if(toggle){toggle.setAttribute('aria-pressed','false');toggle.setAttribute('aria-label','多选');toggle.title='多选';toggle.innerHTML='<i class="fa-solid fa-list-check"></i>';applyIcons(toggle);}
  };
  const dismiss=()=>{closePopovers();clearMode();root.querySelector('.sd-gallery-bulk-target')?.removeAttribute('open');};
  for(const popover of popovers){
    const summary=popover.querySelector('summary');summary?.setAttribute('aria-expanded',String(popover.open));
    summary?.addEventListener('click',event=>{event.preventDefault();if(!isCurrent(toolbar))return;const open=!popover.open;clearMode();closePopovers();popover.open=open;summary.setAttribute('aria-expanded',String(open));if(popover.classList.contains('sd-gallery-tags-popover'))tagsChanged(open);},options);
  }
  toolbar.querySelector('.sd-storyboard-gallery-select-mode')?.addEventListener('click',()=>closePopovers(),options);
  toolbar.querySelector('.sd-storyboard-gallery-new-folder')?.addEventListener('click',()=>{closePopovers();clearMode();},options);
  document.addEventListener('pointerdown',event=>{
    if(!isCurrent(toolbar))return;
    const node=event.target;if(toolbar.contains(node)||node.closest?.('.sd-gallery-name-dialog'))return;
    if(selectionActive()&&node.closest?.('.sd-storyboard-gallery-card,.sd-storyboard-gallery-bulk'))return;
    dismiss();
  },{...options,capture:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&isCurrent(toolbar)&&(selectionActive()||popovers.some(node=>node.open))){event.preventDefault();event.stopPropagation();dismiss();}},{...options,capture:true});
  const dispose=()=>{controller.abort();if(root._sdGalleryToolbarCleanup===dispose)root._sdGalleryToolbarCleanup=null;};root._sdGalleryToolbarCleanup=dispose;return {dismiss,dispose};
}

export function openGalleryNameDialog({document=globalThis.document,ownerRoot,title='新建合集',value='',mountPortal=()=>()=>{},applyIcons=()=>{},isCurrent=()=>true}={}){
  if(!isCurrent())return Promise.resolve(null);
  const dialog=document.createElement('dialog'),returnTarget=document.activeElement;
  dialog.className='sd-gallery-name-dialog sd-image-info-dialog';dialog.setAttribute('aria-label',title);
  dialog.innerHTML=`<form method="dialog"><header><h2>${escape(title)}</h2><button type="button" class="sd-icon-btn" data-gallery-name-cancel aria-label="关闭"><i class="fa-solid fa-xmark"></i></button></header><input class="text_pole" data-gallery-name maxlength="80" aria-label="合集名称" placeholder="合集名称" value="${escape(value)}" autocomplete="off"><footer><button type="button" data-gallery-name-cancel>取消</button><button type="submit" class="sd-primary" disabled>确认</button></footer></form>`;
  const input=dialog.querySelector('input'),submit=dialog.querySelector('[type="submit"]');let unmount=()=>{},closed=false;
  return new Promise(resolve=>{
    const previousCleanup=ownerRoot?._sdGalleryToolbarCleanup;
    const dispose=()=>{close(null);previousCleanup?.();};
    const close=value=>{if(closed)return;closed=true;if(ownerRoot?._sdGalleryToolbarCleanup===dispose)ownerRoot._sdGalleryToolbarCleanup=previousCleanup;unmount();dialog.close();dialog.remove();resolve(value);if(returnTarget?.isConnected)returnTarget.focus({preventScroll:true});};
    const update=()=>{submit.disabled=!input.value.trim();};input.addEventListener('input',update);update();
    dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();if(!submit.disabled)close(isCurrent()?input.value.trim():null);});
    dialog.querySelectorAll('[data-gallery-name-cancel]').forEach(button=>button.addEventListener('click',()=>close(null)));
    dialog.addEventListener('cancel',event=>{event.preventDefault();close(null);});
    dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close(null);});
    document.body.appendChild(dialog);unmount=mountPortal(dialog)||(()=>{});applyIcons(dialog);dialog.showModal();if(ownerRoot)ownerRoot._sdGalleryToolbarCleanup=dispose;input.focus();input.select();
  });
}

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
