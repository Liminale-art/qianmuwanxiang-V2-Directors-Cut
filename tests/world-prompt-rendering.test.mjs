import test from 'node:test';
import assert from 'node:assert/strict';
import * as world from '../qianmu-world-shot.js';
import * as formats from '../qianmu-prompt-formats.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
const shot=()=>normalizeStoryboardShotSpec({subject:'厨房',promptAtoms:{global:['两人在厨房']},characters:[{id:'a',name:'Alice',identity:['blue hair']},{id:'b',name:'Bob',action:['holds letter']}]});
const values=(requested=['tags'])=>Object.fromEntries(requested.map(format=>[format,{global:'kitchen',negative:'',characters:[{character_id:'b',positive:'holds letter'},{character_id:'a',positive:'blue hair'}]}]));
const raw=(value=values())=>JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:value});

test('world machine contract contains only approved visual facts and exact reachable formats, with bounded output budget',()=>{
  const input=shot();input.apiKey='secret-key';input.productionContext={authority:'private'};input.characters[0].archiveSnapshot={reference:'private-image',implementation:'private-workflow'};
  const request=world.buildWorldPromptRenderingRequest(input,['character_blocks','tags','natural_language']);
  assert.deepEqual(request.formats,['tags','natural_language','character_blocks']);assert.equal(request.maxTokens,4600);
  assert.doesNotMatch(JSON.stringify(request),/secret-key|private-image|private-workflow|private"/);
  assert.equal(JSON.parse(request.messages[1].content).truth_mode,'speculative');
  assert.deepEqual(request.schema.properties.prompt_renderings.required,request.formats);
  assert.throws(()=>world.buildWorldPromptRenderingRequest(input,[]),/未声明/);
  assert.throws(()=>world.buildWorldPromptRenderingRequest(input,['auto']),/格式/);
});

test('world parser accepts JSON and a sole fence, preserves exact character ownership and rejects structural drift or oversize',()=>{
  const input=shot();const result=world.parseWorldPromptRenderings('```json\n'+raw()+'\n```',input,['tags']);
  assert.deepEqual(result.tags.characters.map(row=>row.character_id),['a','b']);assert.equal(result.tags.characters[0].positive,'blue hair');
  const wrong=values();wrong.tags.characters[0].character_id='c';assert.throws(()=>world.parseWorldPromptRenderings(raw(wrong),input,['tags']),/未出镜/);
  const duplicate=values();duplicate.tags.characters[0].character_id='a';assert.throws(()=>world.parseWorldPromptRenderings(raw(duplicate),input,['tags']),/重复/);
  for(const bad of ['text '+raw(),'{}',raw().replace(world.WORLD_RENDERING_SCHEMA,'wrong'),'x'.repeat(100000),JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:values(),extra:true})]){
    assert.throws(()=>world.parseWorldPromptRenderings(bad,input,['tags']));
  }
  assert.throws(()=>world.parseWorldPromptRenderings(raw(),input,['natural_language']),/格式|字段/);
});

test('world expression verification rejects edited source facts and cancellation while excluding archive-only changes from facts hash',async()=>{
  const input=shot();input.promptRenderingPack=await formats.bindStoryboardPromptRenderings(input,values());await world.verifyWorldPromptRenderings(input,['tags']);
  input.characters[0].archiveSnapshot={private:'unused'};await world.verifyWorldPromptRenderings(input,['tags']);
  await assert.rejects(()=>world.verifyWorldPromptRenderings(input,['tags'],()=>{throw Error('cancelled');}),/cancelled/);
  input.characters[0].identity=['red hair'];await assert.rejects(()=>world.verifyWorldPromptRenderings(input,['tags']),/已变化/);
});

test('world expression editor escapes all imported content and validates format names before creating selector markup',()=>{
  const input=shot(),v=values();input.characters[0].name='<img onerror=alert(1)>';v.tags.global='</textarea><script>x</script>';
  const html=world.renderWorldPromptRenderingEditor(input,['tags'],v,'<svg onload=bad>');assert.doesNotMatch(html,/<img|<script|<svg/);
  assert.match(html,/&lt;script/);assert.throws(()=>world.renderWorldPromptRenderingEditor(input,['" onclick="bad'],v));
});
