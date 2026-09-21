import test from 'node:test';
import assert from 'node:assert/strict';
import * as world from '../qianmu-world-shot.js';
import {prepareAutomaticWorldShot} from '../qianmu-world-automatic.js';
import {worldGalleryKeywords} from '../qianmu-world-gallery-keywords.js';
import {createStoryboardDefaults,normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
const vocabulary=['庭院','宁静','相伴'];
const shot=()=>normalizeStoryboardShotSpec({id:'world-1',subject:'garden',promptAtoms:{global:['garden, soft light']},productionContext:{packetId:'world-a'}});
const raw=tags=>JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:{tags:{global:'garden, soft light',negative:'blur',characters:[]}},...(tags===undefined?{}:{gallery_keywords:tags})});
const parse=(value,input=shot(),words=vocabulary)=>world.parseWorldPromptRenderings(raw(value),input,['tags'],{galleryKeywords:words});

test('world keywords share the single confirmed-facts request, with no prose, route or extra expression format',()=>{
  const input=shot(),before=structuredClone(input),request=world.buildWorldPromptRenderingRequest(input,['tags'],{galleryKeywords:vocabulary});
  assert.equal(request.messages.length,2);assert.deepEqual(input,before);
  assert.deepEqual(request.schema.properties.gallery_keywords.items.enum,vocabulary);assert.ok(request.schema.required.includes('gallery_keywords'));
  const payload=JSON.parse(request.messages[1].content);assert.deepEqual(payload.gallery_keyword_vocabulary,vocabulary);assert.equal(payload.truth_mode,'speculative');
  assert.equal(payload.shot.gallery_keywords,undefined);assert.deepEqual(request.formats,['tags']);
  for(const words of [undefined,[]]){const off=world.buildWorldPromptRenderingRequest(input,['tags'],{galleryKeywords:words});assert.equal(off.schema.properties.gallery_keywords,undefined);assert.equal(JSON.parse(off.messages[1].content).gallery_keyword_vocabulary,undefined);}
});

test('world keyword validation is exact, optional only when disabled, and cannot consume a style selection on failure',()=>{
  const checked=parse(['庭院','庭院','宁静']);assert.deepEqual(worldGalleryKeywords(checked),['庭院','宁静']);assert.doesNotMatch(JSON.stringify(checked),/庭院|gallery_keywords/);
  const copy=worldGalleryKeywords(checked);copy.push('相伴');assert.deepEqual(worldGalleryKeywords(checked),['庭院','宁静']);
  for(const words of [undefined,null,'庭院',['未知'],['庭院 '],Array(6).fill('庭院'),[{}]])assert.throws(()=>parse(words),{code:'world_shot_preparation'});
  assert.deepEqual(worldGalleryKeywords(parse([])),[]);assert.deepEqual(worldGalleryKeywords(parse(undefined,shot(),[])),[]);
  assert.throws(()=>parse(['庭院'],shot(),[]),/格式/);
  let accepted=0;assert.throws(()=>world.parseWorldPromptRenderings(raw(['unknown']),shot(),['tags'],{galleryKeywords:vocabulary,styleSelection:{accept(){accepted++;}}}));assert.equal(accepted,0);
});

test('automatic world keywords survive binding and single-use handoff without changing approved facts or the workbench',async()=>{
  const input=shot(),before=structuredClone(input),owner=createStoryboardDefaults(),ownerBefore=structuredClone(owner);let calls=0;
  const result=await prepareAutomaticWorldShot({shot:input,promptFormats:['tags'],guard:async()=>{},prepareRenderings:async current=>{calls++;return parse(['庭院','宁静'],current);}});
  assert.equal(calls,1);assert.deepEqual(input,before);await world.verifyWorldPromptRenderings(result.shot,['tags']);
  assert.equal(result.shot.tags,undefined);assert.equal(result.shot.gallery_keywords,undefined);
  const draft=world.consumeWorldGenerationHandoff(world.createWorldGenerationHandoff(owner,{shotSpec:result.shot,prompt:'garden'}),owner);
  assert.deepEqual(draft.promptDraft.shots[0].tags,['庭院','宁静']);assert.doesNotMatch(draft.prompt,/庭院|宁静/);assert.deepEqual(owner,ownerBefore);
});

test('bad world keywords use the existing shared repair budget, while transport errors add no retries',async()=>{
  let calls=0,tokens=2;const options={shot:shot(),promptFormats:['tags'],guard:async()=>{},repairBudget:{take:()=>tokens-->0},prepareRenderings:async current=>{calls++;return parse(['unknown'],current);}};
  await assert.rejects(prepareAutomaticWorldShot(options),/已修复3次/);assert.equal(calls,3);assert.equal(tokens,-1);
  calls=0;await assert.rejects(prepareAutomaticWorldShot({...options,prepareRenderings:async()=>{calls++;throw Error('offline');}}),/offline/);assert.equal(calls,1);
});

function editorFixture(t,results){
  const saved=Object.fromEntries(['document','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,globalThis[key]]));
  t.after(()=>{for(const[key,value]of Object.entries(saved))value===undefined?delete globalThis[key]:globalThis[key]=value;});
  const root={dataset:{worldFormat:'tags'},open:true,querySelector:selector=>({value:selector==='[data-world-negative]'?'blur':'garden, soft light'})};
  globalThis.document={createElement:()=>({isConnected:false,querySelector:selector=>selector==='[data-world-format="tags"]'?root:{scrollTop:0},querySelectorAll:()=>[root]})};
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  return {POPUP_TYPE:{CONFIRM:1},Popup:class{async show(){return results.shift();}}};
}

test('manual editor preserves validated tags across field editing without sending tags into prompt packs',async t=>{
  const context=editorFixture(t,[1]);let calls=0;
  const result=await world.openWorldPromptRenderingEditor({shot:shot(),promptFormats:['tags'],context,prepareRenderings:async current=>{calls++;return parse(['庭院'],current);}});
  assert.equal(calls,1);assert.deepEqual(worldGalleryKeywords(result),['庭院']);await world.verifyWorldPromptRenderings(result,['tags']);
  assert.doesNotMatch(JSON.stringify(result.promptRenderingPack),/庭院|gallery_keywords/);
});

test('manual-only editor and failed re-render do not inherit stale tags or make a hidden tagging request',async t=>{
  const context=editorFixture(t,[1,2,1]);let calls=0;
  const manual=await world.openWorldPromptRenderingEditor({shot:shot(),promptFormats:['tags'],context,manual:true,prepareRenderings:async()=>{calls++;assert.fail('manual mode must not call');}});
  assert.equal(calls,0);assert.deepEqual(worldGalleryKeywords(manual),[]);
  const fallback=await world.openWorldPromptRenderingEditor({shot:shot(),promptFormats:['tags'],context,prepareRenderings:async current=>{calls++;if(calls===2)throw Error('offline');return parse(['庭院'],current);}});
  assert.equal(calls,2);assert.deepEqual(worldGalleryKeywords(fallback),[]);
});
