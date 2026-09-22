import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {openGalleryRecipeReview as open,galleryRecipeReviewSummary} from '../qianmu-gallery-recipe-review-view.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const tick=()=>new Promise(done=>setTimeout(done,0));
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
test('legacy review presents readable complete prompts before optional raw data, escaping markup and preserving empty values',()=>{
  const text='<script>not markup</script>\n'+'完整'.repeat(10000),html=galleryRecipeReviewSummary({source:'novel',profile:{model:'saved-model'},prompt:text,negative:''});
  assert.match(html,/NovelAI/);assert.match(html,/saved-model/);assert.match(html,/画面提示词/);assert.match(html,/（空）/);assert.match(html,/未记录/);
  assert.equal((html.match(/完整/g)||[]).length,10000);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});
function fixture(overrides={}){
  const events=new Map(),field={value:''},observers=[];let alive=true,opened=0,reads=0,saves=0,closed=0,connectOptions;
  const dialog={open:false,isConnected:false,innerHTML:'',setAttribute(){},addEventListener(k,f){events.set(k,f);},showModal(){this.open=true;},close(){this.open=false;events.get('close')?.();},remove(){this.isConnected=false;},querySelector(s){return s==='textarea'&&this.innerHTML.includes('<textarea')?field:null;}};
  const view={addEventListener(){},removeEventListener(){},MutationObserver:class{constructor(fn){this.callback=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}};
  const parent={isConnected:true,ownerDocument:{body:{},defaultView:view,activeElement:null,createElement:()=>dialog},append(node){node.isConnected=true;}};
  const session={close(){closed++;},async reviewLegacyRecipe(id){reads++;assert.equal(id,'one');return {digest:'d',snapshot:{prompt:'</textarea><script>never execute</script>'}};},async confirmLegacyRecipe(consent){saves++;assert.deepEqual(consent,{confirmed:true,expectedDigest:'d'});return {state:'available',origin:'reviewed-local-copy'};},...overrides};
  const result=open({parent,recordId:'one',isCurrent:()=>alive,connect:async options=>{opened++;connectOptions=options;return session;}});
  return {result,dialog,field,observers,key:(type,event)=>events.get(type)(event),click:action=>events.get('click')({target:{closest:()=>({dataset:{reviewAction:action}})}}),
    get counts(){return {opened,reads,saves,closed};},get options(){return connectOptions;},invalidate(){alive=false;observers[0].callback();}};
}
test('review UI opens with no I/O, requests one item only after read, and never confirms automatically',async()=>{
  const f=fixture();assert.deepEqual(f.counts,{opened:0,reads:0,saves:0,closed:0});
  f.click('confirm');await tick();assert.equal(f.counts.saves,0);f.click('read');await tick();
  assert.equal(f.counts.reads,1);assert.equal(f.counts.saves,0);assert.equal(f.options.preserveOriginals,false);assert.equal(f.options.preserveSupplements,false);
  assert.match(f.field.value,/<script>/);assert.doesNotMatch(f.dialog.innerHTML,/<script>/);
  f.click('confirm');f.click('confirm');await tick();assert.equal(f.counts.saves,1);assert.match(f.dialog.innerHTML,/已保存到当前 ST/);
  f.click('close');assert.deepEqual(await f.result.finished,{saved:true});assert.equal(f.observers[0].disconnected,true);
});
test('closing or scope loss during read does not show late content or save it',async()=>{
  for(const invalidate of [false,true]){
    const held=gate(),f=fixture({reviewLegacyRecipe:()=>held.promise});f.click('read');await tick();
    if(invalidate)f.invalidate();else f.click('close');held.resolve({digest:'d',snapshot:{prompt:'late'}});await tick();
    assert.deepEqual(await f.result.finished,{saved:false});assert.equal(f.dialog.isConnected,false);assert.equal(f.field.value,'');assert.equal(f.counts.saves,0);
  }
});
test('unconfirmed save stays actionable and does not claim success or delete old data',async()=>{
  const f=fixture({confirmLegacyRecipe:async()=>{throw Object.assign(Error('write interrupted'),{writeState:'unconfirmed'});}});
  f.click('read');await tick();f.click('confirm');await tick();assert.match(f.dialog.innerHTML,/保存状态待核对/);assert.doesNotMatch(f.dialog.innerHTML,/已保存到当前 ST/);
  f.click('close');assert.deepEqual(await f.result.finished,{saved:false});
});
test('nested review keeps keyboard defaults but never forwards arrows or escape to lightbox navigation',()=>{
  const f=fixture();let stopped=0;
  for(const type of ['keydown','keypress','keyup'])f.key(type,{key:'Escape',stopPropagation(){stopped++;},preventDefault(){assert.fail('native dialog and textarea defaults stay intact');}});
  assert.equal(stopped,3);f.click('close');
});
test('review has its own bounded layout outside the main Qianmu panel, including scrollable mobile content and neutral footer',async()=>{
  const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sd-storyboard-lightbox dialog\.sd-gallery-recipe-review \{[^}]*100vw[^}]*100dvh/);
  assert.match(css,/\.sd-gallery-recipe-review > main \{[^}]*overflow: auto/);
  assert.match(css,/\.sd-storyboard-lightbox dialog\.sd-gallery-recipe-review > footer \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});
test('actual lightbox review bridge pins the host and schedules preservation only after a confirmed association',async()=>{
  for(const kind of ['saved','cancel','late']){
    let calls=0,scheduled=0;const parent={isConnected:true},metadata={},held=gate();
    const c=vm.createContext({storyboardSnapshotEpoch:0,ctx:()=>({chatMetadata:metadata}),storyboardRequestHeaders:()=>({}),featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=> 'st-user:test'})},
      storyboardScheduleGalleryPreservation:()=>scheduled++,toast:()=>{},loadLocalChunk:async()=>{if(kind==='late')await held.promise;return {openGalleryRecipeReview:options=>{calls++;assert.equal(options.recordId,'one');return {finished:Promise.resolve({saved:kind==='saved'})};}};}});
    vm.runInContext(section('storyboardReviewLegacyRecipe'),c);const work=c.storyboardReviewLegacyRecipe({id:'one'},parent);
    if(kind==='late'){c.storyboardSnapshotEpoch++;held.resolve();}await work;
    assert.equal(calls,kind==='late'?0:1);assert.equal(scheduled,kind==='saved'?1:0);
  }
});
