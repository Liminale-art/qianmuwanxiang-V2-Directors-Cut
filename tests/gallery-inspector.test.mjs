import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {renderGalleryInspector,captureGalleryViewGuard,bindGalleryInspector} from '../qianmu-gallery-inspector.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Node {
  constructor(dataset={}){this.dataset=dataset;this.isConnected=true;this.disabled=false;this.listeners={};}
  addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
  fire(name='click'){for(const callback of this.listeners[name]||[])callback({currentTarget:this,target:this});}
}
function fixture(){
  const f={record:{id:'one'},id:'one',owner:{},active:true,backs:0,errors:[],calls:0};
  const area=new Node({galleryDetail:'one'}),back=new Node(),button=new Node({galleryDetailAction:'preview'}),check=new Node(),tag=new Node();
  check.value='collection';check.checked=true;
  area.querySelector=()=>back;area.querySelectorAll=selector=>selector==='[data-gallery-detail-action]'?[button]:selector==='[data-media-tag-editor]'?[tag]:[check];
  const root={isConnected:true,contains:node=>node.isConnected,querySelector:()=>area};
  const scope=()=>[f.owner,f.active],isCurrent=captureGalleryViewGuard(root,{scope,isActive:()=>f.active});
  f.bind=(actions={preview:async()=>{f.calls++;}})=>bindGalleryInspector(root,{isCurrent,readRecord:()=>f.record,readId:()=>f.id,
    back:()=>f.backs++,actions,saveCollections:async(row,values,verify)=>{await verify();f.calls++;row.collections=values;},onError:error=>f.errors.push(error)});
  return Object.assign(f,{root,area,back,button,check,tag,isCurrent});
}

test('selected-only renderer escapes metadata and enables style only for usable NAI records',()=>{
  assert.equal(renderGalleryInspector(null),'');
  for(const source of ['novel','openai','comfy'])for(const unavailable of [false,true]){
    const row={id:'<id>',source,recipeUnavailable:unavailable,model:'<model>',prompt:'<script>unsafe</script>',tags:[]};
    Object.defineProperty(row,'snapshot',{get(){assert.fail('no recipe read during render');}});
    const html=renderGalleryInspector(row,{url:'/safe.png',sourceLabel:'<source>',location:{paragraphKey:'p'},collections:[{id:'"',name:'<name>'}]});
    assert.equal(html.includes('data-gallery-detail-action="style"'),source==='novel'&&!unavailable);
    assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<model>|<name>/);assert.match(html,/查看本段全部静帧/);
    assert.equal((html.match(/<img /g)||[]).length,1);
  }
});

test('detail retains full prompt, does not crop images, and review/explicit insert controls stay mutually appropriate',()=>{
  const row={id:'one',prompt:'x'.repeat(3000),restoreLinkReview:{}};
  const html=renderGalleryInspector(row,{production:{requiresExplicitInsert:true}});
  assert.ok(html.includes(row.prompt));assert.match(html,/data-gallery-detail-action="review"/);assert.doesNotMatch(html,/data-gallery-detail-action="attach"|<img /);
  delete row.restoreLinkReview;assert.match(renderGalleryInspector(row,{production:{requiresExplicitInsert:true}}),/data-gallery-detail-action="attach"/);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');assert.match(css,/\.sd-gallery-detail-visual img \{[^}]*object-fit: contain/);
  assert.match(css,/@media \(max-width: 720px\) \{[\s\S]*?\.sd-gallery-detail-layout \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css,/\.sd-gallery-browser-main \{ min-width: 0/);
});

for(const [label,change] of Object.entries({owner:f=>f.owner={},closed:f=>f.active=false,detached:f=>f.area.isConnected=false,
  root:f=>f.root.isConnected=false,id:f=>f.id='two',replacement:f=>f.record={id:'one'},removed:f=>f.record=null}))
test(`stale ${label} detail cannot preview, change collections or persist tags`,async()=>{
  const f=fixture();f.bind();assert.equal(f.tag._qianmuGalleryCurrent(),true);change(f);f.button.fire();f.check.fire('change');await tick();
  assert.equal(f.calls,0);assert.equal(f.tag._qianmuGalleryCurrent(),false);
});

test('guard captures mutable scope values and fails closed on errors',()=>{
  const root={isConnected:true,contains:()=>true},node={isConnected:true},values=[1,{}];
  const current=captureGalleryViewGuard(root,{scope:()=>values,isActive:()=>true});assert.equal(current(node),true);values[0]=2;assert.equal(current(node),false);
  assert.equal(captureGalleryViewGuard(root,{scope:()=>{throw Error('not ready');},isActive:()=>true})(node),false);
});

test('rebind disposes old actions and collection inputs become usable again after save',async()=>{
  const f=fixture();f.bind();f.bind();f.button.fire();await tick();assert.equal(f.calls,1);
  f.check.fire('change');await tick();assert.equal(f.calls,2);assert.deepEqual(f.record.collections,['collection']);assert.equal(f.check.disabled,false);
});

test('only one pending detail action runs, but back remains available and stale completion is silent',async()=>{
  const f=fixture(),wait=deferred();let writes=0;
  f.bind({preview:async(row,{verify})=>{f.calls++;await wait.promise;await verify();writes++;}});
  f.button.fire();f.button.fire();assert.equal(f.check.disabled,true);f.back.fire();assert.equal(f.backs,1);
  f.area.isConnected=false;wait.resolve();await tick();assert.equal(f.calls,1);assert.equal(writes,0);assert.equal(f.errors.length,0);
});

test('actual navigation keeps browser scroll and paging separate from detail scroll and focus',()=>{
  const state={view:'gallery'},scrolls=new Map(),body={dataset:{storyboardPage:'gallery'},scrollTop:620,querySelector:()=>null},record={id:'one'};let focused=0;
  const target={focus:options=>{assert.equal(options.preventScroll,true);focused++;}},card={dataset:{storyboardRecord:'one'},querySelector:()=>target};
  const root={querySelector:selector=>selector==='[data-gallery-detail-back]'?target:body,querySelectorAll:()=>[card]};
  const c=vm.createContext({storyboardState:()=>state,storyboardGalleryKind:'stills',storyboardGalleryInspectorRecordId:'',storyboardGalleryVisibleCount:80,
    storyboardPageScrolls:scrolls,storyboardPendingRestoreScroll:null,storyboardGalleryRecords:()=>[record],document:{querySelector:()=>null},
    renderModal:()=>{body.dataset.storyboardPage=c.storyboardPageKey();body.scrollTop=c.storyboardPendingRestoreScroll;}});
  vm.runInContext(['storyboardPageKey','storyboardScroller','storyboardRememberPageScroll','storyboardShowGalleryInspector','storyboardLeaveGalleryInspector'].map(section).join('\n'),c);
  c.storyboardShowGalleryInspector(root,record);assert.equal(c.storyboardPageKey(),'gallery:detail');assert.equal(body.scrollTop,0);assert.equal(scrolls.get('gallery'),620);
  body.scrollTop=120;c.storyboardLeaveGalleryInspector(root,record.id);assert.equal(c.storyboardPageKey(),'gallery');assert.equal(body.scrollTop,620);
  assert.equal(c.storyboardGalleryVisibleCount,80);assert.equal(focused,2);
});

test('actual tag persistence requires the live detail guard before reading or saving records',()=>{
  const record={id:'one'},editor={dataset:{mediaTagEditor:'gallery:one'},_qianmuGalleryCurrent:()=>false};let reads=0,saves=0;
  const c=vm.createContext({storyboardGalleryRecords:()=>{reads++;return [record];},storyboardMediaTagValues:()=>['tag'],saveMetadata:()=>saves++});
  vm.runInContext(section('storyboardPersistMediaTagEditor'),c);c.storyboardPersistMediaTagEditor(editor);assert.equal(reads,0);assert.equal(saves,0);
  editor._qianmuGalleryCurrent=()=>true;c.storyboardPersistMediaTagEditor(editor);assert.deepEqual(record.tags,['tag']);assert.equal(saves,1);
});

test('actual detail binding shares complete variants, keeps style deferred, and location clears all other filters',async()=>{
  const record={id:'shown',group:'same',createdAt:2},hidden={id:'hidden',group:'same',createdAt:1},other={id:'other',group:'other'};
  const state={gallerySearch:'word',galleryTrack:'main_camera',galleryTagFilters:['red']};let options,opened,styleCalls=0,renders=0;
  const current=()=>true,root={querySelector:()=>({})};
  const c=vm.createContext({bindGalleryInspector:(_root,value)=>{options=value;},storyboardGalleryViewGuard:()=>current,
    storyboardGalleryInspectorRecordId:'shown',storyboardGalleryRecords:()=>[hidden,record,other],storyboardGalleryGroupId:row=>row.group,
    storyboardOpenLightbox:(rows,id,guard)=>{opened={rows,id,guard};},storyboardApplyRecordStyle:async()=>{styleCalls++;},
    storyboardUpdateGalleryNarrative:()=>({selectRecord:value=>value===record}),storyboardState:()=>state,
    storyboardGallerySelection:new Set(['shown']),storyboardGallerySelectMode:true,storyboardGalleryVisibleCount:80,
    storyboardGalleryOpenCollectionId:'collection',storyboardPendingRestoreScroll:120,renderModal:()=>renders++});
  vm.runInContext(section('storyboardBindGalleryInspector'),c);c.storyboardBindGalleryInspector(root);
  assert.equal(options.readRecord(),record);assert.equal(styleCalls,0);
  await options.actions.preview(record,{isCurrent:current});assert.deepEqual(Array.from(opened.rows),[record,hidden]);assert.equal(opened.id,'shown');assert.equal(opened.guard.isCurrent,current);
  await options.actions.style(record,{verify:async()=>{}});assert.equal(styleCalls,1);
  options.actions.source(record);assert.equal(c.storyboardGalleryInspectorRecordId,'');assert.equal(c.storyboardGalleryVisibleCount,40);assert.equal(c.storyboardPendingRestoreScroll,0);
  assert.equal(state.gallerySearch,'');assert.equal(state.galleryTrack,'all');assert.equal(state.galleryTagFilters.length,0);assert.equal(c.storyboardGallerySelection.size,0);assert.equal(renders,1);
});

test('actual view guard rejects chat id changes even with reused metadata and rejects non-gallery navigation',()=>{
  const state={view:'gallery'},owner={},root={isConnected:true,contains:()=>true,classList:{contains:()=>true}},area={isConnected:true};
  const c=vm.createContext({captureGalleryViewGuard,storyboardState:()=>state,ctx:()=>({chatMetadata:owner}),getChatKey:()=> 'chat',
    storyboardAdmissionEpoch:1,activeTab:'imagegen',storyboardGalleryKind:'stills'});vm.runInContext(section('storyboardGalleryViewGuard'),c);
  const current=c.storyboardGalleryViewGuard(root);assert.equal(current(area),true);c.getChatKey=()=> 'other';assert.equal(current(area),false);
  c.getChatKey=()=> 'chat';state.view='create';assert.equal(current(area),false);
});

test('actual lightbox abandons a late account lookup after leaving the detail',async()=>{
  const wait=deferred(),state={},store={},record={id:'one',url:'/image.png'};let current=true;
  const c=vm.createContext({storyboardSafeUrl:value=>value,getChatStore:()=>store,storyboardState:()=>state,getChatKey:()=> 'chat',storyboardAdmissionEpoch:1,
    storyboardCloseLightbox:()=>{},storyboardLightboxEpoch:1,document:{activeElement:null,createElement:()=>({setAttribute(){}})},
    featureRuntime:{load:()=>wait.promise},toast:()=>assert.fail('no error expected')});vm.runInContext(section('storyboardOpenLightbox'),c);
  const pending=c.storyboardOpenLightbox(record,'',{isCurrent:()=>current});current=false;wait.resolve({resolveImageAccountNamespace:async()=> 'account'});await pending;
});

function attachFixture(){
  const state={},owner={},message={mes:'original',swipe_id:0},record={id:'world'},f={key:'chat',account:'one',saves:0,reads:0,confirm:async()=>true,read:async()=>null};
  const c=vm.createContext({storyboardProductionDeliveryPolicy:()=>({requiresExplicitInsert:true,sourceLabel:'造物之眼'}),storyboardCurrentAssistantFloor:()=>0,
    ctx:()=>({chat:[message],chatMetadata:owner}),storyboardState:()=>state,getChatKey:()=>f.key,storyboardAdmissionEpoch:1,storyboardGalleryRecords:()=>[record],
    featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>f.account})},confirmDialog:()=>f.confirm(),
    storyboardReadSnapshotForRecord:async()=>{f.reads++;return f.read();},saveMetadata:async()=>{f.saves++;},
    hashText:()=> 'hash',createStoryboardMessageReference:()=>({}),storyboardAnchorForMessage:()=>({}),
    storyboardArchiveGallerySnapshots:async()=>{},storyboardRenderInlineImages:()=>{},renderModal:()=>{},toast:()=>{}});
  vm.runInContext(section('storyboardAttachProductionRecord'),c);return Object.assign(f,{c,message,record});
}
for(const [label,change] of Object.entries({chat:f=>f.key='other',text:f=>f.message.mes='edited',swipe:f=>f.message.swipe_id=1,account:f=>f.account='two'}))
test(`actual explicit insertion rejects ${label} changes while confirmation is open`,async()=>{
  const f=attachFixture();f.confirm=async()=>{change(f);return true;};await assert.rejects(()=>f.c.storyboardAttachProductionRecord(f.record));
  assert.equal(f.reads,0);assert.equal(f.saves,0);assert.equal(f.record.floor,undefined);
});
test('actual explicit insertion rechecks after recipe read, and unchanged source can still be attached',async()=>{
  const f=attachFixture();f.read=async()=>{f.key='other';return null;};await assert.rejects(()=>f.c.storyboardAttachProductionRecord(f.record));assert.equal(f.saves,0);
  const good=attachFixture();assert.equal(await good.c.storyboardAttachProductionRecord(good.record),true);assert.equal(good.saves,1);assert.equal(good.record.floor,0);
});

test('actual stale card cannot select/open, and confirmation cannot delete a replacement chat record',async()=>{
  const buttons=Object.fromEntries(['check','preview-record','inspect','delete-record'].map(name=>[name,new Node()]));
  const record={id:'one'},store={storyboardImages:[record]},wait=deferred();let current=true,saves=0,opens=0;
  const card={dataset:{storyboardMembers:'one'},querySelector:selector=>buttons[selector.replace('.sd-storyboard-gallery-','').replace('.sd-storyboard-','')]||null};
  const c=vm.createContext({galleryCardBindings:()=>[{card,record,variants:[record]}],galleryCurrent:()=>current,root:{querySelectorAll:()=>[card]},
    storyboardGalleryRecords:()=>store.storyboardImages,storyboardGalleryGroupId:()=> 'one',storyboardGallerySelection:new Set(),
    storyboardGallerySelectMode:false,storyboardGalleryInspectorRecordId:'',storyboardShowGalleryInspector:()=>opens++,renderModal:()=>{},
    confirmDialog:()=>wait.promise,getChatStore:()=>store,saveMetadata:async()=>{saves++;}});
  const source=section('bindStoryboardTabEvents'),start=source.indexOf("  galleryCardBindings(root.querySelectorAll('.sd-storyboard-gallery-card"),end=source.indexOf('  void storyboardRefreshSecretState',start);
  vm.runInContext(source.slice(start,end),c);for(const button of Object.values(buttons))assert.equal(button.listeners.click.length,1);
  buttons['delete-record'].fire();current=false;store.storyboardImages=[{id:'one',otherChat:true}];
  buttons.check.fire();buttons['preview-record'].fire();buttons.inspect.fire();wait.resolve(true);await tick();
  assert.equal(saves,0);assert.equal(opens,0);assert.equal(c.storyboardGallerySelection.size,0);assert.equal(store.storyboardImages[0].otherChat,true);
});
