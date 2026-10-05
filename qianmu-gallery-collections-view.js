import {htmlEscape as escape} from './qianmu-storyboard-utils.js';
import {galleryDisplayWindow} from './qianmu-gallery-window.js';
import {galleryMembershipIds} from './qianmu-gallery-membership.js';

// Source names belong to the saved picture, never whichever character is open now.
export function galleryRecordSourceCharacter(record,location,{snapshot}={}){
  const ref=record?.messageRef;
  return String(record?.sourceCharacterName|| (ref?.role==='assistant'?ref.name:'') || snapshot?.sourceCharacterName
    || (snapshot?.messageRef?.role==='assistant'?snapshot.messageRef.name:'') || location?.name || '').trim();
}
export function galleryBrowserProjection(records,manualCollections,{sourceFor=()=>null}={}){
  const names=new Map(),locations=new Map(),automatic=new Map(),counts=new Map(),ids=new Set(manualCollections.map(row=>row.id));
  for(const record of records){
    const location=sourceFor(record),name=galleryRecordSourceCharacter(record,location);locations.set(record,location);names.set(record,name);
    if(name)counts.set(name,(counts.get(name)||0)+1);
    if(name&&!automatic.has(name)){
      let id=`source-char:${encodeURIComponent(name)}`;while(ids.has(id))id=`source-char:${id}`;ids.add(id);
      automatic.set(name,{id,name,automatic:true,createdAt:Number(record.createdAt)||0});
    }
  }
  for(const name of automatic.keys())if(counts.get(name)<2)automatic.delete(name);
  const memberships=record=>{const collection=automatic.get(names.get(record));return [...galleryMembershipIds(record),...(collection?[collection.id]:[])];};
  const collections=[...automatic.values(),...manualCollections];
  return {collections,collectionNames:new Map(collections.map(row=>[row.id,row.name])),memberships,sourceName:record=>names.get(record)||'',location:record=>locations.get(record)};
}
export function galleryRecordMatchesQuery(record,query,{collections=[],collectionNames,memberships=galleryMembershipIds,location,sourceLabel='',production={}}={}){
  const term=String(query||'').trim().toLocaleLowerCase();if(!term)return true;
  const tags=Array.isArray(record.tags)?record.tags:record.tags?[record.tags]:[];
  const source=production.track==='main_camera'?'正文主线':production.sourceLabel;
  const names=new Set(memberships(record));
  return [record.prompt,record.finalPrompt,record.model,record.artistString,...tags,sourceLabel,source,
    galleryRecordSourceCharacter(record,location),record.paragraphAnchor?.paragraphText,location?.paragraphText,
    ...(Array.isArray(record.shotSpec?.characters)?record.shotSpec.characters.map(row=>row.name):[]),
    Number.isInteger(location?.floor)?`第 ${location.floor+1} 层 第${location.floor+1}层 ${location.floor+1}`:'',
    ...(collectionNames?[...names].map(id=>collectionNames.get(id)):collections.filter(row=>names.has(row.id)).map(row=>row.name))]
    .some(value=>String(value||'').toLocaleLowerCase().includes(term));
}

// Metadata only. Image URLs are read only while painting a visible tile.
export function galleryCollectionEntries(collections,{summary,visible=summary,query='',restricted=false,otherFilters=false}={}) {
  const term=String(query||'').trim().toLocaleLowerCase();
  return collections.flatMap(collection=>{
    const count=visible.collectionCount(collection.id),nameMatch=Boolean(term&&String(collection.name||'').toLocaleLowerCase().includes(term));
    if(restricted&&!count&&(!nameMatch||otherFilters))return [];
    const clearSearch=Boolean(nameMatch&&!count&&!otherFilters);
    return [{kind:'collection',collection,clearSearch,count:clearSearch?summary.collectionCount(collection.id):count,
      matched:restricted&&!clearSearch,cover:(clearSearch?summary:visible).collectionPreview(collection.id),covers:(clearSearch?summary:visible).collectionPreviews(collection.id)}];
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
  const {collection,cover,count,matched,clearSearch}=entry;
  const urls=(entry.covers||[cover]).filter(Boolean).slice(0,4).map(record=>safeUrl(record.url));
  const mosaic=Array.from({length:4},(_,index)=>`<span>${urls[index]?`<img src="${escape(urls[index])}" loading="lazy" alt="">`:''}</span>`).join('');
  return `<article class="sd-gallery-collection-tile" data-gallery-collection="${escape(collection.id)}" data-gallery-collection-clear-search="${clearSearch}">
    <button type="button" class="sd-media-collection-open" aria-label="打开合集：${escape(collection.name)}"><span class="sd-gallery-collection-mosaic ${urls.some(Boolean)?'':'sd-gallery-collection-empty'}">${mosaic}</span>
      <span class="sd-gallery-collection-caption"><b>${escape(collection.name)}</b><small>${count} ${matched?'张匹配':'张'}</small></span></button>
    ${collection.automatic?'':`<div class="sd-gallery-collection-actions">${renderGalleryCollectionActions()}</div>`}</article>`;
}
export function renderGalleryCollectionActions(){
  return '<button type="button" class="sd-icon-btn sd-media-collection-rename" title="重命名合集" aria-label="重命名合集"><i class="fa-solid fa-pen"></i></button><button type="button" class="sd-icon-btn sd-media-collection-delete" title="解散合集（保留图片）" aria-label="解散合集（保留图片）"><i class="fa-solid fa-folder-minus"></i></button>';
}
export function renderGalleryCollectionPath(collection){
  if(!collection)return '';
  return `<div class="sd-gallery-collection-path" data-gallery-collection="${escape(collection.id)}"><button type="button" class="sd-icon-btn" data-gallery-root title="返回阅片室" aria-label="返回阅片室"><i class="fa-solid fa-arrow-left"></i></button><b>${escape(collection.name)}</b>${collection.automatic?'':`<div>${renderGalleryCollectionActions()}</div>`}</div>`;
}

export function renderGalleryImageCard(group,{url='',production={},sourceLabel='',sourceCharacter='',selectionMode=false,selection=new Set(),inspectedId=''}){
  const record=group.variants[0],memberIds=group.variants.map(item=>item.id),selected=memberIds.length>0&&memberIds.every(id=>selection.has(id));
  const tags=Array.isArray(record.tags)?record.tags:typeof record.tags==='string'&&record.tags?[record.tags]:[];
  const source=production.track==='main_camera'?'正文主线':production.sourceLabel||'';
  return `<article class="sd-storyboard-gallery-card ${selected?'selected':''} ${selectionMode?'is-selecting':''} ${inspectedId===record.id?'inspected':''} ${group.variants.length>1?'is-stack':''}" data-storyboard-record="${escape(record.id)}" data-storyboard-group="${escape(group.id)}" data-storyboard-members="${escape(memberIds.join(','))}" ${selectionMode?`tabindex="0" role="checkbox" aria-checked="${selected}" aria-label="选择画面"`:''}>
    <button type="button" class="sd-storyboard-preview-record" aria-label="${selectionMode?'选择画面':'打开画面详情'}" ${selectionMode?'tabindex="-1"':''} ${url||selectionMode?'':'disabled'}>${url?`<img src="${escape(url)}" loading="lazy" alt="插画">`:'<span class="sd-storyboard-image-missing"><i class="fa-solid fa-image"></i></span>'}
    ${group.variants.length>1?`<span class="sd-storyboard-stack-count">${group.variants.length}</span>`:''}</button>
    <div class="sd-storyboard-gallery-caption"><span class="sd-storyboard-production-label ${production.track==='second_camera'?'second-camera':''}">${escape([sourceCharacter,source].filter(Boolean).join(' · '))}</span>${tags.length?`<div class="sd-storyboard-gallery-card-tags" title="${escape(tags.join(' · '))}">${tags.slice(0,3).map(tag=>`<em>${escape(tag)}</em>`).join('')}${tags.length>3?`<em class="sd-gallery-card-tag-overflow" aria-label="${escape(tags.slice(3).join(' · '))}">…</em>`:''}</div>`:''}</div></article>`;
}
