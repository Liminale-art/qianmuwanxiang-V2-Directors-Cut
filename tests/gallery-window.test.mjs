import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {GALLERY_WINDOW_SIZE,galleryDisplayWindow,renderGalleryWindowControls,bindGalleryWindowControls,galleryCardBindings} from '../qianmu-gallery-window.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const groups = count => Array.from({length:count},(_,i)=>({id:'group-'+i,variants:[{id:'image-'+i}]}));

test('large gallery traverses all groups once in windows of at most 40 without truncating originals',()=>{
  const all=groups(5001),before=JSON.stringify(all),seen=[];let cursor=40,pages=0;
  do{const page=galleryDisplayWindow(all,cursor);assert.ok(page.items.length<=GALLERY_WINDOW_SIZE);seen.push(...page.items);cursor=page.next;pages++;}while(cursor!==null);
  assert.deepEqual(seen,all);assert.equal(pages,126);assert.equal(JSON.stringify(all),before);
});

test('page boundaries and reverse navigation preserve complete groups including large variant stacks',()=>{
  const all=groups(81);all[40].variants=Array.from({length:120},(_,i)=>({id:'variant-'+i}));
  const last=galleryDisplayWindow(all,120),middle=galleryDisplayWindow(all,last.previous),first=galleryDisplayWindow(all,middle.previous);
  assert.deepEqual(last.items,[all[80]]);assert.equal(last.next,null);assert.equal(last.start,80);assert.equal(last.end,81);
  assert.equal(middle.items[0],all[40]);assert.equal(middle.items[0].variants.length,120);assert.equal(middle.items.length,40);
  assert.equal(first.previous,null);assert.deepEqual(first.items,all.slice(0,40));
});

test('removed tail records and invalid route cursors clamp safely without inventing or deleting records',()=>{
  const all=groups(41);assert.equal(galleryDisplayWindow(all,8000).cursor,80);
  all.pop();assert.equal(galleryDisplayWindow(all,80).cursor,40);
  for(const value of [undefined,null,-10,0,NaN,Infinity,'broken'])assert.equal(galleryDisplayWindow(all,value).cursor,40);
  const empty=galleryDisplayWindow([],100);assert.equal(empty.cursor,40);assert.equal(empty.end,0);assert.equal(empty.next,null);
  assert.equal(renderGalleryWindowControls(empty),'');assert.equal(renderGalleryWindowControls(galleryDisplayWindow(all)),'');
});

test('top and bottom controls explain the group range and disable unavailable directions',()=>{
  const page=galleryDisplayWindow(groups(81),80),html=renderGalleryWindowControls(page);
  assert.ok(html.includes('41–80 / 81 组 · 2/3'));assert.ok(html.includes('data-gallery-window="40"'));assert.ok(html.includes('data-gallery-window="120"'));
  assert.ok(html.includes('aria-label="上一页画面"'));assert.ok(html.includes('aria-label="下一页画面"'));
  assert.ok(renderGalleryWindowControls(page,'bottom').includes('data-gallery-window-position="bottom"'));
  assert.ok(renderGalleryWindowControls(galleryDisplayWindow(groups(81))).includes('disabled'));
});

class Button extends EventTarget {
  constructor(current=40,target=80){super();this.dataset={galleryWindowCurrent:String(current),galleryWindow:String(target)};this.isConnected=true;this.disabled=false;}
  click(){this.dispatchEvent(new Event('click',{cancelable:true}));}
}
function fixture(){
  const button=new Button(),scope=[{},'chat',1,'gallery'],calls=[],body={scrollTop:50,getBoundingClientRect:()=>({top:20})};
  const nav={getBoundingClientRect:()=>({top:60}),focus:options=>calls.push(['focus',options])};
  const root={isConnected:true,querySelectorAll:()=>[button],querySelector:()=>nav};let cursor=40;
  const options={scope:()=>scope,readCursor:()=>cursor,change:value=>{cursor=value;calls.push(['page',value]);},scroller:()=>body};
  return {button,scope,calls,body,nav,root,options,get cursor(){return cursor;}};
}

test('page action focuses the replacement pager and lands within the existing scroll container',()=>{
  const e=fixture();bindGalleryWindowControls(e.root,e.options);e.button.click();
  assert.equal(e.cursor,80);assert.equal(e.body.scrollTop,90);assert.deepEqual(e.calls,[['page',80],['focus',{preventScroll:true}]]);
  e.button.click();assert.equal(e.calls.length,2,'late second click cannot repeat the old page transition');
});

test('chat/filter/epoch changes, detached nodes, disabled directions and malformed targets do nothing',()=>{
  for(const mutate of [e=>e.scope[0]={},e=>e.scope[1]='other',e=>e.scope[2]++,e=>e.scope[3]='changed filter',
    e=>e.root.isConnected=false,e=>e.button.isConnected=false,e=>e.button.disabled=true,
    e=>e.button.dataset.galleryWindow='120',e=>e.button.dataset.galleryWindow='NaN',e=>e.button.dataset.galleryWindow='0']){
    const e=fixture();bindGalleryWindowControls(e.root,e.options);mutate(e);e.button.click();assert.deepEqual(e.calls,[]);
  }
});

test('repeated binding on a retained pager replaces rather than multiplies handlers',()=>{
  const e=fixture();bindGalleryWindowControls(e.root,{...e.options,change:()=>assert.fail('old handler retained')});
  bindGalleryWindowControls(e.root,e.options);e.button.click();assert.equal(e.calls.filter(row=>row[0]==='page').length,1);
});

test('a changed or unavailable source after synchronous rerender cannot move or focus the replacement chat',()=>{
  for(const unavailable of [false,true]){
    const e=fixture();let closed=false;bindGalleryWindowControls(e.root,{...e.options,
      scope:()=>{if(unavailable&&closed)throw Error('context replaced');return e.scope;},
      change:value=>{e.options.change(value);closed=true;e.scope[0]={};}});
    e.button.click();assert.deepEqual(e.calls,[['page',80]]);assert.equal(e.body.scrollTop,50);
  }
});

test('actual entry binding updates only the display cursor and pending scroll, leaving selection untouched',()=>{
  const e=fixture(),state={view:'gallery',gallerySearch:'',galleryTrack:'all',galleryTagFilters:[]},metadata={},selected=new Set(['off-page']);let renders=0;
  const c=vm.createContext({bindGalleryWindowControls,root:e.root,state,storyboardState:()=>state,ctx:()=>({chatMetadata:metadata}),getChatKey:()=> 'fixture',storyboardAdmissionEpoch:1,
    activeTab:'imagegen',storyboardGalleryKind:'stills',storyboardGalleryOpenCollectionId:'',storyboardGalleryNarrative:{selected:null},
    storyboardGalleryVisibleCount:40,storyboardGallerySelection:selected,storyboardPendingRestoreScroll:null,storyboardScroller:()=>e.body,renderModal:()=>renders++});
  const source=section('bindStoryboardTabEvents'),start=source.indexOf('  bindGalleryWindowControls(root, {'),end=source.indexOf("  galleryCardBindings(root.querySelectorAll('.sd-storyboard-gallery-card",start);
  assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),c);
  c.getChatKey=()=> 'changed-with-same-metadata';e.button.click();assert.equal(renders,0);
  c.getChatKey=()=> 'fixture';e.button.click();
  assert.equal(c.storyboardGalleryVisibleCount,80);assert.equal(c.storyboardPendingRestoreScroll,0);assert.equal(renders,1);assert.deepEqual([...selected],['off-page']);
});

test('entry keeps existing filter/chat resets and route restoration while removing unbounded append actions',()=>{
  const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/storyboardGalleryVisibleCount\s*\+=|sd-storyboard-gallery-more/);
  assert.match(section('storyboardApplyRoute'),/galleryVisibleCount/);
  assert.match(section('storyboardHandleChatChanged'),/storyboardGalleryVisibleCount = 40/);
  const binding=section('bindStoryboardTabEvents');assert.match(binding,/galleryTagFilters[\s\S]*storyboardGalleryVisibleCount = 40/);
  assert.match(binding,/storyboardFilteredGalleryRecords\(state\)\.map\(\(item\) => item.id\)/,'select all still includes every filtered page');
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');assert.match(css,/sd-gallery-window-controls > button[^}]*border-radius: 8px/);
});

test('visible-card bindings scan a large gallery once and retain only requested variant groups',()=>{
  const records=Array.from({length:5001},(_,i)=>({id:String(i),group:'g'+Math.floor(i/2),createdAt:i}));
  const cards=Array.from({length:40},(_,i)=>({dataset:{storyboardRecord:String(i*2),storyboardGroup:'g'+i}}));let reads=0,visits=0;
  const bound=galleryCardBindings(cards,()=>{reads++;return records;},record=>{visits++;return record.group;});
  assert.equal(reads,1);assert.equal(visits,5001);assert.equal(bound.length,40);
  for(let i=0;i<40;i++){assert.equal(bound[i].card,cards[i]);assert.equal(bound[i].record,records[i*2]);assert.deepEqual(bound[i].variants,[records[i*2+1],records[i*2]]);}
});

test('binding preserves first duplicate identity, complete variants, stable timestamps and no-card zero reads',()=>{
  const first={id:'same',group:'a',createdAt:4},other={id:'same',group:'b',createdAt:9},tie={id:'tie',group:'a',createdAt:4};
  const records=[first,other,tie],before=JSON.stringify(records),cards=[{dataset:{storyboardRecord:'same',storyboardGroup:'a'}},{dataset:{storyboardRecord:'missing',storyboardGroup:'missing'}}];
  const rows=galleryCardBindings(cards,()=>records,row=>row.group);assert.equal(rows[0].record,first);assert.deepEqual(rows[0].variants,[first,tie]);
  assert.equal(rows[1].record,undefined);assert.deepEqual(rows[1].variants,[]);assert.equal(JSON.stringify(records),before);
  assert.deepEqual(galleryCardBindings([],()=>assert.fail('another page must not read the gallery'),()=>assert.fail()),[]);
});

test('actual card event binding opens the full group while selection uses only displayed filter members',()=>{
  const preview=new Button(),check=new Button(),inspect=new Button(),card={dataset:{storyboardRecord:'shown',storyboardGroup:'group',storyboardMembers:'shown'},querySelector:selector=>({
    '.sd-storyboard-preview-record':preview,'.sd-storyboard-gallery-check':check,'.sd-storyboard-gallery-inspect':inspect})[selector]||null};
  const rows=[{id:'hidden-by-filter',groupId:'group',createdAt:1},{id:'shown',groupId:'group',createdAt:2}],selection=new Set();let opened,renders=0,reads=0;
  const c=vm.createContext({galleryCardBindings,root:{querySelectorAll:()=>[card]},storyboardGalleryRecords:()=>{reads++;return rows;},
    storyboardGalleryGroupId:row=>row.groupId,storyboardGallerySelection:selection,storyboardGallerySelectMode:false,storyboardGalleryInspectorRecordId:'',
    storyboardOpenLightbox:(variants,id)=>{opened={variants,id};},renderModal:()=>renders++});
  const source=section('bindStoryboardTabEvents'),start=source.indexOf("  galleryCardBindings(root.querySelectorAll('.sd-storyboard-gallery-card"),end=source.indexOf('  void storyboardRefreshSecretState',start);
  assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),c);assert.equal(reads,1);
  preview.click();assert.deepEqual(opened,{id:'shown',variants:[rows[1],rows[0]]});
  check.click();assert.deepEqual([...selection],['shown']);inspect.click();assert.equal(c.storyboardGalleryInspectorRecordId,'shown');assert.equal(renders,2);
});
