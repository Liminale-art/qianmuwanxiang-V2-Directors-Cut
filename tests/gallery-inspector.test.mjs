import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as galleryGuard from '../qianmu-gallery-inspector.js';
import {renderImageInfo} from '../qianmu-image-info-view.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const {captureGalleryViewGuard}=galleryGuard;

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
class Node {
  constructor(dataset={}){this.dataset=dataset;this.isConnected=true;this.disabled=false;this.listeners={};}
  addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
  fire(name='click'){for(const callback of this.listeners[name]||[])callback({currentTarget:this,target:this});}
}
test('retired inspector contains only the live gallery guard and no duplicate detail renderer or binder',()=>{
  assert.deepEqual(Object.keys(galleryGuard),['captureGalleryViewGuard']);
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');assert.doesNotMatch(css,/sd-gallery-detail|sd-storyboard-inspector-source/);
});

test('shared detail retains escaped full prompts and reads no recipe during rendering',()=>{
  const row={id:'one',url:'/safe.png'},positive='<script>'+ 'x'.repeat(3000)+'</script>';
  Object.defineProperty(row,'snapshot',{get(){assert.fail('no recipe read during render');}});
  const html=renderImageInfo({record:row,positive,modelLabel:'<model>',sourceCharacter:'<source>'});
  assert.ok(html.includes('x'.repeat(3000)));assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;model&gt;/);assert.match(html,/&lt;source&gt;/);
  assert.doesNotMatch(html,/<script>|<model>|<source>|data-gallery-detail|查看本段全部静帧|原图与重绘工具/);assert.equal((html.match(/<img /g)||[]).length,1);
});

for(const [label,change] of Object.entries({owner:f=>f.owner={},closed:f=>f.active=false,detached:f=>f.node.isConnected=false,
  root:f=>f.root.isConnected=false,reparented:f=>f.contains=false,id:f=>f.id='two',replacement:f=>f.record={id:'one'},removed:f=>f.record=null}))
test(`live gallery guard rejects ${label} changes`,()=>{
  const f={owner:{},active:true,id:'one',record:{id:'one'},contains:true,node:{isConnected:true},root:{isConnected:true}};
  f.root.contains=()=>f.contains;
  const current=captureGalleryViewGuard(f.root,{scope:()=>[f.owner,f.id,f.record],isActive:()=>f.active});
  assert.equal(current(f.node),true);change(f);assert.equal(current(f.node),false);
});

test('guard captures mutable scope values and fails closed on errors',()=>{
  const root={isConnected:true,contains:()=>true},node={isConnected:true},values=[1,{}];
  const current=captureGalleryViewGuard(root,{scope:()=>values,isActive:()=>true});assert.equal(current(node),true);values[0]=2;assert.equal(current(node),false);
  assert.equal(captureGalleryViewGuard(root,{scope:()=>{throw Error('not ready');},isActive:()=>true})(node),false);
});

test('gallery opens the same image info without resetting scroll, filters or paging',()=>{
  const record={id:'one'},state={view:'gallery',gallerySearch:'kept'};let opened=null;
  const root={scrollTop:620},c=vm.createContext({storyboardGalleryRecords:()=>[record],storyboardOpenImageInfo:async row=>{opened=row;},toast:()=>assert.fail('no error'),storyboardState:()=>state});
  vm.runInContext(section('storyboardShowGalleryInspector'),c);
  c.storyboardShowGalleryInspector(root,record);assert.equal(opened,record);assert.equal(root.scrollTop,620);assert.equal(state.gallerySearch,'kept');
  opened=null;c.storyboardShowGalleryInspector(root,{id:'foreign'});assert.equal(opened,null);
});

test('actual tag persistence requires the live detail guard before reading or saving records',async()=>{
  const record={id:'one'},editor={dataset:{mediaTagEditor:'gallery:one'},_qianmuGalleryCurrent:()=>false};let reads=0,saves=0;
  const c=vm.createContext({storyboardGalleryRecords:()=>{reads++;return [record];},storyboardMediaTagValues:()=>['tag'],saveMetadata:()=>saves++});
  vm.runInContext(section('storyboardPersistMediaTagEditor'),c);await c.storyboardPersistMediaTagEditor(editor);assert.equal(reads,0);assert.equal(saves,0);
  editor._qianmuGalleryCurrent=()=>true;await c.storyboardPersistMediaTagEditor(editor);assert.deepEqual(record.tags,['tag']);assert.equal(saves,1);
});

test('actual unified entry accepts only the current record, preserves browsing state and reports open failure honestly',async()=>{
  const record={id:'shown'},state={gallerySearch:'word',galleryTrack:'main_camera',galleryTagFilters:['red']};
  let records=[record],opened=[],notices=[];
  const c=vm.createContext({storyboardGalleryRecords:()=>records,storyboardEditPrompt:async options=>{opened.push(options);return true;},
    toast:(...args)=>notices.push(args),storyboardState:()=>state,storyboardGallerySelection:new Set(['shown']),
    storyboardGallerySelectMode:true,storyboardGalleryVisibleCount:80,storyboardGalleryOpenCollectionId:'collection',storyboardPendingRestoreScroll:120});
  vm.runInContext(section('storyboardOpenImageInfo'),c);
  assert.equal(await c.storyboardOpenImageInfo(record),true);assert.equal(opened.length,1);assert.equal(opened[0].record,record);assert.equal(opened[0].inspect,true);
  assert.deepEqual(state,{gallerySearch:'word',galleryTrack:'main_camera',galleryTagFilters:['red']});
  assert.equal(c.storyboardGalleryVisibleCount,80);assert.equal(c.storyboardGalleryOpenCollectionId,'collection');assert.equal(c.storyboardPendingRestoreScroll,120);
  assert.deepEqual([...c.storyboardGallerySelection],['shown']);assert.equal(c.storyboardGallerySelectMode,true);
  await c.storyboardOpenImageInfo({id:'shown'});records=[];await c.storyboardOpenImageInfo(record);records=[{id:'shown'}];await c.storyboardOpenImageInfo(record);
  assert.equal(opened.length,1);assert.equal(notices.length,0);
  records=[record];c.storyboardEditPrompt=async()=>{throw Error('read failed');};
  assert.equal(await c.storyboardOpenImageInfo(record),false);assert.deepEqual(notices,[['read failed','warning']]);
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

test('actual cards expose only selection and unified details, and reject stale or replaced records',async()=>{
  const buttons=Object.fromEntries(['check','preview-record','inspect','delete-record'].map(name=>[name,new Node()]));
  const record={id:'one'},store={storyboardImages:[record]};let current=true,opens=0;
  const card={dataset:{storyboardMembers:'one'},querySelector:selector=>buttons[selector.replace('.sd-storyboard-gallery-','').replace('.sd-storyboard-','')]||null};
  const c=vm.createContext({galleryCardBindings:()=>[{card,record,variants:[record]}],galleryCurrent:()=>current,root:{querySelectorAll:()=>[card]},
    storyboardGalleryRecords:()=>store.storyboardImages,storyboardGalleryGroupId:()=> 'one',storyboardGallerySelection:new Set(),
    storyboardGallerySelectMode:false,storyboardGalleryInspectorRecordId:'',storyboardOpenImageInfo:async()=>opens++,renderModal:()=>{},toast:()=>assert.fail('no error expected')});
  const source=section('bindStoryboardTabEvents'),start=source.indexOf("  galleryCardBindings(root.querySelectorAll('.sd-storyboard-gallery-card"),end=source.indexOf('  void storyboardRefreshSecretState',start);
  vm.runInContext(section('storyboardShowGalleryInspector')+'\n'+source.slice(start,end),c);
  assert.equal(buttons.check.listeners.click.length,1);assert.equal(buttons['preview-record'].listeners.click.length,1);
  assert.equal(buttons.inspect.listeners.click,undefined);assert.equal(buttons['delete-record'].listeners.click,undefined);
  buttons['preview-record'].fire();assert.equal(opens,1);
  current=false;buttons.check.fire();buttons['preview-record'].fire();assert.equal(opens,1);assert.equal(c.storyboardGallerySelection.size,0);
  current=true;store.storyboardImages=[{id:'one',otherChat:true}];buttons.check.fire();buttons['preview-record'].fire();await tick();
  assert.equal(opens,1);assert.equal(c.storyboardGallerySelection.size,0);assert.equal(store.storyboardImages[0].otherChat,true);
});

test('unified deletion rechecks its live source guard after confirmation and cannot delete a replacement chat record',async()=>{
  const record={id:'one'},replacement={id:'one',otherChat:true},store={storyboardImages:[record]},wait=deferred();let saves=0;
  const c=vm.createContext({confirmDialog:()=>wait.promise,getChatStore:()=>store,storyboardAdmissionEpoch:1,getChatKey:()=> 'chat',
    saveMetadata:async()=>{saves++;},storyboardGallerySelection:new Set(),storyboardDeleteRecordSnapshots:()=>assert.fail('no archive deletion'),
    storyboardRenderInlineImages:()=>assert.fail('no inline mutation'),rerenderIfOpen:()=>assert.fail('no rerender')});
  vm.runInContext(section('storyboardRemoveImage'),c);
  const pending=c.storyboardRemoveImage(record,async()=>{if(!store.storyboardImages.includes(record))throw Error('source changed');});
  store.storyboardImages=[replacement];wait.resolve(true);await assert.rejects(pending,/source changed/);
  assert.equal(saves,0);assert.deepEqual(store.storyboardImages,[replacement]);
});
