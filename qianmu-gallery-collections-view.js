import {htmlEscape as escape,snip} from './qianmu-storyboard-utils.js';
import {galleryDisplayWindow} from './qianmu-gallery-window.js';

// Metadata only. Image URLs are read only while painting a visible tile.
export function galleryCollectionEntries(collections,{summary,visible=summary,query='',restricted=false,otherFilters=false}={}) {
  const term=String(query||'').trim().toLocaleLowerCase();
  return collections.flatMap(collection=>{
    const count=visible.collectionCount(collection.id),nameMatch=Boolean(term&&String(collection.name||'').toLocaleLowerCase().includes(term));
    if(restricted&&!count&&(!nameMatch||otherFilters))return [];
    const clearSearch=Boolean(nameMatch&&!count&&!otherFilters);
    return [{kind:'collection',collection,clearSearch,count:clearSearch?summary.collectionCount(collection.id):count,
      matched:restricted&&!clearSearch,cover:(clearSearch?summary:visible).collectionPreview(collection.id)}];
  }).sort((a,b)=>(Number(b.collection.createdAt)||0)-(Number(a.collection.createdAt)||0));
}

// Interleave one collection with three image groups while both are available.
// Allocate wrappers only for the displayed page, keeping each source's own order.
// Collections and full image groups share the same 40-entry window; no group split.
export function galleryBrowserWindow(groups,collections,cursor){
  const length=collections.length+groups.length;
  const blocks=Math.min(collections.length,Math.floor(groups.length/3)),mixed=blocks*4;
  const atIndex=index=>{
    if(index<mixed){const block=Math.floor(index/4),offset=index%4;return offset?{kind:'image',group:groups[block*3+offset-1]}:collections[block];}
    const tail=index-mixed,images=groups.length-blocks*3,folders=collections.length-blocks;
    if(!folders)return {kind:'image',group:groups[blocks*3+tail]};
    if(images){if(!tail)return collections[blocks];if(tail<=images)return {kind:'image',group:groups[blocks*3+tail-1]};return collections[blocks+tail-images];}
    return collections[blocks+tail];
  };
  const window=galleryDisplayWindow({length,slice:(start,end)=>Array.from({length:Math.max(0,Math.min(length,end)-start)},(_,at)=>{
    return atIndex(start+at);
  })},cursor);
  return {...window,unit:collections.length?'项':'组'};
}

export function renderGalleryCollectionTile(entry,{safeUrl}){
  const {collection,cover,count,matched,clearSearch}=entry,url=cover?safeUrl(cover.url):'';
  return `<article class="sd-gallery-collection-tile" data-gallery-collection="${escape(collection.id)}" data-gallery-collection-clear-search="${clearSearch}">
    <button type="button" class="sd-media-collection-open" aria-label="打开合集：${escape(collection.name)}">${url?`<img src="${escape(url)}" loading="lazy" alt="">`:'<span class="sd-gallery-collection-empty"><i class="fa-regular fa-folder"></i></span>'}
      <span class="sd-gallery-collection-mark"><i class="fa-regular fa-folder"></i>合集</span><span class="sd-gallery-collection-caption"><b>${escape(collection.name)}</b><small>${count} ${matched?'张匹配':'张'}</small></span></button>
    <div class="sd-gallery-collection-actions">${renderGalleryCollectionActions()}</div></article>`;
}
export function renderGalleryCollectionActions(){
  return '<button type="button" class="sd-icon-btn sd-media-collection-rename" title="重命名合集" aria-label="重命名合集"><i class="fa-solid fa-pen"></i></button><button type="button" class="sd-icon-btn sd-media-collection-delete" title="解散合集（保留图片）" aria-label="解散合集（保留图片）"><i class="fa-solid fa-folder-minus"></i></button>';
}
export function renderGalleryCollectionPath(collection){
  if(!collection)return '';
  return `<div class="sd-gallery-collection-path" data-gallery-collection="${escape(collection.id)}"><button type="button" class="sd-icon-btn" data-gallery-root title="返回阅片室" aria-label="返回阅片室"><i class="fa-solid fa-arrow-left"></i></button><b>${escape(collection.name)}</b><div>${renderGalleryCollectionActions()}</div></div>`;
}

export function renderGalleryImageCard(group,{url='',status='',production={},sourceLabel='',timeLabel='',selectionMode=false,selection=new Set(),inspectedId=''}){
  const record=group.variants[0],memberIds=group.variants.map(item=>item.id),selected=memberIds.length>0&&memberIds.every(id=>selection.has(id));
  const tags=Array.isArray(record.tags)?record.tags:typeof record.tags==='string'&&record.tags?[record.tags]:[];
  const model=String(record.model||'').trim()||`${sourceLabel||'分镜'} · 模型未记录`;
  return `<article class="sd-storyboard-gallery-card ${selected?'selected':''} ${inspectedId===record.id?'inspected':''} ${group.variants.length>1?'is-stack':''}" data-storyboard-record="${escape(record.id)}" data-storyboard-group="${escape(group.id)}" data-storyboard-members="${escape(memberIds.join(','))}">
    ${selectionMode?`<button type="button" class="sd-storyboard-gallery-check" aria-label="${selected?'取消选择':'选择'}"><i class="fa-solid ${selected?'fa-square-check':'fa-square'}"></i></button>`:''}
    <button type="button" class="sd-storyboard-preview-record" ${url?'':'disabled'}>${url?`<img src="${escape(url)}" loading="lazy" alt="${escape(snip(record.prompt||'分镜',40))}">`:'<span class="sd-storyboard-image-missing"><i class="fa-solid fa-image"></i></span>'}
    <span class="sd-gallery-model-label" title="${escape(model)}">${escape(model)}</span>${group.variants.length>1?`<span class="sd-storyboard-stack-count">${group.variants.length}</span>`:''}</button>
    <div class="sd-storyboard-gallery-caption"><small>${escape(status||timeLabel)}</small><span class="sd-storyboard-production-label ${production.track==='second_camera'?'second-camera':''}">${escape(production.sourceLabel||'')}</span><p>${escape(snip(record.finalPrompt||record.prompt||'',110))}</p>${tags.length?`<div class="sd-storyboard-gallery-card-tags">${tags.slice(0,4).map(tag=>`<em>${escape(tag)}</em>`).join('')}</div>`:''}</div>
    <div class="sd-storyboard-gallery-actions"><button type="button" class="sd-icon-btn sd-storyboard-gallery-inspect" title="整理详情" aria-label="整理详情"><i class="fa-solid fa-circle-info"></i></button><button type="button" class="sd-icon-btn sd-storyboard-download" title="下载当前图片" aria-label="下载当前图片"><i class="fa-solid fa-download"></i></button>${Number.isInteger(record.floor)?`<button type="button" class="sd-icon-btn sd-storyboard-inline-toggle" title="${record.inline===false?'插回正文':'移出正文'}" aria-label="${record.inline===false?'插回正文':'移出正文'}"><i class="fa-solid ${record.inline===false?'fa-eye':'fa-eye-slash'}"></i></button>`:''}<button type="button" class="sd-icon-btn sd-danger sd-storyboard-delete-record" title="删除当前图片" aria-label="删除当前图片"><i class="fa-solid fa-trash-can"></i></button></div></article>`;
}
