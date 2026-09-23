import {htmlEscape as escape} from './qianmu-storyboard-utils.js';

export const GALLERY_CHOICE_PAGE_SIZE=24;
let sessions=new WeakMap(),epoch=0;
export function resetGalleryChoiceSessions(){sessions=new WeakMap();epoch++;}
const same=(a,b)=>a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
const unique=values=>[...new Set(values.map(value=>String(value)))];

// Metadata only. Selected ids are not reconstructed from the displayed page.
export function galleryChoiceWindow(items,selected=[],{query='',onlySelected=false,page=0}={}){
  const picked=new Set(selected),term=String(query).trim().toLocaleLowerCase(),seen=new Set();
  const filtered=items.filter(item=>{
    if(!item||typeof item.id!=='string'||seen.has(item.id))return false;
    seen.add(item.id);return (!onlySelected||picked.has(item.id))&&(!term||String(item.label||'').toLocaleLowerCase().includes(term));
  });
  const pages=Math.max(1,Math.ceil(filtered.length/GALLERY_CHOICE_PAGE_SIZE));
  const at=Math.min(pages-1,Math.max(0,Number.isSafeInteger(page)?page:0));
  return {items:filtered.slice(at*GALLERY_CHOICE_PAGE_SIZE,(at+1)*GALLERY_CHOICE_PAGE_SIZE),total:filtered.length,page:at,pages,selected:picked};
}
function rows(window,id,single,busy=false){
  return window.items.map(item=>`<button type="button" class="sd-btn sd-gallery-choice" data-choice-id="${escape(item.id)}" ${id==='keywords'?`data-gallery-tag-filter="${escape(item.id)}"`:''} aria-pressed="${window.selected.has(item.id)}" title="${escape(item.label)}" ${busy?'disabled':''}>${escape(item.label)}</button>`).join('')||'<small>没有匹配项</small>';
}
export function renderGalleryChoicePicker({id,title,items=[],selected=[],single=false}){
  const window=galleryChoiceWindow(items,selected);
  return `<section class="sd-gallery-choice-picker" data-gallery-picker="${escape(id)}" aria-label="${escape(title)}">
    <div class="sd-gallery-choice-tools"><input class="text_pole" data-choice-search aria-label="搜索${escape(title)}" placeholder="搜索${escape(title)}"><button type="button" class="sd-btn" data-choice-selected aria-pressed="false">已选 ${window.selected.size}</button></div>
    ${single?'<small data-choice-current>请选择目标合集</small>':''}<div class="sd-gallery-choice-list" data-choice-list>${rows(window,id,single)}</div>
    <nav class="sd-gallery-choice-pages" aria-label="${escape(title)}分页" ${window.pages===1?'hidden':''}><button type="button" class="sd-icon-btn" data-choice-page="prev" aria-label="上一页" disabled><i class="fa-solid fa-chevron-left"></i></button><small data-choice-page-label>1/${window.pages} · ${window.total} 项</small><button type="button" class="sd-icon-btn" data-choice-page="next" aria-label="下一页" ${window.pages===1?'disabled':''}><i class="fa-solid fa-chevron-right"></i></button></nav>
    <small data-choice-error role="status"></small></section>`;
}

// One small state per picker kind, per live root. A chat/owner/epoch change resets
// that state; query/page can survive an ordinary modal rerender, not a new source.
export function bindGalleryChoicePicker(root,{id,readItems,readSelected,isCurrent,scope=()=>[],single=false,isBusy=()=>false,onChange=()=>{},onError=()=>{}}){
  const frame=[...root.querySelectorAll('[data-gallery-picker]')].find(node=>node.dataset.galleryPicker===id);
  if(!frame)return null;
  frame._qianmuChoiceDispose?.();let captured;
  try{captured=[...scope()];}catch{return null;}
  let bucket=sessions.get(root);if(!bucket){bucket=new Map();sessions.set(root,bucket);}
  let session=bucket.get(id);
  if(!session||!same(session.scope,captured)){session={scope:captured,query:'',page:0,onlySelected:false,value:null,focusId:null};bucket.set(id,session);}
  const input=frame.querySelector('[data-choice-search]'),list=frame.querySelector('[data-choice-list]'),selectedButton=frame.querySelector('[data-choice-selected]');
  const prev=frame.querySelector('[data-choice-page="prev"]'),next=frame.querySelector('[data-choice-page="next"]'),label=frame.querySelector('[data-choice-page-label]'),error=frame.querySelector('[data-choice-error]');
  const boundEpoch=epoch;let disposed=false,busy=false,visible=new Set();
  frame._qianmuChoiceDispose=()=>{disposed=true;};
  const current=()=>{try{return !disposed&&boundEpoch===epoch&&isCurrent(frame)&&same(captured,[...scope()]);}catch{return false;}};
  const selected=()=>unique(readSelected?readSelected():session.value===null?[]:[session.value]);
  const verify=()=>{if(!current())throw Error('页面或来源已变化，请重新选择');};
  function paint(){
    if(!current())return;
    const items=readItems(),picked=selected(),window=galleryChoiceWindow(items,picked,session);session.page=window.page;
    visible=new Set(window.items.map(item=>item.id));list.innerHTML=rows(window,id,single,busy||isBusy());
    input.hidden=items.length<=GALLERY_CHOICE_PAGE_SIZE&&!session.query;selectedButton.hidden=single;
    selectedButton.textContent=`已选 ${window.selected.size}`;selectedButton.setAttribute('aria-pressed',String(session.onlySelected));
    prev.disabled=window.page===0;next.disabled=window.page+1===window.pages;
    label.textContent=`${window.page+1}/${window.pages} · ${window.total} 项`;label.parentElement.hidden=window.pages===1;
    const chosen=frame.querySelector('[data-choice-current]');if(chosen)chosen.textContent=picked.length?`当前：${items.find(item=>item.id===picked[0])?.label||'所选合集已移除'}`:'请选择目标合集';
    if(!busy&&session.focusId!==null){const buttons=[...list.querySelectorAll('[data-choice-id]')],button=buttons.find(node=>node.dataset.choiceId===session.focusId);(button||(!input.hidden?input:!selectedButton.hidden?selectedButton:buttons[0]))?.focus({preventScroll:true});session.focusId=null;}
  }
  input.value=session.query;
  input.addEventListener('input',()=>{if(!current())return;session.query=input.value;session.page=0;paint();});
  selectedButton.addEventListener('click',()=>{if(!current())return;session.onlySelected=!session.onlySelected;session.page=0;paint();});
  for(const [button,delta] of [[prev,-1],[next,1]])button.addEventListener('click',()=>{if(!current()||button.disabled)return;session.page+=delta;paint();});
  frame.addEventListener('click',async event=>{
    const button=event.target.closest?.('[data-choice-id]');if(!button||!frame.contains(button)||button.disabled||!current()||busy||isBusy())return;
    const value=button.dataset.choiceId;if(!visible.has(value)||!readItems().some(item=>item.id===value))return;
    const before=selected(),checked=single||!before.includes(value),after=single?[value]:checked?[...before,value]:before.filter(id=>id!==value),previous=session.value;
    session.value=single?value:session.value;session.focusId=value;busy=true;error.textContent='';paint();
    try{await onChange(after,{id:value,checked,verify,isCurrent:current});}
    catch(failure){session.value=previous;if(current()){error.textContent=failure?.message||'未能保存';onError(failure);}}
    finally{busy=false;if(current())paint();}
  });
  paint();return {selected,current,refresh:paint};
}
