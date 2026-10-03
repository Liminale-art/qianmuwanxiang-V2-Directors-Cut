import test from 'node:test';
import assert from 'node:assert/strict';
import {STORYBOARD_STILL_NARRATIVE_INSTRUCTIONS as narrative,STORYBOARD_STILL_EXPRESSION_INSTRUCTIONS as expression,storyboardStillFormatInstructions as formats} from '../qianmu-still-frame-instructions.js';
import {buildWorldPromptRenderingRequest} from '../qianmu-world-shot.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
const shot=()=>normalizeStoryboardShotSpec({subject:'Two adults cooking in a kitchen',characters:[{id:'a',name:'A'},{id:'b',name:'B'}],promptAtoms:{global:['warm kitchen']}});

test('format guidance includes only declared capabilities, deduplicates them and never guesses custom graph architecture',()=>{
  assert.match(formats([]),/未声明表达格式/);assert.doesNotMatch(formats([]),/tags：|natural_language：|character_blocks：/);
  for(const format of ['tags','natural_language','character_blocks']){
    const text=formats([format,format]);assert.equal(text.split(format+'：').length-1,1);
    for(const other of ['tags','natural_language','character_blocks'].filter(item=>item!==format))assert.equal(text.includes(other+'：'),false);
  }
  assert.throws(()=>formats(['guessed']),/格式/);
});

for(const selected of [false,true])test(`world uses authored shared expression once but no narrative planning or unselected style request, selected ${selected}`,()=>{
  const options=selected?{styleSelection:{request:()=>({catalogue:[{id:'current',name:'Current'}],schema:{type:'array'}})}}:{};
  const spec=shot(),before=structuredClone(spec),request=buildWorldPromptRenderingRequest(spec,['natural_language'],options);
  assert.equal(request.messages.length,2);const system=JSON.parse(request.messages[0].content),payload=JSON.parse(request.messages[1].content);
  assert.equal(system.operation,'render_confirmed_visual_facts');assert.equal(system.source_mutation,false);
  for(const rule of expression)assert.equal(system.instructions.filter(item=>item===rule).length,1);
  for(const rule of narrative)assert.equal(system.instructions.includes(rule),false);
  assert.equal(system.instructions.includes(formats(['natural_language'])),true);
  assert.equal(JSON.stringify(system.instructions).includes('从style_catalogue'),selected);
  assert.equal(request.schema.required.includes('style_selections'),selected);
  assert.equal(payload.style_instruction,undefined);assert.equal(payload.truth_mode,'speculative');assert.deepEqual(spec,before);
});

test('still guidance preserves narrative-led framing and ownership without introducing executable fields',()=>{
  assert.ok(Object.isFrozen(narrative)&&Object.isFrozen(expression));
  const first=narrative.join('\n'),second=expression.join('\n');assert.match(first,/镜头少时/);assert.match(first,/镜头多时/);
  assert.match(first,/min_shots_target是期望下限/);assert.match(first,/allowed_ratio_ids/);assert.match(first,/摄影选择不是正文事件/);
  assert.match(first,/给定人设、已选世界书或原文明示的人物性别与当前可见稳定形象写入各自fixed_identity/);
  assert.match(first,/不靠姓名推断/);assert.match(first,/衣着和当前状态仍写各自字段，未知留空，不新增来源或人物/);
  assert.match(second,/不使用“同上”/);assert.match(second,/接触部位|身体部位/);assert.match(second,/帧率、声音不是静帧提示/);
  assert.match(second,/最终生图提示默认使用英文/);assert.match(second,/客观描述可见人数、已知性别与外貌、服装、动作、环境和空间关系/);
  assert.match(second,/人物姓名与character_id只供内部关联/);assert.match(second,/谁的哪一部位接触谁的哪里/);
  assert.match(second,/未知性别、外貌、身体部位或左右关系不猜测/);assert.match(second,/且合同要求natural_language时使用自然语言/);
  assert.match(formats(['tags']),/不以孤立动作标签丢失归属/);assert.match(formats(['tags']),/不用姓名或character_id充当视觉标签/);
  assert.doesNotMatch(first+second,/https?:\/\/|apiKey|POST|\/prompt/);
});
