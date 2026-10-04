import {htmlEscape as escape} from './qianmu-storyboard-utils.js';
import {galleryCollectionChoices} from './qianmu-gallery-membership.js';

const icon=(name,label,attrs='')=>`<button type="button" class="sd-icon-btn" ${attrs} aria-label="${escape(label)}" title="${escape(label)}"><i class="fa-solid fa-${name}"></i></button>`;
function collectionChips(collections,ids){
  return galleryCollectionChoices(collections,ids).filter(item=>ids.includes(item.id)).map(item=>`<span class="sd-media-tag-chip"><span>${escape(item.label)}</span>${icon('xmark','移出合集 '+item.label,`data-image-collection-remove="${escape(item.id)}"`)}</span>`).join('');
}
export function renderImageInfo({record=null,positive='',negative='',characters='',characterNames=[],sourceCharacter='',modelLabel='',extra='',parameters='',tagEditor='',collections=[],collectionIds=[],organizeActions=''}={}) {
  const readonly=record?.recipeUnavailable===true;
  const names=[...new Set(characterNames.filter(name=>typeof name==='string'&&name.trim()).map(name=>name.trim()))];
  return `<header>${icon('arrow-left','返回','data-image-info-close')}<h2>${record?'画面详情':'编辑提示词'}</h2>${modelLabel?`<span class="sd-image-info-model">${escape(modelLabel)}</span>`:''}</header>
    <div class="sd-image-info-body">
    ${record?.url?`<div class="sd-image-info-media"><button type="button" class="sd-image-info-preview" data-image-info-action="preview" aria-label="全屏看图"><img src="${escape(record.url)}" alt="当前插画"></button><div class="sd-image-info-quick-menu"><div data-image-info-menu hidden>${icon('download','下载','data-image-info-action="download"')}${icon('trash-can','删除','data-image-info-action="delete"')}</div>${icon('ellipsis','图片菜单','data-image-info-menu-toggle aria-expanded="false"')}</div></div>`:''}
    ${sourceCharacter||names.length?`<div class="sd-image-info-cast">${sourceCharacter?`<span class="sd-image-info-source-character">${escape(sourceCharacter)}</span>`:''}${names.map(name=>`<span>${escape(name)}</span>`).join('')}</div>`:''}
    ${record?`<section class="sd-image-info-organize"><div class="sd-image-info-tag-section"><span>标签</span>${tagEditor}</div><div class="sd-image-info-collection-section"><span>合集</span><div class="sd-image-info-collection-chips"><span data-image-collection-chips>${collectionChips(collections,collectionIds)}</span>${icon('plus','添加合集','data-image-collection-add')}</div><div class="sd-image-info-collection-editor" hidden><div class="sd-image-info-collection-input"><input data-image-collection-input maxlength="80" placeholder="选择合集或输入新名称" aria-label="合集名称">${icon('xmark','取消添加合集','data-image-collection-cancel')}${icon('check','确认合集','data-image-collection-confirm')}</div><div data-image-collection-options></div></div></div>${organizeActions}</section>`:''}
    <label class="sd-image-info-prompt"><span>正面提示词<button type="button" class="sd-icon-btn" data-image-info-copy="positive" aria-label="复制正面提示词"><i class="fa-solid fa-copy"></i></button></span><textarea data-image-info-positive rows="7" maxlength="24000" ${readonly?'readonly':''}>${escape(positive)}</textarea></label>
    <label class="sd-image-info-prompt"><span>负面提示词<button type="button" class="sd-icon-btn" data-image-info-copy="negative" aria-label="复制负面提示词"><i class="fa-solid fa-copy"></i></button></span><textarea data-image-info-negative rows="3" maxlength="12000" ${readonly?'readonly':''}>${escape(negative)}</textarea></label>
    ${characters?`<details class="sd-image-info-characters"><summary>人物详情</summary><button type="button" data-image-info-reset-characters hidden>撤销人物修改</button><div data-image-info-characters>${characters}</div></details>`:''}${extra}
    ${parameters?`<details class="sd-image-info-parameters"><summary>生成参数</summary>${parameters}</details>`:''}
    ${record?`<div class="sd-image-info-actions"><button type="button" data-image-info-action="motion">让镜头动起来</button>${Number.isInteger(record.floor)&&!record.restoreLinkReview?`<button type="button" data-image-info-action="inline">${record.inline===false?'放回正文':'移出正文'}</button>`:''}</div>`:''}
    <p class="sd-image-info-status" role="status" aria-live="polite"></p></div>
    <footer><button type="button" data-image-info-close>取消</button>${readonly?'':`<button type="button" class="sd-primary" data-image-info-generate>保存并生成</button>`}</footer>`;
}

// One owned surface for prose and gallery. Draft fields never mutate a record.
export function openImageInfo({document=globalThis.document,mountPortal=()=>()=>{},applyIcons=()=>{},guard=async()=>{},copy,
  onGenerate,onAction=async()=>{},onMount=()=>{},onCollections,readCollections=()=>options.collections||[],readCollectionIds=()=>options.collectionIds||[],...options}={}) {
  const dialog=document.createElement('dialog');dialog.className='sd-image-info-dialog';dialog.setAttribute('aria-label',options.record?'插画信息':'编辑提示词');
  dialog.innerHTML=renderImageInfo(options);const returnTarget=document.activeElement;
  const positive=dialog.querySelector('[data-image-info-positive]'),negative=dialog.querySelector('[data-image-info-negative]'),status=dialog.querySelector('.sd-image-info-status'),submit=dialog.querySelector('[data-image-info-generate]'),resetCharacters=dialog.querySelector('[data-image-info-reset-characters]');
  let closed=false,pending=false,submitting=false,unmount=()=>{},resolve;const finished=new Promise(done=>{resolve=done;});
  const current=async()=>{if(closed||!dialog.isConnected)throw Error('面板已关闭');await guard();if(closed||!dialog.isConnected)throw Error('面板已关闭');};
  current.isCurrent=()=>!closed&&dialog.isConnected;
  const close=(result=false)=>{if(closed)return;closed=true;unmount();dialog.close?.();dialog.remove();resolve(result);if(returnTarget?.isConnected)returnTarget.focus?.({preventScroll:true});};
  const report=error=>{if(!closed)status.textContent=error?.message||'操作未完成';};
  const changed=()=>positive.value!==options.positive||negative.value!==options.negative||dialog.dataset.charactersChanged==='true';
  const update=()=>{if(submit)submit.textContent=submitting?'正在提交…':'保存并生成';if(resetCharacters)resetCharacters.hidden=dialog.dataset.charactersChanged!=='true';};
  const values=()=>({positive:positive.value.trim(),negative:negative.value.trim(),host:dialog,changed:changed()});
  const run=async action=>{if(pending||closed)return;pending=true;status.textContent='';
    dialog.querySelectorAll('button:not([data-image-info-close]),input,textarea,select').forEach(node=>{node.disabled=true;});update();
    try{await current();return await action(current);}catch(error){report(error);}
    finally{pending=false;submitting=false;if(!closed){dialog.querySelectorAll('button,input,textarea,select').forEach(node=>{node.disabled=false;});update();}}
  };
  dialog.querySelectorAll('[data-image-info-close]').forEach(button=>button.addEventListener('click',()=>close()));
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  dialog.addEventListener('input',event=>{if(event.target.closest('[data-image-info-characters]'))dialog.dataset.charactersChanged='true';update();});
  dialog.addEventListener('change',event=>{if(event.target.closest('[data-image-info-characters]'))dialog.dataset.charactersChanged='true';update();});
  resetCharacters?.addEventListener('click',()=>void run(async verify=>{await verify();dialog.querySelector('[data-image-info-characters]').innerHTML=options.characters;dialog.dataset.charactersChanged='false';applyIcons(dialog);status.textContent='已撤销人物修改，提示词保留';}));
  dialog.querySelectorAll('[data-image-info-copy]').forEach(button=>button.addEventListener('click',()=>void run(async verify=>{await copy(button.dataset.imageInfoCopy==='positive'?positive.value:negative.value);await verify();status.textContent='已复制';})));
  dialog.querySelectorAll('[data-image-info-action]').forEach(button=>button.addEventListener('click',()=>void run(async verify=>{
    const menu=dialog.querySelector('[data-image-info-menu]');if(menu)menu.hidden=true;dialog.querySelector('[data-image-info-menu-toggle]')?.setAttribute('aria-expanded','false');
    const result=await onAction(button.dataset.imageInfoAction,{verify,close,host:dialog});if(result==='close')close();
  })));
  dialog.querySelector('[data-image-info-menu-toggle]')?.addEventListener('click',event=>{const menu=dialog.querySelector('[data-image-info-menu]');menu.hidden=!menu.hidden;event.currentTarget.setAttribute('aria-expanded',String(!menu.hidden));});
  submit?.addEventListener('click',()=>void run(async verify=>{
    submitting=true;update();
    const draft=values();if(!draft.positive)throw Error('请填写正面提示词');
    if(draft.positive.length>24000||draft.negative.length>12000)throw Error('提示词过长，请精简');
    const accepted=await onGenerate(draft,verify);if(accepted===true)close(true);else if(!closed&&!status.textContent)status.textContent='未提交，请检查当前配置';
  }));
  document.body.appendChild(dialog);unmount=mountPortal(dialog)||(()=>{});applyIcons(dialog);dialog.showModal();
  if(onCollections){
    const editor=dialog.querySelector('.sd-image-info-collection-editor'),input=dialog.querySelector('[data-image-collection-input]'),choices=dialog.querySelector('[data-image-collection-options]');let selectedId='';
    const paintChoices=()=>{const query=input.value.trim().toLocaleLowerCase(),selected=new Set(readCollectionIds());choices.innerHTML=readCollections().filter(item=>!selected.has(item.id)&&String(item.name).toLocaleLowerCase().includes(query)).slice(0,24).map(item=>`<button type="button" data-image-collection-choice="${escape(item.id)}" aria-pressed="${selectedId===item.id}">${escape(item.name)}</button>`).join('');applyIcons(choices);};
    const cancel=()=>{editor.hidden=true;input.value='';selectedId='';dialog.querySelector('[data-image-collection-add]').focus();};
    const commit=choice=>void run(async verify=>{await onCollections(choice,verify);await verify();dialog.querySelector('[data-image-collection-chips]').innerHTML=collectionChips(readCollections(),readCollectionIds());applyIcons(dialog);cancel();});
    dialog.querySelector('[data-image-collection-add]').addEventListener('click',()=>{editor.hidden=false;paintChoices();input.focus();});
    dialog.querySelector('[data-image-collection-cancel]').addEventListener('click',cancel);
    const confirm=()=>{if(input.value.trim())commit(selectedId?{id:selectedId,checked:true}:{name:input.value.trim(),checked:true});};
    dialog.querySelector('[data-image-collection-confirm]').addEventListener('click',confirm);
    input.addEventListener('input',()=>{selectedId='';paintChoices();});input.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}else if(event.key==='Enter'){event.preventDefault();confirm();}});
    dialog.addEventListener('click',event=>{if(pending)return;const remove=event.target.closest('[data-image-collection-remove]'),choose=event.target.closest('[data-image-collection-choice]');if(remove)commit({id:remove.dataset.imageCollectionRemove,checked:false});else if(choose){selectedId=choose.dataset.imageCollectionChoice;input.value=readCollections().find(item=>item.id===selectedId)?.name||'';paintChoices();input.focus();}});
  }
  onMount(dialog,current);update();
  return {element:dialog,close,finished};
}
