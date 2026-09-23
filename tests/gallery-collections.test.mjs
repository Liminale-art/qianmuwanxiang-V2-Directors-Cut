import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {galleryCollectionEntries,galleryBrowserWindow,renderGalleryCollectionTile,renderGalleryCollectionPath,renderGalleryImageCard} from '../qianmu-gallery-collections-view.js';
import {summarizeGalleryRecords} from '../qianmu-gallery-summary.js';
import {renderGalleryWindowControls} from '../qianmu-gallery-window.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const summarize=rows=>summarizeGalleryRecords(rows,row=>row.collectionIds||[]);
const key=entry=>entry.kind==='image'?entry.group.id:entry.collection.id;
function sources(images,folders){return {groups:Array.from({length:images},(_,i)=>({id:'i'+i,variants:[{id:'r'+i}]})),
  collections:Array.from({length:folders},(_,i)=>({kind:'collection',collection:{id:'c'+i}}))};}

test('actual collection reader keeps all valid stored collections beyond the legacy 120 cap, including later additions',()=>{
  const rows=Array.from({length:5001},(_,i)=>({id:'c'+i,name:'Collection '+i,future:{retained:i}})),store={storyboardCollections:rows};
  const c=vm.createContext({getChatStore:()=>store});vm.runInContext(section('storyboardGalleryCollections'),c);
  assert.deepEqual(c.storyboardGalleryCollections(),rows);assert.equal(store.storyboardCollections.length,5001);
  const added={id:'last',name:'Last'};c.storyboardGalleryCollections().push(added);
  assert.equal(c.storyboardGalleryCollections().length,5002);assert.equal(store.storyboardCollections.at(-1),added);
  assert.equal(store.storyboardCollections[5000],rows[5000]);
});

for(const [images,folders] of [[0,0],[1,0],[0,1],[1,100],[2,100],[3,100],[4,2],[5,2],[100,1],[81,0],[0,81],[5001,3003]])
test(`mixed window ${images} images/${folders} folders visits every entry exactly once without changing source order`,()=>{
  const {groups,collections}=sources(images,folders),seen=[];
  for(let cursor=40;;){const page=galleryBrowserWindow(groups,collections,cursor);assert.ok(page.items.length<=40);
    assert.equal(page.total,images+folders);assert.ok(page.items.every(Boolean));seen.push(...page.items);if(page.next===null)break;cursor=page.next;}
  assert.equal(new Set(seen.map(key)).size,images+folders);
  assert.deepEqual(seen.filter(e=>e.kind==='image').map(e=>e.group),groups);
  assert.deepEqual(seen.filter(e=>e.kind==='collection'),collections);
});

test('window interleaves collections and full variant groups and clamps a removed final page',()=>{
  const {groups,collections}=sources(81,2);groups[0].variants=Array.from({length:121},(_,i)=>({id:'v'+i}));
  const page=galleryBrowserWindow(groups,collections,40);assert.deepEqual(page.items.slice(0,8).map(key),['c0','i0','i1','i2','c1','i3','i4','i5']);
  assert.equal(page.items[1].group,groups[0]);assert.equal(page.items[1].group.variants.length,121);
  assert.match(renderGalleryWindowControls(page),/1–40 \/ 83 项/);
  assert.match(renderGalleryWindowControls(galleryBrowserWindow(groups,[],40)),/1–40 \/ 81 组/);
  groups.splice(30);const clamped=galleryBrowserWindow(groups,collections,120);assert.equal(clamped.cursor,40);assert.equal(clamped.total,32);
});

test('large sources allocate/access only current page wrappers',()=>{
  let accesses=0;const source=(length,kind)=>new Proxy({length},{get(target,key){if(key==='length')return length;
    if(/^\d+$/.test(String(key))){accesses++;return kind==='image'?{id:'i'+key}:{kind:'collection',collection:{id:'c'+key}};}
    assert.fail('unexpected whole source traversal '+String(key));}});
  const page=galleryBrowserWindow(source(100000,'image'),source(80000,'collection'),80000);assert.equal(page.items.length,40);assert.equal(accesses,40);
});

test('collection metadata includes empty folders, recent cover and stable creation ordering without reading payloads',()=>{
  const latest={id:'new',collectionIds:['a']},old={id:'old',collectionIds:['a','b']};
  for(const row of [latest,old])for(const field of ['url','snapshot','prompt'])Object.defineProperty(row,field,{get(){assert.fail(field+' must be deferred');}});
  const summary=summarize([latest,old]),collections=[{id:'empty',name:'Empty'},{id:'b',name:'B',createdAt:2},{id:'a',name:'A',createdAt:2}];
  const entries=galleryCollectionEntries(collections,{summary});assert.deepEqual(entries.map(e=>e.collection.id),['b','a','empty']);
  assert.equal(entries[1].cover,latest);assert.equal(entries[1].count,2);assert.equal(entries[2].cover,null);assert.equal(entries[2].count,0);
});

test('name-only search can enter full contents, whereas tag/track/narrative restrictions never widen',()=>{
  const row={id:'one',collectionIds:['a']},summary=summarize([row]),visible=summarize([]),collection={id:'a',name:'Ocean memories'};
  const entries=galleryCollectionEntries([collection],{summary,visible,query:' OCEAN ',restricted:true});
  assert.equal(entries.length,1);assert.equal(entries[0].clearSearch,true);assert.equal(entries[0].cover,row);assert.equal(entries[0].count,1);assert.equal(entries[0].matched,false);
  assert.equal(galleryCollectionEntries([collection],{summary,visible,query:'OCEAN',restricted:true,otherFilters:true}).length,0);
  assert.equal(galleryCollectionEntries([collection],{summary,visible,query:'mountain',restricted:true}).length,0);
  const matched=galleryCollectionEntries([collection],{summary,visible:summary,query:'Ocean',restricted:true,otherFilters:true})[0];
  assert.equal(matched.clearSearch,false);assert.equal(matched.matched,true);assert.equal(matched.count,1);
});

test('filtered collection cover/count use only matching members without mutating stored records',()=>{
  const rows=[{id:'new',collectionIds:['a']},{id:'old',collectionIds:['a']}],before=JSON.stringify(rows);
  const entry=galleryCollectionEntries([{id:'a',name:'A'}],{summary:summarize(rows),visible:summarize([rows[1]]),restricted:true})[0];
  assert.equal(entry.cover,rows[1]);assert.equal(entry.count,1);assert.equal(JSON.stringify(rows),before);
});

test('visible collection tile escapes metadata, validates URL, leaves image ratio intact, and empty folders remain operable',()=>{
  const entry={collection:{id:'"',name:'<script>'},count:1,cover:{url:'unsafe'},clearSearch:true};let calls=0;
  const html=renderGalleryCollectionTile(entry,{safeUrl:value=>{assert.equal(value,'unsafe');calls++;return '';}});
  assert.equal(calls,1);assert.doesNotMatch(html,/<script>|src="unsafe"/);assert.match(html,/&lt;script&gt;/);assert.match(html,/sd-gallery-collection-empty/);
  assert.match(html,/data-gallery-collection-clear-search="true"/);assert.match(html,/sd-media-collection-open/);assert.match(html,/保留图片/);
  assert.match(renderGalleryCollectionTile({...entry,cover:{url:'/ok.png'}},{safeUrl:value=>value}),/src="\/ok.png" loading="lazy"/);
  assert.equal(renderGalleryCollectionPath(null),'');assert.match(renderGalleryCollectionPath(entry.collection),/data-gallery-root/);
});

test('image card model badge uses recorded model only, escapes text and retains complete group selection',()=>{
  const group={id:'g',variants:[{id:'a',source:'novel',model:'<model>',tags:'legacy',floor:0},{id:'b'}]},before=JSON.stringify(group);
  const html=renderGalleryImageCard(group,{url:'/ok',selectionMode:true,selection:new Set(['a','b'])});
  assert.match(html,/data-storyboard-members="a,b"/);assert.match(html,/fa-square-check/);assert.match(html,/sd-gallery-model-label" title="&lt;model&gt;"/);
  assert.match(html,/<em>legacy<\/em>/);assert.equal(JSON.stringify(group),before);assert.match(html,/sd-storyboard-stack-count">2/);
  assert.match(renderGalleryImageCard({id:'x',variants:[{id:'x'}]},{sourceLabel:'ComfyUI'}),/ComfyUI · 模型未记录/);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');assert.match(css,/\.sd-gallery-model-label \{[^}]*top: 8px; right: 8px/);
  assert.match(css,/\.sd-gallery-browser-main \.sd-storyboard-gallery \{ columns: 2 118px/);
});

function navigation(){
  const f={owner:{},key:'chat',state:{gallerySearch:'Ocean',galleryTrack:'all',galleryTagFilters:['blue']},renders:0,focus:0};
  const collections=[{id:'a'},{id:'b'}],body={scrollTop:641},target={focus:({preventScroll})=>{assert.equal(preventScroll,true);f.focus++;}};
  const root={querySelector:()=>target,querySelectorAll:()=>collections.map(collection=>({dataset:{galleryCollection:collection.id},querySelector:()=>target}))};
  const c=vm.createContext({storyboardGalleryCollections:()=>collections,storyboardState:()=>f.state,ctx:()=>({chatMetadata:f.owner}),getChatKey:()=>f.key,
    storyboardAdmissionEpoch:1,storyboardGalleryCollectionReturn:null,storyboardGalleryOpenCollectionId:'',storyboardGalleryInspectorRecordId:'selected',
    storyboardGalleryVisibleCount:80,storyboardScroller:()=>body,storyboardRememberPageScroll:()=>{},storyboardPendingRestoreScroll:null,
    renderModal:()=>{f.renders++;body.scrollTop=c.storyboardPendingRestoreScroll;}});
  vm.runInContext(['storyboardShowGalleryCollection','storyboardLeaveGalleryCollection'].map(section).join('\n'),c);
  return Object.assign(f,{c,collections,body,root});
}
test('actual collection round-trip restores page, scroll and a copied set of filters after name-only entry',()=>{
  const f=navigation(),tags=f.state.galleryTagFilters;f.c.storyboardShowGalleryCollection(f.root,f.collections[0],true);
  assert.equal(f.state.gallerySearch,'');assert.equal(f.c.storyboardGalleryVisibleCount,40);assert.equal(f.body.scrollTop,0);assert.equal(f.c.storyboardGalleryInspectorRecordId,'');
  tags.push('changed');f.state.galleryTrack='second_camera';f.c.storyboardGalleryVisibleCount=120;f.body.scrollTop=91;
  f.c.storyboardLeaveGalleryCollection(f.root);assert.equal(f.state.gallerySearch,'Ocean');assert.equal(f.state.galleryTrack,'all');
  assert.deepEqual(Array.from(f.state.galleryTagFilters),['blue']);assert.equal(f.c.storyboardGalleryVisibleCount,80);assert.equal(f.body.scrollTop,641);assert.equal(f.focus,2);
});
test('creating/switching another collection retains original root return rather than manufacturing nested hierarchy',()=>{
  const f=navigation();f.c.storyboardShowGalleryCollection(f.root,f.collections[0],true);f.body.scrollTop=123;
  f.c.storyboardShowGalleryCollection(f.root,f.collections[1],true);f.c.storyboardLeaveGalleryCollection(f.root);
  assert.equal(f.body.scrollTop,641);assert.equal(f.c.storyboardGalleryVisibleCount,80);assert.equal(f.state.gallerySearch,'Ocean');
});
for(const [label,change] of Object.entries({owner:f=>f.owner={},chat:f=>f.key='other',epoch:f=>f.c.storyboardAdmissionEpoch++,state:f=>f.state={...f.state}}))
test(`actual return never restores ${label}-foreign browsing state`,()=>{
  const f=navigation();f.c.storyboardShowGalleryCollection(f.root,f.collections[0],true);change(f);f.state.gallerySearch='current';
  f.c.storyboardLeaveGalleryCollection(f.root);assert.equal(f.state.gallerySearch,'current');assert.equal(f.c.storyboardGalleryVisibleCount,40);assert.equal(f.body.scrollTop,0);
});
test('removed collection cannot be entered by an old object reference',()=>{
  const f=navigation();f.c.storyboardShowGalleryCollection(f.root,{id:'a'},true);assert.equal(f.renders,0);assert.equal(f.state.gallerySearch,'Ocean');
});

class Node {
  constructor(dataset={}){this.dataset=dataset;this.isConnected=true;this.listeners={};this.value='';}
  addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
  async fire(name='click'){return Promise.all((this.listeners[name]||[]).map(callback=>callback({target:this,currentTarget:this})));}
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function events(){
  const record={id:'one',collectionIds:['a','b']},collection={id:'a',name:'First'},store={storyboardImages:[record],storyboardCollections:[collection]};
  const f={current:true,store,record,collection,saves:0,renders:0,opens:0,leaves:0,prompt:async()=> 'Renamed',confirm:async()=>true,timer:null};
  const selectors=['.sd-storyboard-gallery-search','.sd-storyboard-gallery-track','[data-gallery-root]',
    '.sd-storyboard-gallery-new-folder','.sd-storyboard-gallery-select-mode','.sd-storyboard-gallery-select-all',
    '.sd-storyboard-gallery-delete-selected','.sd-storyboard-gallery-move-selected','.sd-storyboard-gallery-move-target'];
  const nodes=Object.fromEntries(selectors.map(selector=>[selector,new Node()])),buttons=Object.fromEntries(['open','rename','delete'].map(name=>[name,new Node()]));
  const card=new Node({galleryCollection:'a',galleryCollectionClearSearch:'true'}),tag=new Node({galleryTagFilter:'blue'});
  card.querySelector=selector=>buttons[selector.replace('.sd-media-collection-','')];
  const root={querySelector:selector=>nodes[selector]||null,querySelectorAll:selector=>selector==='[data-gallery-collection]'?[card]:selector==='[data-gallery-tag-filter]'?[tag]:[]};
  const state={gallerySearch:'',galleryTagFilters:[]};
  const c=vm.createContext({root,state,storyboardState:()=>state,storyboardGalleryViewGuard:()=>node=>f.current&&node.isConnected,
    storyboardGalleryCollections:()=>store.storyboardCollections,storyboardGalleryRecords:()=>store.storyboardImages,
    storyboardFilteredGalleryRecords:()=>store.storyboardImages,storyboardItemCollectionIds:row=>row.collectionIds||[],
    storyboardAssignCollectionIds:(row,ids)=>row.collectionIds=[...new Set(ids)],getChatStore:()=>store,
    saveMetadata:async()=>f.saves++,saveSettings:()=>{},renderModal:()=>f.renders++,toast:()=>{},uid:()=> 'new',
    promptInput:()=>f.prompt(),confirmDialog:()=>f.confirm(),storyboardShowGalleryCollection:(_root,item,clear)=>{f.opens++;f.opened={item,clear};},
    storyboardLeaveGalleryCollection:()=>f.leaves++,storyboardBindGalleryInspector:()=>{},storyboardGalleryOpenCollectionId:'',
    storyboardGalleryInspectorRecordId:'',storyboardGalleryVisibleCount:80,storyboardGallerySelection:new Set(['one']),storyboardGallerySelectMode:true,
    storyboardDeleteRecordSnapshots:()=>{},storyboardRenderInlineImages:()=>{},toggleGalleryTag:()=>['blue'],
    clearTimeout:()=>{f.timer=null;},setTimeout:callback=>{f.timer=callback;return 1;}});
  const source=section('bindStoryboardTabEvents');vm.runInContext(source.slice(source.indexOf('  let gallerySearchTimer = null;'),source.indexOf('  bindGalleryWindowControls(root,')),c);
  return Object.assign(f,{c,root,nodes,buttons,card,tag,state});
}
test('actual live collection events open full name match, rename and dissolve only membership, preserving images',async()=>{
  const f=events();await f.buttons.open.fire();assert.equal(f.opened.item,f.collection);assert.equal(f.opened.clear,true);
  await f.buttons.rename.fire();assert.equal(f.collection.name,'Renamed');assert.equal(f.saves,1);
  f.c.storyboardGalleryOpenCollectionId='a';await f.buttons.delete.fire();assert.equal(f.store.storyboardCollections.length,0);
  assert.equal(f.store.storyboardImages[0],f.record);assert.deepEqual(f.record.collectionIds,['b']);assert.equal(f.leaves,1);assert.equal(f.saves,2);
});
for(const action of ['rename','delete','create','bulk'])test(`actual ${action} abandons pending confirmation after leaving its view`,async()=>{
  const f=events(),wait=deferred();f.prompt=()=>wait.promise;f.confirm=()=>wait.promise;
  const button=action==='create'?f.nodes['.sd-storyboard-gallery-new-folder']:action==='bulk'?f.nodes['.sd-storyboard-gallery-delete-selected']:f.buttons[action];
  const pending=button.fire();f.current=false;wait.resolve(action==='delete'||action==='bulk'?true:'changed');await pending;
  assert.equal(f.saves,0);assert.equal(f.collection.name,'First');assert.equal(f.store.storyboardCollections.length,1);assert.equal(f.store.storyboardImages[0],f.record);
});
test('renamed or replaced collection during prompt cannot be overwritten through stale tile',async()=>{
  for(const replacement of [false,true]){const f=events(),wait=deferred();f.prompt=()=>wait.promise;const pending=f.buttons.rename.fire();
    if(replacement)f.store.storyboardCollections=[{id:'a',name:'Other'}];else f.collection.name='Elsewhere';
    wait.resolve('Stale');await pending;assert.equal(f.saves,0);assert.notEqual(f.store.storyboardCollections[0].name,'Stale');}
});
test('bulk deletion refuses changed selections, replaced records or new duplicate ids during confirmation',async()=>{
  for(const change of [f=>f.c.storyboardGallerySelection.clear(),f=>f.store.storyboardImages=[{id:'one'}],f=>f.store.storyboardImages.push({id:'one'})]){
    const f=events(),wait=deferred();f.confirm=()=>wait.promise;const pending=f.nodes['.sd-storyboard-gallery-delete-selected'].fire();change(f);
    wait.resolve(true);await pending;assert.equal(f.saves,0);assert.ok(f.store.storyboardImages.length);}
});
test('stale controls and stale search timer cannot mutate replacement view; live search still debounces',async()=>{
  const f=events(),input=f.nodes['.sd-storyboard-gallery-search'];input.value='ocean';await input.fire('input');assert.equal(f.state.gallerySearch,'ocean');
  f.timer();assert.equal(f.c.storyboardGalleryVisibleCount,40);assert.equal(f.renders,1);
  f.c.storyboardGalleryVisibleCount=80;f.current=false;f.timer();await f.tag.fire();await f.buttons.open.fire();
  for(const selector of ['select-mode','select-all','move-selected'])await f.nodes['.sd-storyboard-gallery-'+selector].fire();
  assert.equal(f.c.storyboardGalleryVisibleCount,80);assert.equal(f.renders,1);assert.equal(f.opens,0);assert.equal(f.saves,0);assert.equal(f.state.galleryTagFilters.length,0);
});
test('live bulk delete removes only selected records and move refuses removed collection targets',async()=>{
  const f=events();f.store.storyboardImages.push({id:'two'});f.nodes['.sd-storyboard-gallery-move-target'].value='missing';
  await f.nodes['.sd-storyboard-gallery-move-selected'].fire();assert.equal(f.saves,0);
  await f.nodes['.sd-storyboard-gallery-delete-selected'].fire();assert.deepEqual(f.store.storyboardImages.map(row=>row.id),['two']);assert.equal(f.saves,1);
});
