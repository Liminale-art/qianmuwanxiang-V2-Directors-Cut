import {comfyReferenceStillMime} from './qianmu-comfy-results.js';
import {captureStoryboardVibeRecipe} from './qianmu-vibe-recipe.js';

const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const amount=(value,fallback)=>value==null||value===''?fallback:Number(value);
export function filterStoryboardVibes(items,query='',limit=40){
  const words=String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows=items.filter(item=>words.every(word=>String(item.name||'').toLocaleLowerCase().includes(word)));
  return {total:rows.length,items:rows.slice(0,Math.max(40,Math.min(500,limit)))};
}
export function checkStoryboardVibeSelection(items,ids,{supportsVibe,modelId,preciseReference}={}){
  if(!Array.isArray(ids)||ids.length>16||new Set(ids).size!==ids.length)throw Error('最多选择 16 项不同 Vibe');
  if(!ids.length)return [];
  if(!supportsVibe)throw Error('当前渠道或模型不支持 Vibe');
  if(preciseReference)throw Error('Vibe 与角色精确参考互斥，请先关闭其中一种');
  const selected=ids.map(id=>items.find(item=>item.id===id));
  if(selected.some(item=>!item||item.providerIds?.length&&!item.providerIds.includes('novel')||item.modelIds?.length&&!item.modelIds.includes(modelId)))throw Error('所选 Vibe 缺失或不兼容当前模型，请重新选择');
  captureStoryboardVibeRecipe(ids,items);return [...ids];
}
function permanentUrl(value){
  const url=String(value||'').trim();
  try{captureStoryboardVibeRecipe(['preview'],[{id:'preview',name:'Vibe',previewUrl:url}]);return url;}catch(_){return '';}
}

// A single local editor session survives host rerenders. Only explicit Save publishes a library entry.
export function createStoryboardVibeLibraryController({items,gallery,save,remove,onEdit=()=>{},onGallery=()=>{},onGalleryDone=()=>{},onApply=()=>{},onCancel=()=>{},onNotice=()=>{},icons=()=>{},isCurrent=()=>true,selectionIssue=()=>'',collapsed=()=>false,onCollapse=()=>{}}={}){
  let host=null,disposed=false,token=0,cancelProbe=null,objectUrl='',timer=0,revision=0,busy=false,sourcePending=false;
  let draft=blank(),query='',visible=40,galleryQuery='',galleryVisible=40,picking=false,selection=null;
  function blank(item){return {id:item?.id||'',name:item?.name||'',url:item?.previewUrl||'',strength:String(amount(item?.strength,.6)),info:String(amount(item?.informationExtracted,1)),file:undefined,mode:'',pendingUrl:''};}
  const live=()=>!disposed&&isCurrent()&&host?.isConnected;
  const report=error=>{if(!disposed&&isCurrent())onNotice(error?.message||'操作失败，原素材保留');};
  const action=callback=>event=>{if(event.type==='click')event.preventDefault();if(!live())return;try{Promise.resolve(callback(event)).catch(report);}catch(error){report(error);}};
  const listen=(selector,event,callback)=>host.querySelectorAll(selector).forEach(node=>node.addEventListener(event,action(callback)));
  function cancelSource(){token++;cancelProbe?.();cancelProbe=null;sourcePending=false;}
  function revoke(){if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl='';}}
  function previewUrl(){if(draft.file){objectUrl||=URL.createObjectURL(draft.file);return objectUrl;}return permanentUrl(draft.url);}
  function syncFields(){
    if(!host||picking)return;
    for(const key of ['name','strength','info']){const node=host.querySelector(`.sd-storyboard-vibe-${key}`);if(node)draft[key]=node.value;}
  }
  function read(){syncFields();return {name:draft.name,url:draft.url,gallery:'',strength:draft.strength,info:draft.info,file:draft.file};}
  function probe(url){
    return new Promise((resolve,reject)=>{
      const image=new host.ownerDocument.defaultView.Image();let settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(wait);image.onload=null;image.onerror=null;cancelProbe=null;if(error){image.src='';reject(error);}else resolve();};
      const wait=setTimeout(()=>finish(Error('图片读取超时，原参考图保留')),10000);
      cancelProbe=()=>finish(Error('图片选择已取消'));
      image.referrerPolicy='no-referrer';image.onload=()=>finish(image.naturalWidth>0&&image.naturalHeight>0?null:Error('图片无法预览'));image.onerror=()=>finish(Error('图片读取失败，原参考图保留'));image.src=url;
    });
  }
  async function source({url='',file,accept=()=>true}={}){
    syncFields();cancelSource();revision++;sourcePending=true;const request=token,currentDraft=draft;let temporary='';
    const current=()=>live()&&request===token&&draft===currentDraft;
    try{
      if(file){
        if(!Number.isInteger(file.size)||file.size<1||file.size>16*1024*1024)throw Error('参考图须在 16 MB 以内');
        const bytes=new Uint8Array(await file.arrayBuffer());if(!current())return false;
        if(bytes.length!==file.size)throw Error('图片读取不完整');comfyReferenceStillMime(bytes);
        temporary=URL.createObjectURL(file);url=temporary;
      }else{url=permanentUrl(url);if(!url)throw Error('请填写有效的永久图片地址');}
      if(!current())return false;await probe(url);if(!current())return false;if(!accept())throw Error('原图片已变化，请重新选择');
      revoke();draft.file=file;draft.url=file?'':url;draft.mode='';draft.pendingUrl='';revision++;
      if(file){objectUrl=temporary;temporary='';}return true;
    }catch(error){if(current())report(error);return false;}
    finally{if(request===token)sourcePending=false;if(temporary)URL.revokeObjectURL(temporary);}
  }
  function editor(){
    const preview=previewUrl();return `<details class="sd-card sd-vibe-editor" ${collapsed()?'':'open'}><summary><b>${draft.id?'编辑 Vibe':'新建 Vibe'}</b></summary><div class="sd-storyboard-card-body">
      <div class="sd-vibe-edit-grid"><button type="button" class="sd-vibe-preview" aria-label="上传或更换参考图">${preview?`<img src="${escape(preview)}" alt="参考图">`:'<i class="fa-solid fa-upload"></i>'}</button><input class="sd-storyboard-vibe-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
      <div class="sd-vibe-edit-fields"><label><span>名称</span><input class="text_pole sd-storyboard-vibe-name" maxlength="100" value="${escape(draft.name)}"></label><div class="sd-vibe-amounts"><label><span>强度</span><input class="text_pole sd-storyboard-vibe-strength" type="number" min="0" max="1" step=".05" value="${escape(draft.strength)}"></label><label><span>信息提取</span><input class="text_pole sd-storyboard-vibe-info" type="number" min="0" max="1" step=".05" value="${escape(draft.info)}"></label></div></div></div>
      <div class="sd-vibe-source-row">${draft.mode==='url'?`<input class="text_pole sd-vibe-source-url" type="url" aria-label="参考图 URL" value="${escape(draft.pendingUrl)}"><button type="button" class="sd-icon-btn sd-vibe-source-load" aria-label="读取地址"><i class="fa-solid fa-check"></i></button>`:'<select class="text_pole sd-vibe-source-mode" aria-label="其他图片来源"><option value="">选择图片来源</option><option value="url">URL</option><option value="gallery">阅片室</option></select>'}<button type="button" class="sd-icon-btn sd-vibe-source-reset" aria-label="重置来源选择"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="sd-vibe-editor-actions"><button type="button" class="sd-icon-btn sd-vibe-reset-editor" aria-label="取消编辑"><i class="fa-solid fa-xmark"></i></button><button type="button" class="sd-icon-btn sd-storyboard-create-vibe" aria-label="保存 Vibe" ${busy?'disabled':''}><i class="fa-solid fa-floppy-disk"></i></button></div></div></details>`;
  }
  function selected(id){return selection?.ids.includes(id);}
  function library(){
    const results=filterStoryboardVibes(items(),query,visible);
    return `<div class="sd-vibe-waterfall">${results.items.map(item=>{
      const url=permanentUrl(item.previewUrl),issue=selectionIssue(item);return `<article class="sd-vibe-tile ${selected(item.id)?'selected':''}" data-vibe-id="${escape(item.id)}">
        ${url?`<img src="${escape(url)}" alt="${escape(item.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:'<div class="sd-vibe-file-cover"><i class="fa-solid fa-file-import"></i></div>'}
        <div class="sd-vibe-tile-info"><b>${escape(item.name)}</b><small>强度 ${amount(item.strength,.6).toFixed(2)} · 信息 ${amount(item.informationExtracted,1).toFixed(2)}</small><div class="sd-vibe-tile-actions">${selection?`<button type="button" class="sd-icon-btn sd-vibe-select" aria-label="${selected(item.id)?'取消选择':'选择'} ${escape(item.name)}" aria-pressed="${Boolean(selected(item.id))}" ${issue&&!selected(item.id)?'disabled':''} title="${escape(issue)}"><i class="fa-solid ${selected(item.id)?'fa-check':'fa-plus'}"></i></button>`:''}<button type="button" class="sd-icon-btn sd-vibe-edit" aria-label="编辑 ${escape(item.name)}"><i class="fa-solid fa-pen"></i></button><button type="button" class="sd-icon-btn sd-danger sd-vibe-delete" aria-label="删除 ${escape(item.name)}"><i class="fa-solid fa-trash-can"></i></button></div></div></article>`;
    }).join('')}</div>${results.total>results.items.length?'<button type="button" class="sd-btn sd-vibe-more">加载更多</button>':''}`;
  }
  function bindLibrary(){
    listen('.sd-vibe-more','click',()=>{visible+=40;renderLibrary();});
    listen('.sd-vibe-edit','click',event=>{const item=items().find(row=>row.id===event.currentTarget.closest('[data-vibe-id]').dataset.vibeId);if(!item)return;syncFields();cancelSource();revoke();draft=blank(item);revision++;onEdit(item.id);onCollapse(false);render();host.querySelector('.sd-vibe-editor')?.scrollIntoView({block:'start',behavior:'auto'});host.querySelector('.sd-storyboard-vibe-name')?.focus({preventScroll:true});});
    listen('.sd-vibe-delete','click',async event=>{const item=items().find(row=>row.id===event.currentTarget.closest('[data-vibe-id]').dataset.vibeId);if(!item)return;
      if(await remove(item)&&live()){if(selection)selection.ids=selection.ids.filter(id=>id!==item.id);if(draft.id===item.id){cancelSource();revoke();draft=blank();revision++;onEdit('');}render();}
    });
    listen('.sd-vibe-select','click',event=>{
      const id=event.currentTarget.closest('[data-vibe-id]').dataset.vibeId,item=items().find(row=>row.id===id);if(!selection||!item)return;
      if(selected(id))selection.ids=selection.ids.filter(value=>value!==id);else{const issue=selectionIssue(item);if(issue)throw Error(issue);if(selection.ids.length>=16)throw Error('最多选择 16 项 Vibe');selection.ids.push(id);}renderLibrary();updateSelectionCount();
    });
  }
  function updateSelectionCount(){const node=host?.querySelector('.sd-vibe-selection-count');if(node)node.textContent=`已选 ${selection?.ids.length||0} / 16`;}
  function renderLibrary(){const node=host?.querySelector('.sd-vibe-list-host');if(!node)return;node.innerHTML=library();bindLibrary();icons(node);}
  function render(){
    if(!live())return;clearTimeout(timer);
    if(picking){renderGallery();return;}
    host.innerHTML=`${selection?'<div class="sd-vibe-selection-bar"><span class="sd-vibe-selection-count"></span><button class="sd-icon-btn sd-vibe-clear-selection" type="button" aria-label="清空本次选择"><i class="fa-solid fa-xmark"></i></button><button class="sd-btn sd-vibe-cancel-selection" type="button">取消</button><button class="sd-btn sd-primary sd-vibe-apply-selection" type="button">确认</button></div>':''}${editor()}<div class="sd-vibe-library-search"><input class="text_pole sd-vibe-search" aria-label="搜索 Vibe 名称" placeholder="搜索 Vibe" value="${escape(query)}"></div><div class="sd-vibe-list-host">${library()}</div>`;
    updateSelectionCount();bindLibrary();icons(host);
    listen('.sd-vibe-editor','toggle',event=>{if(host.contains(event.currentTarget))onCollapse(!event.currentTarget.open);});
    listen('.sd-vibe-search','input',event=>{query=event.currentTarget.value.slice(0,120);visible=40;clearTimeout(timer);timer=setTimeout(()=>{if(live())renderLibrary();},120);});
    for(const key of ['name','strength','info'])listen(`.sd-storyboard-vibe-${key}`,'input',event=>{draft[key]=event.currentTarget.value;revision++;});
    // Native file picker must open in the original user activation, not in an awaited callback.
    host.querySelector('.sd-vibe-preview').addEventListener('click',()=>host.querySelector('.sd-storyboard-vibe-file')?.click());
    listen('.sd-storyboard-vibe-file','change',async event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file&&await source({file})&&live())render();});
    listen('.sd-vibe-source-mode','change',event=>{syncFields();revision++;if(event.currentTarget.value==='gallery'){cancelSource();picking=true;onGallery();}else{draft.mode='url';draft.pendingUrl=draft.url;render();host.querySelector('.sd-vibe-source-url')?.focus();}});
    listen('.sd-vibe-source-url','input',event=>{draft.pendingUrl=event.currentTarget.value;revision++;cancelSource();});
    const load=async()=>{if(await source({url:draft.pendingUrl})&&live())render();};
    listen('.sd-vibe-source-load','click',load);listen('.sd-vibe-source-url','change',load);listen('.sd-vibe-source-url','keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();return load();}});
    listen('.sd-vibe-source-reset','click',()=>{syncFields();cancelSource();revision++;draft.mode='';draft.pendingUrl='';render();});
    listen('.sd-vibe-reset-editor','click',()=>{cancelSource();revoke();draft=blank();revision++;onEdit('');render();});
    listen('.sd-storyboard-create-vibe','click',async()=>{
      if(busy)return;if(sourcePending||draft.mode==='url'&&draft.pendingUrl.trim()!==draft.url.trim())throw Error('请先确认参考图读取成功，再保存');syncFields();cancelSource();const version=revision,currentDraft=draft,currentHost=host;busy=true;host.querySelector('.sd-storyboard-create-vibe').disabled=true;
      try{if(await save(currentHost,{readDraft:read,isCurrent:()=>live()&&host===currentHost&&draft===currentDraft&&revision===version,onSaved:()=>{}})&&live()&&draft===currentDraft){revoke();draft=blank();revision++;onEdit('');render();}}
      finally{busy=false;if(live()){const button=host.querySelector('.sd-storyboard-create-vibe');if(button)button.disabled=false;}}
    });
    listen('.sd-vibe-cancel-selection','click',()=>{selection=null;onCancel();});
    listen('.sd-vibe-clear-selection','click',()=>{if(selection){selection.ids=[];renderLibrary();updateSelectionCount();}});
    listen('.sd-vibe-apply-selection','click',async()=>{if(selection)await onApply([...selection.ids]);});
  }
  function renderGallery(){
    const words=galleryQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const records=gallery().filter(row=>permanentUrl(row.url)&&words.every(word=>String(row.prompt||row.name||'').toLocaleLowerCase().includes(word))).slice().reverse();
    host.innerHTML=`<div class="sd-vibe-gallery-tools"><input class="text_pole sd-vibe-gallery-search" aria-label="搜索阅片室图片" placeholder="搜索图片" value="${escape(galleryQuery)}"><button type="button" class="sd-btn sd-vibe-gallery-cancel">取消选图</button></div><div class="sd-vibe-waterfall">${records.slice(0,galleryVisible).map(row=>`<button type="button" class="sd-vibe-gallery-picture" data-gallery-vibe="${escape(row.id)}" aria-label="选择图片"><img src="${escape(row.url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>`).join('')}</div>${records.length>galleryVisible?'<button class="sd-btn sd-vibe-gallery-more" type="button">加载更多</button>':''}`;
    listen('.sd-vibe-gallery-cancel','click',()=>{cancelSource();picking=false;onGalleryDone();});
    listen('.sd-vibe-gallery-search','input',event=>{galleryQuery=event.currentTarget.value.slice(0,120);galleryVisible=40;clearTimeout(timer);timer=setTimeout(()=>{if(live()){const start=host.querySelector('.sd-vibe-gallery-search')?.selectionStart;renderGallery();const input=host.querySelector('.sd-vibe-gallery-search');input.focus({preventScroll:true});input.setSelectionRange(start,start);}},160);});
    listen('.sd-vibe-gallery-more','click',()=>{galleryVisible+=40;renderGallery();});
    listen('[data-gallery-vibe]','click',async event=>{const id=event.currentTarget.dataset.galleryVibe,row=gallery().find(item=>item.id===id);if(!row)return;const original=row.url;
      if(await source({url:original,accept:()=>gallery().some(item=>item.id===id&&item.url===original)})&&live()){picking=false;onGalleryDone();}
    });
    icons(host);
  }
  return Object.freeze({
    mount(node){if(disposed)return;this.detach();host=node;render();},
    detach(){syncFields();cancelSource();clearTimeout(timer);host=null;revoke();},
    dispose(){this.detach();disposed=true;draft=blank();selection=null;},
    edit(item){cancelSource();revoke();draft=blank(item);revision++;onEdit(draft.id);},
    beginSelection(value){selection={id:value.id,ids:[...value.ids]};},
    cancelSelection(){selection=null;},
    exitGallery(){cancelSource();picking=false;},
    get selectionId(){return selection?.id||'';},get isGallery(){return picking;},get dirty(){return Boolean(draft.id||draft.name||draft.url||draft.file);},
  });
}
