import test from 'node:test';
import assert from 'node:assert/strict';
import {openGalleryArchive as open,galleryArchiveListHtml as listHtml} from '../qianmu-gallery-archive-view.js';
const tick=()=>new Promise(done=>setTimeout(done,0));
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
const entry={key:'a'.repeat(64),value:{scope:{ownerKey:'char:Alice.png',chatKey:'Archived chat'},sourceReceipt:{count:1}}};
const row={recordId:'one',createdAt:123,tags:['海岸']};
// Synthetic DOM event harness only: no browser layout or real ST acceptance.
function fixture(extra={}){
  const events=new Map(),observers=[],revoked=[],main={scrollTop:0};let parentOpen=true,focus=0,closed=0,listed=0,pages=0,previews=0,created=0,markup='';
  const dialog={open:false,isConnected:false,innerHTML:'',setAttribute(){},addEventListener(key,fn){events.set(key,fn);},
    showModal(){this.open=true;},close(){this.open=false;events.get('close')?.();},remove(){this.isConnected=false;},querySelector(selector){return selector==='main'?main:null;}};
  Object.defineProperty(dialog,'innerHTML',{get:()=>markup,set:value=>{markup=value;main.scrollTop=0;}});
  const view={URL:{createObjectURL(){created++;return 'blob:fixture';},revokeObjectURL(url){revoked.push(url);}},
    MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},addEventListener(){},removeEventListener(){}};
  const document={defaultView:view,body:{},activeElement:{isConnected:true,focus(){focus++;}},createElement(){return dialog;}};
  const parent={ownerDocument:document,isConnected:true,classList:{contains:()=>parentOpen},append(node){node.isConnected=true;}};
  const session={isClosed:()=>false,async list(){listed++;return {entries:[entry],nextCursor:null};},async open(key){assert.equal(key,entry.key);},
    async page(){pages++;return {rows:[row],cursor:null};},async preview(id){assert.equal(id,'one');previews++;return {record:row,source:entry.value.scope,blob:new Blob(['fixture']),width:10,height:20};},close(){closed++;},...extra};
  const opened=open({parent,account:async()=> 'st-user:fixture',headers:()=>({}),connect:()=>session});
  const click=(kind,value)=>events.get('click')({target:{closest:selector=>selector===`[data-archive-${kind}]`?{dataset:{['archive'+kind[0].toUpperCase()+kind.slice(1)]:String(value)}}:null}});
  return {opened,dialog,session,revoked,main,click,async action(action){click('action',action);await tick();},async choose(kind,index){click(kind,index);await tick();},
    hide(){parentOpen=false;observers[0].callback();},cancel(){events.get('cancel')({preventDefault(){}});},
    get counts(){return {focus,closed,listed,pages,previews,created};},observers};
}

test('version and row markup escapes user metadata and never emits raw remote images',()=>{
  const html=listHtml({entries:[{...entry,value:{...entry.value,scope:{ownerKey:'char:<img>.png',chatKey:'<script>bad</script>'}}}]});
  assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;script&gt;/);assert.match(html,/版本 aaaaaaaa/);
  const records=listHtml({selected:entry,rows:[{...row,tags:['<svg onload=x>']}],busy:true});
  assert.doesNotMatch(records,/<svg/);assert.match(records,/disabled/);assert.match(records,/data-archive-record="0"/);
});

test('opening lists only metadata; returning from preview and version reuses loaded lists',async()=>{
  const f=fixture();await tick();assert.equal(f.counts.listed,1);assert.equal(f.counts.previews,0);
  f.main.scrollTop=80;await f.choose('version',0);assert.match(f.dialog.innerHTML,/海岸/);assert.equal(f.counts.pages,1);assert.equal(f.main.scrollTop,0);
  f.main.scrollTop=200;
  await f.choose('record',0);assert.equal(f.counts.previews,1);assert.match(f.dialog.innerHTML,/blob:fixture/);
  await f.action('back');assert.deepEqual(f.revoked,['blob:fixture']);assert.equal(f.counts.pages,1);assert.equal(f.main.scrollTop,200);
  await f.action('versions');assert.equal(f.counts.listed,1);assert.match(f.dialog.innerHTML,/Archived chat/);assert.equal(f.main.scrollTop,80);
  f.opened.close();await f.opened.finished;assert.equal(f.counts.closed,1);assert.equal(f.counts.focus,1);
});

test('closing before discovery or preview settles ignores late results and revokes only owned URLs',async()=>{
  const wait=gate(),f=fixture({list:()=>wait.promise});f.cancel();await f.opened.finished;
  wait.resolve({entries:[entry]});await tick();assert.equal(f.dialog.isConnected,false);assert.equal(f.counts.created,0);
  const image=gate(),g=fixture({preview:()=>image.promise});await tick();await g.choose('version',0);g.click('record',0);g.hide();
  image.resolve({blob:new Blob(['late'])});await tick();assert.equal(g.counts.created,0);assert.equal(g.counts.closed,1);
});

test('failed discovery is an error state, never an empty-library claim, and refresh is possible',async()=>{
  let calls=0;const f=fixture({list:async()=>{if(!calls++)throw Error('目录损坏，请保留原件');return {entries:[entry]};}});await tick();
  assert.match(f.dialog.innerHTML,/目录损坏/);assert.doesNotMatch(f.dialog.innerHTML,/暂无已保全版本/);
  await f.action('refresh');assert.match(f.dialog.innerHTML,/Archived chat/);f.opened.close();
});

test('account expiration clears old metadata and leaves a concise reopen instruction',async()=>{
  let expired=false;const f=fixture({isClosed:()=>expired,page:async()=>{expired=true;throw Error('ST 账户已变化，请重新打开图库');}});
  await tick();await f.choose('version',0);assert.doesNotMatch(f.dialog.innerHTML,/Archived chat|char:Alice/);
  assert.match(f.dialog.innerHTML,/账户已变化/);assert.match(f.dialog.innerHTML,/<fieldset disabled>/);f.opened.close();
});

test('parent closure ends the dialog once, disconnects observers, and restores focus',async()=>{
  const f=fixture();await tick();f.hide();await f.opened.finished;f.opened.close();
  assert.equal(f.counts.closed,1);assert.equal(f.counts.focus,1);assert.ok(f.observers.every(item=>item.disconnected));
});
