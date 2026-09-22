import test from 'node:test';
import assert from 'node:assert/strict';
import {openGalleryArchive as open,galleryArchiveListHtml as listHtml,galleryArchiveRecipeHtml as recipeHtml,galleryArchiveReviewHtml as reviewHtml} from '../qianmu-gallery-archive-view.js';
const tick=()=>new Promise(done=>setTimeout(done,0));
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
const entry={key:'a'.repeat(64),value:{scope:{ownerKey:'char:Alice.png',chatKey:'Archived chat'},sourceReceipt:{count:1}}};
const row={recordId:'one',createdAt:123,tags:['海岸']};
// Synthetic DOM event harness only: no browser layout or real ST acceptance.
function fixture(extra={}){
  const events=new Map(),observers=[],revoked=[],main={scrollTop:0},recipeContainer={innerHTML:''},status={textContent:''},buttons=[{},{}];let parentOpen=true,focus=0,closed=0,listed=0,pages=0,previews=0,created=0,markup='',draws=0;
  const dialog={open:false,isConnected:false,innerHTML:'',setAttribute(){},addEventListener(key,fn){events.set(key,fn);},
    showModal(){this.open=true;},close(){this.open=false;events.get('close')?.();},remove(){this.isConnected=false;},querySelector(selector){return selector==='main'?main:selector==='[data-archive-recipe]'?recipeContainer:selector==='footer [role="status"]'?status:null;},querySelectorAll(){return buttons;}};
  Object.defineProperty(dialog,'innerHTML',{get:()=>markup,set:value=>{markup=value;main.scrollTop=0;draws++;}});
  const view={URL:{createObjectURL(){created++;return 'blob:fixture';},revokeObjectURL(url){revoked.push(url);}},
    MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},addEventListener(){},removeEventListener(){}};
  const document={defaultView:view,body:{},activeElement:{isConnected:true,focus(){focus++;}},createElement(){return dialog;}};
  const parent={ownerDocument:document,isConnected:true,classList:{contains:()=>parentOpen},append(node){node.isConnected=true;}};
  const session={isClosed:()=>false,async list(){listed++;return {entries:[entry],nextCursor:null};},async open(key){assert.equal(key,entry.key);},
    async page(){pages++;return {rows:[row],cursor:null};},async preview(id){assert.equal(id,'one');previews++;return {record:{...row,id},source:entry.value.scope,blob:new Blob(['fixture']),width:10,height:20};},recipe:async()=>({state:'not-recorded'}),close(){closed++;},...extra};
  const opened=open({parent,account:async()=> 'st-user:fixture',headers:()=>({}),connect:()=>session});
  const click=(kind,value)=>events.get('click')({target:{closest:selector=>selector===`[data-archive-${kind}]`?{dataset:{['archive'+kind[0].toUpperCase()+kind.slice(1)]:String(value)}}:null}});
  return {opened,dialog,session,revoked,main,recipeContainer,status,buttons,click,async action(action){click('action',action);await tick();},async choose(kind,index){click(kind,index);await tick();},
    hide(){parentOpen=false;observers[0].callback();},cancel(){events.get('cancel')({preventDefault(){}});},
    get counts(){return {focus,closed,listed,pages,previews,created,draws};},observers};
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

test('recipe reads only on explicit click and changes only its section, preserving image and scroll',async()=>{
  let reads=0;const f=fixture({recipe:async id=>{assert.equal(id,'one');reads++;return {state:'available',origin:'server-copy',snapshot:{prompt:'</textarea><img src=x>',unknown:{kept:true}}};}});
  await tick();await f.choose('version',0);await f.choose('record',0);assert.equal(reads,0);
  const draws=f.counts.draws;f.main.scrollTop=144;await f.action('recipe');
  assert.equal(reads,1);assert.equal(f.counts.draws,draws);assert.equal(f.main.scrollTop,144);assert.equal(f.counts.created,1);
  assert.match(f.recipeContainer.innerHTML,/readonly/);assert.match(f.recipeContainer.innerHTML,/&lt;\/textarea&gt;&lt;img/);
  assert.doesNotMatch(f.recipeContainer.innerHTML,/<img/);assert.match(f.recipeContainer.innerHTML,/unknown/);assert.ok(f.buttons.every(node=>!node.disabled));
  await f.action('recipe');assert.equal(reads,2);f.opened.close();
});

test('missing recipe states are explicit, and never claim a current configuration or executable workflow',()=>{
  for(const state of ['not-preserved','local-reference','unavailable','unresolved','not-recorded']){
    const html=recipeHtml({state});assert.doesNotMatch(html,/<textarea/);assert.ok(html.length>12);
  }
  assert.match(recipeHtml({state:'local-reference'}),/无法确认账户归属/);
});

test('closing during recipe read drops its late content and does not rebuild a closed preview',async()=>{
  const wait=gate(),f=fixture({recipe:()=>wait.promise});await tick();await f.choose('version',0);await f.choose('record',0);
  f.click('action','recipe');assert.ok(f.buttons.every(node=>node.disabled));f.opened.close();
  wait.resolve({state:'available',snapshot:{prompt:'late'}});await tick();
  assert.equal(f.recipeContainer.innerHTML,'');assert.deepEqual(f.revoked,['blob:fixture']);
});

test('preview explains verified private copy versus legacy native media without a false migration claim',async()=>{
  for(const mediaOrigin of ['server-copy','st-original']){
    const f=fixture({preview:async()=>({record:{id:'one',tags:[]},source:entry.value.scope,blob:new Blob(['fixture']),width:1,height:1,mediaOrigin})});
    await tick();await f.choose('version',0);await f.choose('record',0);
    assert.match(f.dialog.innerHTML,mediaOrigin==='server-copy'?/已读取此账户保全的原图副本/:/尚无独立副本/);
    assert.doesNotMatch(f.dialog.innerHTML,/可以删除原图|完整迁移完成/);f.opened.close();
  }
});

const reviewResult={total:7,recipes:{available:5,missing:2},originals:{referenced:4,missing:3},collections:1,characterDrafts:2,evidenceFloors:9};
test('restore review is explicit, progress stays inside dialog, and summary never claims media verification or writeback',async()=>{
  let reviews=0;const f=fixture({review:async({onProgress})=>{reviews++;onProgress({completed:3,total:7});assert.match(f.status.textContent,/3\/7/);return reviewResult;}});
  await tick();await f.choose('version',0);assert.equal(reviews,0);assert.match(f.dialog.innerHTML,/核对恢复资料/);f.main.scrollTop=42;
  await f.action('review');assert.equal(reviews,1);assert.match(f.dialog.innerHTML,/完整配方 5\/7/);assert.match(f.dialog.innerHTML,/原图文件内容尚未逐张核验/);assert.match(f.dialog.innerHTML,/存在未保全/);assert.equal(f.main.scrollTop,42);
  assert.equal(f.counts.previews,0);await f.action('refresh');assert.doesNotMatch(f.dialog.innerHTML,/完整配方 5\/7/);f.opened.close();
});

test('failed or cancelled review removes obsolete success and drops late summaries',async()=>{
  let first=true;const f=fixture({review:async()=>{if(first){first=false;return reviewResult;}throw Error('原件缺失，未猜补');}});
  await tick();await f.choose('version',0);await f.action('review');assert.match(f.dialog.innerHTML,/完整配方 5\/7/);await f.action('review');assert.doesNotMatch(f.dialog.innerHTML,/完整配方 5\/7/);assert.match(f.dialog.innerHTML,/原件缺失/);f.opened.close();
  const wait=gate(),g=fixture({review:()=>wait.promise});await tick();await g.choose('version',0);g.click('action','review');g.opened.close();const draws=g.counts.draws;wait.resolve(reviewResult);await tick();assert.equal(g.counts.draws,draws);
  assert.match(reviewHtml(reviewResult),/不会写回聊天或删除任何资料/);
});

test('original byte verification is a separate explicit action, with bandwidth notice and bounded status copy',async()=>{
  const modes=[],f=fixture({review:async({verifyOriginals,onProgress})=>{
    modes.push(verifyOriginals);if(!verifyOriginals)return reviewResult;
    onProgress({phase:'originals',completed:7,total:7,verified:4});assert.match(f.status.textContent,/原图文件已核验 4\/7/);
    return {...reviewResult,proof:'archive-originals-readback-only',originals:{...reviewResult.originals,verified:4,unique:2,bytes:140}};
  }});
  await tick();await f.choose('version',0);assert.deepEqual(modes,[]);assert.doesNotMatch(f.dialog.innerHTML,/data-archive-action="originals"/);
  await f.action('review');assert.match(f.dialog.innerHTML,/更多时间和流量/);assert.deepEqual(modes,[false]);
  await f.action('originals');assert.deepEqual(modes,[false,true]);assert.match(f.dialog.innerHTML,/原图文件已核验 4\/7/);assert.match(f.dialog.innerHTML,/去重读取 2 份/);assert.match(f.dialog.innerHTML,/仍不代表原路径已恢复/);assert.doesNotMatch(f.dialog.innerHTML,/原图文件内容尚未逐张核验/);f.opened.close();
});

test('failed original verification clears its previous success summary and never presents a restore success',async()=>{
  let failed=false;const f=fixture({review:async({verifyOriginals})=>{if(verifyOriginals&&failed)throw Error('原图字节校验失败');if(verifyOriginals){failed=true;return {...reviewResult,proof:'archive-originals-readback-only',originals:{...reviewResult.originals,verified:4,unique:2,bytes:140}};}return reviewResult;}});
  await tick();await f.choose('version',0);await f.action('review');await f.action('originals');assert.match(f.dialog.innerHTML,/已核验 4\/7/);
  await f.action('originals');assert.match(f.dialog.innerHTML,/原图字节校验失败/);assert.doesNotMatch(f.dialog.innerHTML,/已核验 4\/7|已恢复并完成/);f.opened.close();
});

test('prepare is explicit, carries progress and presents only a durable preparation, not a restored chat',async()=>{
  let calls=0;const f=fixture({review:async()=>reviewResult,prepare:async({onProgress})=>{
    calls++;onProgress({phase:'source',completed:2,total:4});assert.match(f.status.textContent,/合并历史记录 2\/4/);
    return {compatible:true,added:2,kept:2,total:4};
  }});
  await tick();await f.choose('version',0);assert.equal(calls,0);assert.doesNotMatch(f.dialog.innerHTML,/data-archive-action="prepare"/);
  await f.action('review');assert.equal(calls,0);assert.match(f.dialog.innerHTML,/data-archive-action="prepare"/);
  await f.action('prepare');assert.equal(calls,1);assert.match(f.dialog.innerHTML,/尚未执行恢复/);assert.match(f.dialog.innerHTML,/新增 2 张/);assert.match(f.dialog.innerHTML,/不能据此删除/);
  await f.action('refresh');assert.doesNotMatch(f.dialog.innerHTML,/恢复资料已准备/);f.opened.close();
});

test('prepare conflicts and failures clear stale success without dumping full records into the dialog',async()=>{
  let fail=false;const f=fixture({review:async()=>reviewResult,prepare:async()=>{if(fail)throw Error('基线已修改');return {compatible:false,conflicts:3,examples:[{id:'PRIVATE_ROW'}]};}});
  await tick();await f.choose('version',0);await f.action('review');await f.action('prepare');assert.match(f.dialog.innerHTML,/存在 3 项冲突/);assert.doesNotMatch(f.dialog.innerHTML,/PRIVATE_ROW|恢复资料已准备/);
  fail=true;await f.action('prepare');assert.match(f.dialog.innerHTML,/基线已修改/);assert.doesNotMatch(f.dialog.innerHTML,/存在 3 项冲突/);f.opened.close();
});

test('closing preparation releases the session and ignores a late successful result',async()=>{
  const wait=gate(),f=fixture({review:async()=>reviewResult,prepare:()=>wait.promise});await tick();await f.choose('version',0);await f.action('review');f.click('action','prepare');f.opened.close();const before=f.counts.draws;
  wait.resolve({compatible:true,added:1,kept:0,total:1});await tick();assert.equal(f.counts.draws,before);assert.equal(f.counts.closed,1);
});
