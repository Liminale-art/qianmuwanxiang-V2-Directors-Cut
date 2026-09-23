import {htmlEscape as escape} from './qianmu-storyboard-utils.js';
import {renderGalleryChoicePicker,bindGalleryChoicePicker} from './qianmu-gallery-choice-picker.js';
import {galleryMembershipIds,galleryMembershipChange,galleryCollectionChoices} from './qianmu-gallery-membership.js';

// This view reads one chosen record's display fields only, never its recipe.
export function renderGalleryInspector(record, {url='',sourceLabel='',production={},tagEditor='',collections=[],collectionIds=[],location=null}={}) {
  if (!record) return '';
  const prompt=record.finalPrompt||record.prompt||'';
  return `<section class="sd-gallery-detail" data-gallery-detail="${escape(record.id)}" aria-label="画面详情">
    <header><button type="button" class="sd-icon-btn" data-gallery-detail-back aria-label="返回阅片室" title="返回阅片室"><i class="fa-solid fa-arrow-left"></i></button><h3>画面详情</h3><span>${escape(record.model||sourceLabel)}</span></header>
    <div class="sd-gallery-detail-layout"><div class="sd-gallery-detail-visual">${url?`<button type="button" data-gallery-detail-action="preview" aria-label="查看原图与重绘工具"><img src="${escape(url)}" alt="当前画面" decoding="async"></button>`:'<p>原图地址暂不可用，原记录仍保留。</p>'}</div>
    <div class="sd-gallery-detail-fields"><div class="sd-storyboard-inspector-source"><b>${escape(sourceLabel)}</b><span class="sd-storyboard-production-label ${production.track==='second_camera'?'second-camera':''}">${escape(production.sourceLabel||'')}</span></div>
    <fieldset><legend>标签</legend>${tagEditor}</fieldset><fieldset><legend>合集</legend>${renderGalleryChoicePicker({id:'detail-collections',title:'合集',items:galleryCollectionChoices(collections,collectionIds),selected:collectionIds})}</fieldset>
    ${prompt?`<details class="sd-gallery-detail-prompt"><summary>画面提示词</summary><p>${escape(prompt)}</p></details>`:''}
    <div class="sd-gallery-detail-actions">${location?`<button type="button" class="sd-btn" data-gallery-detail-action="source">${location.paragraphKey?'查看本段全部静帧':'查看本层全部静帧'}</button>`:''}
    ${record.restoreLinkReview?'<button type="button" class="sd-btn" data-gallery-detail-action="review"><i class="fa-solid fa-link"></i>核对正文位置</button>':''}
    ${!record.restoreLinkReview&&production.requiresExplicitInsert&&!Number.isInteger(record.floor)?'<button type="button" class="sd-btn" data-gallery-detail-action="attach">引用至当前正文</button>':''}
    ${record.source==='novel'&&!record.recipeUnavailable?'<button type="button" class="sd-btn" data-gallery-detail-action="style">套用 NAI 风格配置</button>':''}
    ${url?'<button type="button" class="sd-btn" data-gallery-detail-action="preview">原图与重绘工具</button>':''}</div></div></div></section>`;
}

// Capture values, not a mutable array. Detached/closed/replaced views fail closed.
export function captureGalleryViewGuard(root, {scope,isActive}) {
  let captured;try {captured=[...scope()];} catch {return ()=>false;}
  return node=>{
    try {const live=scope();return Boolean(root.isConnected&&node?.isConnected&&root.contains(node)&&isActive()
      &&live.length===captured.length&&captured.every((value,index)=>Object.is(value,live[index])));} catch {return false;}
  };
}

// All actions stay bound to the displayed object, never a new chat's same-id row.
export function bindGalleryInspector(root, {isCurrent,readRecord,readId,readCollections=()=>[],scope=()=>[],back,actions={},saveCollections,onError=()=>{}}) {
  const area=root.querySelector('[data-gallery-detail]');if(!area)return;
  area._qianmuInspectorDispose?.();
  let record;try {record=readRecord();} catch { /* stale source: back remains usable */ }
  const id=area.dataset.galleryDetail;let disposed=false,busy=false;
  area._qianmuInspectorDispose=()=>{disposed=true;};
  const current=()=>{try{return !disposed&&isCurrent(area)&&Boolean(record)&&record.id===id&&readId()===id&&readRecord()===record;}catch{return false;}};
  const verify=async()=>{if(!current())throw Error('画面或页面已变化，请重新选择');};
  const picker=bindGalleryChoicePicker(root,{id:'detail-collections',readItems:()=>galleryCollectionChoices(readCollections(),galleryMembershipIds(record)),
    readSelected:()=>galleryMembershipIds(record),isCurrent:()=>current(),scope:()=>[...scope(),record],isBusy:()=>busy,
    onChange:async(_values,{id,checked,verify:verifyChoice})=>{
      verifyChoice();busy=true;
      try{await verify();const ids=galleryMembershipChange(record,id,checked);await saveCollections(record,ids,async()=>{verifyChoice();await verify();});}finally{busy=false;}
    },onError});
  for(const editor of area.querySelectorAll('[data-media-tag-editor]'))editor._qianmuGalleryCurrent=current;
  area.querySelector('[data-gallery-detail-back]')?.addEventListener('click',()=>{if(!disposed&&isCurrent(area)&&readId()===id)back(id);});
  async function run(button,action){
    if(!current()||busy||button.disabled||typeof action!=='function')return;
    busy=true;button.disabled=true;
    picker?.refresh();
    try {await action(record,{verify,isCurrent:current});}
    catch(error){if(current())onError(error);}
    finally {busy=false;if(current()){button.disabled=false;picker?.refresh();}}
  }
  for(const button of area.querySelectorAll('[data-gallery-detail-action]'))button.addEventListener('click',()=>void run(button,actions[button.dataset.galleryDetailAction]));
}
