import {htmlEscape as escape} from './qianmu-storyboard-utils.js';
import {createGalleryArchiveBrowser} from './qianmu-gallery-archive-browser.js?v=1.59.341';
import {bindGalleryPreviewZoom} from './qianmu-gallery-preview-zoom.js';

const button=(action,label,disabled=false)=>`<button type="button" class="sd-btn" data-archive-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
const date=value=>new Date(value).toLocaleString();
const recipeLabels={'not-preserved':'此版本尚未保全完整服务器配方；原引用保留。','local-reference':'旧本机配方尚未完成归属与内容核验；原引用保留，不借用其他账户缓存。',unavailable:'原记录明确标为未保留配方。',unresolved:'原记录的配方结构尚未核实，未使用当前设置补齐。','not-recorded':'原记录没有保存配方。'};
export function galleryArchiveRecipeHtml(recipe){
  return recipe?.state==='available'?`<p>${recipe.origin==='reviewed-local-copy'?'用户核对关联的旧配方副本；旧索引自身没有完整生成凭据':recipe.origin==='verified-local-copy'?'已核对原内容引用的旧配方副本':recipe.origin==='server-copy'?'已保全的服务器配方副本':'保全记录内的完整配方'}；不代表原模型仍可调用，此处不重绘或套用。</p><textarea class="text_pole" rows="10" readonly aria-label="原配方，只读">${escape(JSON.stringify(recipe.snapshot))}</textarea>`
    :recipe?`<p>${escape(recipeLabels[recipe.state]||'原配方尚未确认。')}</p>`:'';
}
export function galleryArchiveListHtml({entries=[],rows=[],selected=null,busy=false}={}){
  if(selected)return rows.map((row,index)=>`<button type="button" class="sd-directory-row" data-archive-record="${index}" ${busy?'disabled':''}><span><b>${escape(row.tags.join(' · ')||'静帧')}</b><small>${escape(date(row.createdAt))}</small></span><span>查看画面</span></button>`).join('');
  return entries.map((entry,index)=>`<button type="button" class="sd-directory-row" data-archive-version="${index}" ${busy?'disabled':''}><span><b>${escape(entry.value.scope.chatKey)}</b><small>${escape(entry.value.scope.ownerKey)} · ${entry.value.sourceReceipt.count} 张 · 版本 ${escape(entry.key.slice(0,8))}</small></span><span>打开</span></button>`).join('');
}

export function galleryArchiveReviewHtml(review){
  if(!review)return '';
  const verified=review.proof==='archive-originals-readback-only';
  const continuity=review.continuity?.state==='recorded'?`续写依据 ${Number(review.continuity.continuations)||0} · 换版依据 ${Number(review.continuity.retakes)||0}`:'旧版本未记录续写/换版依据是否完整；不会猜补。';
  return `<section aria-label="恢复资料核对"><b>恢复资料核对 · 只读</b><p>画面记录 ${review.total} · 完整配方 ${review.recipes.available}/${review.total} · 原图副本引用 ${review.originals.referenced}/${review.total}</p>
    ${verified?`<p>原图文件已核验 ${review.originals.verified}/${review.total} · 去重读取 ${review.originals.unique} 份</p>`:''}
    <p>合集 ${review.collections} · 角色草稿 ${review.characterDrafts} · 正文依据 ${review.evidenceFloors} 层</p><p>${continuity}</p><p>已按原保存顺序核验全部画面记录。${review.recipes.missing||review.originals.missing?'存在未保全的配方或原图引用，请保留原资料。':''}${verified?'本次已核验现有副本的文件大小、格式和摘要；仍不代表原路径已恢复。':'原图文件内容尚未逐张核验。'}正文依据不是全文备份；本次不会写回聊天或删除任何资料。</p></section>`;
}

export function galleryArchiveRestoreHtml(state,busy=false){
  if(!state)return '';
  if(['saved','restored'].includes(state.status))return `<section aria-label="恢复完成"><b>已恢复并核对完成</b><p>原聊天资料、原图及原配方均已读回核验。正文与其他设置未改动；原副本仍保留。</p>${button('restore-finish','完成并结束核对',busy)}</section>`;
  const reasons={reload_required:'服务器已保存，请重新载入原聊天后核对；不会重复保存。',local_conflict:'当前资料已编辑，请保留两份资料后核对。',server_conflict:'服务器资料与原方案不同，未覆盖。',needs_review:'保存尚未确认，请重新核对；不会自动重试。',host_pending:'ST 保存尚未结束，请稍后重新核对。'};
  if(state.status==='unconfirmed'&&!state.ready)return `<section aria-label="恢复待核对"><b>恢复尚未确认</b><p>${escape(reasons[state.reason]||'原件或保存尚未完整核实，请重新核对。')}</p>${button('restore-review','重新核对',busy)}</section>`;
  return `<section aria-label="确认恢复"><b>${state.mode==='recovery'?'核对上次恢复':'恢复至原聊天'}</b><p>新增 ${state.added} 张 · 保留相同 ${state.kept} 张 · 合计 ${state.total} 张</p>
    ${state.assets?`<p>需补回原图 ${state.assets.missing} 份 · 冲突 ${state.assets.conflicts} 份</p>`:''}<small>恢复所选静帧、合集、角色草稿及已保全的续写/换版依据；来源冲突不覆盖，不改正文或全局设置，不安装模型/节点，不重新生成。此操作可能需要一些时间，不能据此删除原件。</small>
    ${button('restore-confirm',state.mode==='recovery'?'确认重试原恢复':'确认恢复',busy||!state.ready)}${button('restore-cancel','暂不恢复',busy)}</section>`;
}

// Kept inside the existing still-gallery dialog family. Only an explicit image
// click fetches media; back navigation uses the already loaded small list.
export function openGalleryArchive({parent,account,headers,isCurrent=()=>true,getContext,epoch,canPrepare,locate,connect=createGalleryArchiveBrowser}={}){
  const document=parent.ownerDocument,view=document.defaultView,returnFocus=document.activeElement;
  const dialog=document.createElement('dialog');dialog.className='sd-bundle-dialog sd-gallery-directory sd-gallery-archive';
  dialog.setAttribute('aria-label','已保存图库');
  let closed=false,busy=false,notice='',session,selected=null,preview=null,url='',releaseZoom,recipe=null;
  let versions=null,page=null,versionStack=[null],pageStack=[null],tag='',resolve,review=null,prepared=null;
  let versionScroll=0,pageScroll=0,restoreScroll=null,restoreState=null,restored=false,locating=null,revealing=false;
  const finished=new Promise(done=>resolve=done);
  function releaseImage(){releaseZoom?.();releaseZoom=null;if(url)view.URL.revokeObjectURL(url);url='';preview=null;recipe=null;}
  function close(){
    if(closed)return;closed=true;if(!revealing)locating?.abort();observer.disconnect();view.removeEventListener('pagehide',close);session?.close();releaseImage();
    if(dialog.open)dialog.close();dialog.remove();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});resolve({restored});
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
        <nav><button type="button" class="sd-btn" data-preview-zoom="out" aria-label="缩小">−</button><span data-preview-scale>100%</span><button type="button" class="sd-btn" data-preview-zoom="in" aria-label="放大">＋</button><button type="button" class="sd-btn" data-preview-zoom="reset">恢复适配</button>${typeof locate==='function'?button('locate','回到正文',busy):''}</nav>
        <details><summary>来源与详情</summary><p>${escape(preview.source.chatKey)}</p><p>${escape(preview.source.ownerKey)}</p><p>${escape(date(preview.record.createdAt))} · ${preview.width} × ${preview.height}</p><p>${escape(tags.join(' · '))}</p>
        ${button('recipe',recipe?'重新读取原配方':'读取原配方',busy)}
        <div data-archive-recipe>${galleryArchiveRecipeHtml(recipe)}</div>
        </details></main><footer><p role="status">${escape(notice||(preview.mediaOrigin==='server-copy'?'已读取此账户保全的原图副本；不会改动原聊天或原图片。':'不需要打开原聊天；此图尚无独立副本，ST 原图片文件仍须保留。'))}</p></footer>`;
      releaseZoom=bindGalleryPreviewZoom(dialog,{...preview,isCurrent:alive});return;
    }
    const stack=selected?pageStack:versionStack,next=selected?page?.cursor:versions?.nextCursor;
    dialog.innerHTML=`<header><b>${escape(selected?selected.value.scope.chatKey:'已保存图库')}</b>${selected?button('versions','返回版本',busy):''}${button('close','关闭')}</header><main>
      <p>${selected?'按保存时的记录浏览；点开画面后才读取图片。':'只显示已完整保全到此 ST 账户的版本，不代表账户全部原作品。浏览不会新增保存或扫描聊天正文。'}</p>
      <fieldset ${busy||session?.isClosed()?'disabled':''}><nav>${button('refresh','刷新列表')}${selected?button('review','核对恢复资料',busy)+button('restore-review','核对上次恢复',busy):''}</nav>
      ${selected?galleryArchiveReviewHtml(review):''}
      ${selected&&review?`<nav>${button('originals','核验原图',busy)}${button('prepare','准备恢复资料',busy)}<small>核验原图需要更多时间和流量；准备恢复会先保全当前准确原聊天的资料，不写回聊天。关闭可取消。</small></nav>`:''}
      ${selected&&prepared?`<section aria-label="恢复准备结果">${prepared.compatible?`<b>恢复资料已准备 · 尚未执行恢复</b><p>保留当前记录，新增 ${prepared.added} 张 · 相同 ${prepared.kept} 张 · 合计 ${prepared.total} 张</p><small>准备方案已存入 ST 账户；原图、配方的恢复与正式写回仍需后续核验。不能据此删除原资料。</small>`:`<b>存在 ${prepared.conflicts} 项冲突，未生成可用准备方案</b><p>同编号内容或关联资料不同，未覆盖当前记录；已保存的资料副本保留。</p>`}</section>`:''}
      ${selected&&prepared?.compatible&&!restoreState?button('restore-review','核对并恢复',busy):''}${selected?galleryArchiveRestoreHtml(restoreState,busy):''}
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
      prepared=null;restoreState=null;notice=error?.message||'图库读取未完成，请重试';
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
  async function locatePreview(){
    if(!alive()||busy||!preview||typeof locate!=='function')return;busy=true;const selected=preview,controller=new AbortController();locating=controller;
    const buttons=()=>dialog.querySelectorAll('[data-archive-action="locate"],[data-archive-action="back"],[data-archive-action="recipe"]');
    const status=value=>{if(alive())dialog.querySelector('footer [role="status"]').textContent=value;};
    for(const button of buttons())button.disabled=true;status('正在核对原聊天及正文位置…不会修复链接或重新生成。');
    try{
      const sourceFields=['id','chatKey','messageRef','paragraphAnchor','messageHash','swipeId','restoreLinkReview','worldReference','target'];
      const record=structuredClone(Object.fromEntries(sourceFields.filter(key=>Object.hasOwn(selected.record,key)).map(key=>[key,selected.record[key]])));
      const loadContinuity=async({signal}={})=>{
        const check=()=>{if(signal?.aborted||controller.signal.aborted||!alive()||preview!==selected)throw Error('画面定位已取消');};check();
        const result=await session.supplement();check();if(result?.state==='not-preserved'||result?.receipt?.version===1)return null;
        if(result?.state!=='available'||result.receipt?.version!==2||!result.receipt.order?.includes(record.id))throw Error('所选版本的续写依据未能核对');
        return {scope:structuredClone(selected.source),links:structuredClone(result.receipt.saved.storyboardContinuations??[])};
      };
      const result=await locate({record,scope:structuredClone(selected.source),loadContinuity},
        {signal:controller.signal,beforeReveal:()=>{if(!alive()||preview!==selected)throw Error('画面已切换，未定位');revealing=true;close();}});
      if(result?.status==='cancelled')status('已取消加载，原画面保留。');
    }catch(error){status(error?.message||'正文位置未能确认，原画面保留。');}
    finally{busy=false;if(locating===controller)locating=null;if(alive())for(const button of buttons())button.disabled=false;}
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);
  dialog.addEventListener('click',event=>{
    const action=event.target.closest('[data-archive-action]')?.dataset.archiveAction;
    if(action==='close'){close();return;}
    if(action==='recipe'){void loadRecipe();return;}
    if(action==='locate'){void locatePreview();return;}
    const entry=event.target.closest('[data-archive-version]'),record=event.target.closest('[data-archive-record]');
    if(!action&&!entry&&!record)return;
    if(busy)return;
    if(entry)versionScroll=dialog.querySelector('main')?.scrollTop||0;
    if(record)pageScroll=dialog.querySelector('main')?.scrollTop||0;
    void work(async()=>{
      if(action==='back'){releaseImage();restoreScroll=pageScroll;return;}
      if(action==='versions'){selected=null;page=null;pageStack=[null];tag='';review=null;prepared=null;restoreState=null;restoreScroll=versionScroll;return;}
      if(action==='restore-cancel'){restoreState=null;return;}
      if(action==='restore-review'){
        restoreState=null;restoreState=await session.restorePreview({onProgress:({completed,total})=>{if(alive())dialog.querySelector('footer [role="status"]').textContent=`正在核对原件 ${completed??0}/${total??0}；未自动写回聊天。`;}});if(alive()&&restoreState.status==='saved')restored=true;return;
      }
      if(action==='restore-confirm'){
        if(!restoreState?.ready)return;const digest=restoreState.digest;restoreState=null;
        restoreState=await session.restore({confirmed:true,expectedDigest:digest});prepared=null;if(alive()&&restoreState.status==='restored')restored=true;notice=restoreState.status==='restored'?'恢复已完成，并已核对服务器上的原件与聊天资料。':'恢复尚未确认；请先重新核对，不会自动重复提交。';return;
      }
      if(action==='restore-finish'){await session.finishRestore();restoreState=null;prepared=null;notice='恢复核对已结束；原图、配方和副本保留。';return;}
      if(action==='prepare'){
        prepared=null;restoreState=null;const result=await session.prepare({onProgress:({phase,completed,total})=>{if(alive())dialog.querySelector('footer [role="status"]').textContent=phase==='preserving'?'正在保全当前聊天基线；关闭可取消。':`正在${phase==='baseline'?'核对当前基线':'合并历史记录'} ${completed}/${total}；不会改写聊天。`;}});
        if(alive()){prepared=result;notice=result.compatible?'准备资料已保存，当前聊天未修改。':'发现冲突，当前聊天未修改。';}return;
      }
      if(action==='review'||action==='originals'){
        prepared=null;restoreState=null;review=null;const result=await session.review({verifyOriginals:action==='originals',onProgress:({phase,completed,total,verified})=>{if(alive())dialog.querySelector('footer [role="status"]').textContent=phase==='originals'?`原图文件已核验 ${verified}/${total}；关闭窗口可取消。`:`正在按原顺序核对恢复资料 ${completed}/${total}；关闭窗口可取消。`;}});
        if(alive()){review=result;notice=action==='originals'?'本次原图副本核验结束；尚未执行恢复。':'核对完成；尚未执行恢复或验证原图文件。';}return;
      }
      if(entry){
        const chosen=versions?.entries[Number(entry.dataset.archiveVersion)];if(!chosen)return;
        prepared=null;restoreState=null;review=null;await session.open(chosen.key);if(!alive())return;selected=chosen;page=null;pageStack=[null];tag='';restoreScroll=0;await loadPage();
      }else if(record){
        const chosen=page?.rows[Number(record.dataset.archiveRecord)];if(!chosen)return;
        const result=await session.preview(chosen.recordId);if(!alive())return;
        releaseImage();url=view.URL.createObjectURL(result.blob);preview=result;
      }else if(action==='refresh'){
        restoreScroll=0;review=null;prepared=null;restoreState=null;
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
  try{session=connect({account,headers,isCurrent:alive,getContext,epoch,canPrepare});dialog.showModal();draw();void work(loadVersions);}
  catch(error){close();throw error;}
  return {close,finished};
}
