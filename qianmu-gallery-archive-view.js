import {htmlEscape as escape} from './qianmu-storyboard-utils.js';
import {createGalleryArchiveBrowser} from './qianmu-gallery-archive-browser.js?v=1.59.284';
import {bindGalleryPreviewZoom} from './qianmu-gallery-preview-zoom.js';

const button=(action,label,disabled=false)=>`<button type="button" class="sd-btn" data-archive-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
const date=value=>new Date(value).toLocaleString();
const recipeLabels={'not-preserved':'此版本尚未保全完整服务器配方；原引用保留。','local-reference':'仅有旧本机配方引用，无法确认账户归属；未借用其他设备缓存。',unavailable:'原记录明确标为未保留配方。',unresolved:'原记录的配方结构尚未核实，未使用当前设置补齐。','not-recorded':'原记录没有保存配方。'};
export function galleryArchiveRecipeHtml(recipe){
  return recipe?.state==='available'?`<p>${recipe.origin==='server-copy'?'已保全的服务器配方副本':'保全记录内的完整配方'}；不代表原模型仍可调用，此处不重绘或套用。</p><textarea class="text_pole" rows="10" readonly aria-label="原配方，只读">${escape(JSON.stringify(recipe.snapshot))}</textarea>`
    :recipe?`<p>${escape(recipeLabels[recipe.state]||'原配方尚未确认。')}</p>`:'';
}
export function galleryArchiveListHtml({entries=[],rows=[],selected=null,busy=false}={}){
  if(selected)return rows.map((row,index)=>`<button type="button" class="sd-directory-row" data-archive-record="${index}" ${busy?'disabled':''}><span><b>${escape(row.tags.join(' · ')||'静帧')}</b><small>${escape(date(row.createdAt))}</small></span><span>查看画面</span></button>`).join('');
  return entries.map((entry,index)=>`<button type="button" class="sd-directory-row" data-archive-version="${index}" ${busy?'disabled':''}><span><b>${escape(entry.value.scope.chatKey)}</b><small>${escape(entry.value.scope.ownerKey)} · ${entry.value.sourceReceipt.count} 张 · 版本 ${escape(entry.key.slice(0,8))}</small></span><span>打开</span></button>`).join('');
}

// Kept inside the existing still-gallery dialog family. Only an explicit image
// click fetches media; back navigation uses the already loaded small list.
export function openGalleryArchive({parent,account,headers,isCurrent=()=>true,connect=createGalleryArchiveBrowser}={}){
  const document=parent.ownerDocument,view=document.defaultView,returnFocus=document.activeElement;
  const dialog=document.createElement('dialog');dialog.className='sd-bundle-dialog sd-gallery-directory sd-gallery-archive';
  dialog.setAttribute('aria-label','已保存图库');
  let closed=false,busy=false,notice='',session,selected=null,preview=null,url='',releaseZoom,recipe=null;
  let versions=null,page=null,versionStack=[null],pageStack=[null],tag='',resolve;
  let versionScroll=0,pageScroll=0,restoreScroll=null;
  const finished=new Promise(done=>resolve=done);
  function releaseImage(){releaseZoom?.();releaseZoom=null;if(url)view.URL.revokeObjectURL(url);url='';preview=null;recipe=null;}
  function close(){
    if(closed)return;closed=true;observer.disconnect();view.removeEventListener('pagehide',close);session?.close();releaseImage();
    if(dialog.open)dialog.close();dialog.remove();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});resolve();
  }
  function alive(){
    if(closed)return false;
    try{if(!dialog.isConnected||!parent.isConnected||!parent.classList.contains('open')||isCurrent()!==true)throw Error();return true;}
    catch{close();return false;}
  }
  const observer=new view.MutationObserver(()=>{alive();});
  function draw(){
    if(!alive())return;releaseZoom?.();releaseZoom=null;
    const previousScroll=dialog.querySelector('main')?.scrollTop||0;
    if(preview){
      const tags=Array.isArray(preview.record.tags)?preview.record.tags:[];
      dialog.innerHTML=`<header><b>已保存画面 · 只读</b>${button('back','返回列表')}${button('close','关闭')}</header><main>
        <div class="sd-directory-image-stage" tabindex="0" aria-label="图片；滚轮或双指缩放，拖动平移，0 恢复"><div><img src="${escape(url)}" alt="${escape(tags.join(' · ')||'已保存画面')}" draggable="false"></div></div>
        <nav><button type="button" class="sd-btn" data-preview-zoom="out" aria-label="缩小">−</button><span data-preview-scale>100%</span><button type="button" class="sd-btn" data-preview-zoom="in" aria-label="放大">＋</button><button type="button" class="sd-btn" data-preview-zoom="reset">恢复适配</button></nav>
        <details><summary>来源与详情</summary><p>${escape(preview.source.chatKey)}</p><p>${escape(preview.source.ownerKey)}</p><p>${escape(date(preview.record.createdAt))} · ${preview.width} × ${preview.height}</p><p>${escape(tags.join(' · '))}</p>
        ${button('recipe',recipe?'重新读取原配方':'读取原配方',busy)}
        <div data-archive-recipe>${galleryArchiveRecipeHtml(recipe)}</div>
        </details></main><footer><p role="status">${escape(notice||'不需要打开原聊天；图片文件本身仍需保留在 ST 中。')}</p></footer>`;
      releaseZoom=bindGalleryPreviewZoom(dialog,{...preview,isCurrent:alive});return;
    }
    const stack=selected?pageStack:versionStack,next=selected?page?.cursor:versions?.nextCursor;
    dialog.innerHTML=`<header><b>${escape(selected?selected.value.scope.chatKey:'已保存图库')}</b>${selected?button('versions','返回版本',busy):''}${button('close','关闭')}</header><main>
      <p>${selected?'按保存时的记录浏览；点开画面后才读取图片。':'只显示已完整保全到此 ST 账户的版本，不代表账户全部原作品。浏览不会新增保存或扫描聊天正文。'}</p>
      <fieldset ${busy||session?.isClosed()?'disabled':''}><nav>${button('refresh','刷新列表')}</nav>
      ${selected?`<form class="sd-directory-search" data-archive-search><input class="text_pole" type="search" name="tag" maxlength="80" value="${escape(tag)}" aria-label="完整标签" placeholder="按完整标签查找"><button type="submit" class="sd-btn">查找</button>${button('clear','清除',!tag)}</form>`:''}
      <div class="sd-directory-rows">${galleryArchiveListHtml({entries:versions?.entries,rows:page?.rows,selected,busy})||`<p>${busy?'正在读取…':notice?'未读取当前列表，请按下方提示处理。':selected?(page?.cursor?'本段没有匹配画面，可继续下一页。':'没有匹配画面。'):'暂无已保全版本；原聊天中的画面不受影响。'}</p>`}</div>
      <nav aria-label="已保存图库分页">${button('previous','上一页',stack.length===1)}<span>第 ${stack.length} 页</span>${button('next','下一页',!next)}</nav></fieldset>
      </main><footer><p role="status">${escape(notice)}</p></footer>`;
    const main=dialog.querySelector('main');if(main)main.scrollTop=restoreScroll??previousScroll;restoreScroll=null;
  }
  async function work(action){
    if(!alive()||busy)return;busy=true;notice='';draw();
    try{await action();if(!alive())return;}
    catch(error){if(alive()){
      if(session?.isClosed()){releaseImage();versions=null;page=null;selected=null;}
      notice=error?.message||'图库读取未完成，请重试';
    }}
    finally{busy=false;draw();}
  }
  async function loadVersions(){versions=await session.list({limit:24,cursor:versionStack.at(-1)});}
  async function loadPage(){page=await session.page({limit:24,cursor:pageStack.at(-1),tags:tag?[tag]:[]});}
  async function loadRecipe(){
    if(!alive()||busy||!preview)return;busy=true;const current=preview;
    const buttons=()=>dialog.querySelectorAll('[data-archive-action="recipe"],[data-archive-action="back"]');
    const status=message=>{if(alive())dialog.querySelector('footer [role="status"]').textContent=message;};
    for(const node of buttons())node.disabled=true;status('正在读取此画面的已保存配方…');
    try{
      const value=await session.recipe(current.record.id);if(!alive()||preview!==current)return;recipe=value;
      dialog.querySelector('[data-archive-recipe]').innerHTML=galleryArchiveRecipeHtml(recipe);status('配方只读查看，不会自动套用或提交生成。');
    }catch(error){
      if(!alive())return;
      if(session.isClosed()){releaseImage();versions=null;page=null;selected=null;notice=error.message;draw();}
      else status(error?.message||'原配方读取未完成，请重试');
    }finally{busy=false;if(alive())for(const node of buttons())node.disabled=false;}
    // Keep the image element, zoom, expanded details and current scroll intact.
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);
  dialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-archive-action]')?.dataset.archiveAction;
    if(action==='close'){close();return;}
    if(action==='recipe'){void loadRecipe();return;}
    const entry=event.target.closest('[data-archive-version]'),record=event.target.closest('[data-archive-record]');
    if(!action&&!entry&&!record)return;
    if(busy)return;
    if(entry)versionScroll=dialog.querySelector('main')?.scrollTop||0;
    if(record)pageScroll=dialog.querySelector('main')?.scrollTop||0;
    void work(async()=>{
      if(action==='back'){releaseImage();restoreScroll=pageScroll;return;}
      if(action==='versions'){selected=null;page=null;pageStack=[null];tag='';restoreScroll=versionScroll;return;}
      if(entry){
        const chosen=versions?.entries[Number(entry.dataset.archiveVersion)];if(!chosen)return;
        await session.open(chosen.key);if(!alive())return;selected=chosen;page=null;pageStack=[null];tag='';restoreScroll=0;await loadPage();
      }else if(record){
        const chosen=page?.rows[Number(record.dataset.archiveRecord)];if(!chosen)return;
        const result=await session.preview(chosen.recordId);if(!alive())return;
        releaseImage();url=view.URL.createObjectURL(result.blob);preview=result;
      }else if(action==='refresh'){
        restoreScroll=0;
        if(selected){pageStack=[null];page=null;await session.open(selected.key);await loadPage();}
        else{versionStack=[null];versions=null;await loadVersions();}
      }else if(action==='clear'){tag='';pageStack=[null];page=null;restoreScroll=0;await loadPage();}
      else if(action==='previous'||action==='next'){
        const stack=selected?pageStack:versionStack,next=selected?page?.cursor:versions?.nextCursor;
        if(action==='previous'&&stack.length>1)stack.pop();else if(action==='next'&&next)stack.push(next);else return;
        restoreScroll=0;
        if(selected){page=null;await loadPage();}else{versions=null;await loadVersions();}
      }
    });
  });
  dialog.addEventListener('submit',event=>{
    if(!event.target.matches('[data-archive-search]'))return;event.preventDefault();
    const value=new FormData(event.target).get('tag');void work(async()=>{tag=String(value||'').trim();pageStack=[null];page=null;restoreScroll=0;await loadPage();});
  });
  parent.append(dialog);observer.observe(document.body,{childList:true,subtree:true});observer.observe(parent,{attributes:true,attributeFilter:['class']});view.addEventListener('pagehide',close);
  try{session=connect({account,headers,isCurrent:alive});dialog.showModal();draw();void work(loadVersions);}
  catch(error){close();throw error;}
  return {close,finished};
}
