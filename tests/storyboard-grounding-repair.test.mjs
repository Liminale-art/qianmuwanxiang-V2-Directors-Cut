import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../qianmu-storyboard-contract.js';
import {STORYBOARD_NARRATIVE_SCHEMA as NARRATIVE,STORYBOARD_EXPRESSION_SCHEMA as EXPRESSION} from '../qianmu-storyboard-focused-extraction.js';
import {response as basePlan} from './helpers/comfy-compiler-fixture.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const paragraphs = () => ['林岚走进安静的阅览室。','窗边的台灯映亮桌面。','她把折好的信放在桌角。',
  '门外传来轻轻的脚步声。','林岚脱下外套，搭在椅背上。','她坐到桌前，翻开面前的书。'];
const roster = () => ({branches:[{id:'now',layer:'present'}],subjectIds:['A']});
const event = overrides => ({id:'coat',branchId:'now',paragraphId:'P5',subjectId:'A',category:'outfit',key:'coat',
  value:'removed',persistence:'persistent',evidence:paragraphs()[4],...overrides});

// Only synthetic text and the existing exported plan skeleton are used here.
// The window, source binding, continuity publication and two-stage runner are real.
async function fixture({target = paragraphs(),referenceFloors = 2} = {}) {
  const effects = [], calls = [];
  let saves = 0;
  const host = {chatId:'grounding-fixture',characterId:0,characters:[{avatar:'synthetic.png',chat:'grounding-fixture'}],
    chatMetadata:{story_director_liminale:{}},
    chat:Array.from({length:27},(_,floor) => ({mes:floor === 26 ? target.join('\n\n') : `UNSELECTED_FLOOR_${floor}`,
      name:'林岚',is_user:false,send_date:String(floor)})),
    async saveMetadata() { saves++; }};
  host.chat[24].mes = 'OTHER_SELECTED_FLOOR_24';
  host.chat[25].mes = 'OTHER_SELECTED_FLOOR_25';
  const window = await contract.captureStoryboardCompilerSources({floor:26,referenceFloors,getContext:() => host,epoch:() => 0,
    isCurrent:() => true,resolveNamespace:async () => 'st-user:synthetic-grounding',readText:message => message.mes,
    readParagraphs:message => message.mes.split('\n\n').map((text,index) => ({id:`P${index+1}`,text}))});
  const store = contract.openStoryboardCompilerContinuity(window);
  const context = {floor:26,messages:window.messages,paragraphs:window.paragraphs,currentCharacter:'PRIVATE_CHARACTER_SENTINEL',
    persona:'PRIVATE_PERSONA_SENTINEL',world:'PRIVATE_WORLD_SENTINEL',compilerSources:window,continuity:await store.read()};
  const request = contract.buildStoryboardPlanContractRequest(context,{focused:true,providerId:'novel',promptFormats:['tags'],
    maxShots:1,minShots:1,allowedRatioIds:['3:2']});
  const shot = basePlan().shots[0];
  delete shot.prompt_atoms;
  delete shot.prompt_renderings;
  Object.assign(shot,{source_paragraph_ids:['P6'],insert_after:'P6',state_point:{branchId:'now',paragraphId:'P6',evidence:target[5]}});
  shot.characters[0].name = '林岚';
  const narrative = {schema:NARRATIVE,should_generate:true,skip_reason:'',shots:[shot],
    source_states:[{floor:26,roster:roster(),events:[event()]},...window.sources.filter(source => source.messageRef.lastKnownFloor !== 26)
      .map(source => ({floor:source.messageRef.lastKnownFloor,roster:roster(),events:[]}))],continuity_links:[],decisions:[]};
  const expression = () => ({schema:EXPRESSION,shots:[{shot_id:'S1',prompt_atoms:{global:['reading room'],character_ids:['A'],scene_negative:['extra people']},
    prompt_renderings:{tags:{global:'reading room, warm light',characters:[{character_id:'A',positive:'silver hair, coat removed, reading a book'}],negative:'extra people'}}}]});
  return {host,window,store,request,narrative,expression,calls,effects,get saves() { return saves; },
    run:call => contract.completeStoryboardFocusedExtraction({raw:JSON.stringify(narrative),context,request,guard:window.guard,
      publish:async records => { effects.push('publish'); return store.publish(records); },
      call:async (messages,definition) => {
        calls.push({messages:copy(messages),definition:copy(definition),saves});
        effects.push(definition.repair ? 'repair' : 'expression');
        return call(messages,definition);
      }}),
    close() { store.close(); window.close(); }};
}

function repairPayload(call) { return JSON.parse(call.messages[1].content); }
function assertPrivateScope(payload) {
  assert.deepEqual(payload.context.evidence_sources.map(source => source.floor),[26]);
  assert.doesNotMatch(JSON.stringify(payload),/OTHER_SELECTED_FLOOR_|UNSELECTED_FLOOR_|PRIVATE_CHARACTER_|PRIVATE_PERSONA_|PRIVATE_WORLD_|st-user:/);
}

// This deterministic model only follows the received field path and unique
// candidate. It does not receive the fixture, correct paragraph or event index.
function followGroundingDiagnostic(messages) {
  const payload = JSON.parse(messages[1].content), corrected = JSON.parse(payload.response), issue = payload.errors[0];
  const path = /^\$\.source_states\[(\d+)\]\.events\[(\d+)\]\.evidence$/.exec(issue.path);
  if (path && issue.detail === 'evidence_not_found' && typeof issue.hint === 'string'
    && issue.hint.includes('段落') && issue.candidateParagraphIds?.length === 1) {
    corrected.source_states[Number(path[1])].events[Number(path[2])].paragraphId = issue.candidateParagraphIds[0];
  }
  return JSON.stringify(corrected);
}

test('a valid Chinese grounded narrative publishes once and requests expression without a repair',async () => {
  const f = await fixture();
  try {
    const result = await f.run(async () => JSON.stringify(f.expression()));
    assert.equal(result.meta.repairCalls,0);
    assert.deepEqual(f.effects,['publish','expression']);
    assert.equal(f.saves,1);
  } finally { f.close(); }
});

for (const eventIndex of [0,6]) test(`received grounding diagnostic alone repairs Chinese P5 evidence attached to P6 at event ${eventIndex}`,async () => {
  const f = await fixture();
  f.narrative.source_states[0].events = [...Array.from({length:eventIndex},(_,index) => event({id:`earlier-${index}`,key:`slot-${index}`,paragraphId:'P1',evidence:paragraphs()[0]})),
    event({paragraphId:'P6'})];
  const before = copy(f.narrative);
  try {
    const result = await f.run(async (messages,definition) => definition.schemaId === NARRATIVE
      ? followGroundingDiagnostic(messages) : JSON.stringify(f.expression()));
    assert.equal(result.meta.repairCalls,1);
    assert.equal(f.calls.length,2);
    assert.deepEqual(f.effects,['repair','publish','expression']);
    assert.equal(f.calls[0].saves,0);
    assert.equal(f.calls[1].saves,1);
    const payload = repairPayload(f.calls[0]), issue = payload.errors[0];
    assert.equal(issue.code,'source_evidence');
    assert.equal(issue.path,`$.source_states[0].events[${eventIndex}].evidence`);
    assert.equal(issue.detail,'evidence_not_found');
    assert.match(issue.hint,/逐字|原文/);
    assert.deepEqual(issue.candidateParagraphIds,['P5']);
    assertPrivateScope(payload);
    assert.equal(JSON.parse(payload.response).source_states[0].events[eventIndex].paragraphId,'P6','validation does not silently move the event');
    assert.equal(result.trace.narrative.source_states[0].events[eventIndex].paragraphId,'P5');
    assert.deepEqual(f.narrative,before,'the caller response stays untouched');
  } finally { f.close(); }
});

async function rejectedWithoutPublication(f,{detail,field='evidence',candidate=[]} = {}) {
  const before = copy(f.narrative);
  await assert.rejects(f.run(async messages => JSON.parse(messages[1].content).response),error => {
    assert.equal(error.code,'storyboard_contract_failed');
    assert.equal(error.diagnostic.stage,'narrative');
    assert.equal(error.diagnostic.repairCalls,3);
    assert.equal(error.diagnostic.repairBudgetUsed,3);
    assert.equal(error.diagnostic.stopReason,'budget_exhausted');
    assert.deepEqual(error.diagnostic.reasonCodes,['source_evidence']);
    assert.deepEqual(error.diagnostic.completedStages,[]);
    assert.doesNotMatch(JSON.stringify(error.diagnostic),/林岚|source_states|paragraphId|candidateParagraphIds|PRIVATE_|UNSELECTED_/,'persistable failure remains code-only');
    return true;
  });
  assert.equal(f.saves,0);
  assert.deepEqual(f.effects,['repair','repair','repair']);
  assert.equal(f.calls.length,3);
  for (const call of f.calls) {
    assert.equal(call.definition.schemaId,NARRATIVE);
    assert.equal(call.definition.repair,true);
    assert.equal(call.saves,0);
    const payload = repairPayload(call), issue = payload.errors[0];
    assert.equal(issue.code,'source_evidence');
    assert.equal(issue.path,`$.source_states[0].events[0].${field}`);
    assert.equal(issue.detail,detail);
    assert.equal(typeof issue.hint,'string');
    assert.ok(issue.hint.length > 0);
    assert.deepEqual(issue.candidateParagraphIds || [],candidate);
    assertPrivateScope(payload);
    assert.deepEqual(JSON.parse(payload.response),before);
  }
  assert.deepEqual(f.narrative,before);
}

test('an exact quote in multiple paragraphs is not a unique repair candidate and is never relocated automatically',async () => {
  const target = paragraphs(); target[1] = target[4];
  const f = await fixture({target}); f.narrative.source_states[0].events[0].paragraphId = 'P6';
  try { await rejectedWithoutPublication(f,{detail:'evidence_not_found'}); } finally { f.close(); }
});

test('repeating the quote inside its declared paragraph stays invalid without a guessed occurrence',async () => {
  const target = paragraphs(); target[4] += target[4];
  const f = await fixture({target});
  try { await rejectedWithoutPublication(f,{detail:'evidence_not_unique'}); } finally { f.close(); }
});

for (const [label,change,detail,field] of [
  ['invented quote',row => { row.evidence = '这句话从未出现在所选正文中。'; },'evidence_not_found','evidence'],
  ['undeclared branch',row => { row.branchId = 'invented-branch'; },'unknown_branch','branchId'],
  ['undeclared subject',row => { row.subjectId = 'invented-subject'; },'unknown_subject','subjectId'],
]) test(`strict ${label} validation still exhausts exactly three repairs before publication or expression`,async () => {
  const f = await fixture(); change(f.narrative.source_states[0].events[0]);
  try { await rejectedWithoutPublication(f,{detail,field}); } finally { f.close(); }
});

test('a quote present only on another selected floor never becomes a candidate for this source event',async () => {
  const f = await fixture(); f.narrative.source_states[0].events[0].evidence = 'OTHER_SELECTED_FLOOR_24';
  try {
    await assert.rejects(f.run(async messages => JSON.parse(messages[1].content).response),{code:'storyboard_contract_failed'});
    assert.equal(f.calls.length,3);
    for (const call of f.calls) {
      const payload = repairPayload(call);
      assert.equal(payload.errors[0].detail,'evidence_not_found');
      assert.deepEqual(payload.errors[0].candidateParagraphIds || [],[]);
      assert.deepEqual(payload.context.evidence_sources.map(source => source.floor),[26]);
      assert.doesNotMatch(JSON.stringify(payload.context),/OTHER_SELECTED_FLOOR_|UNSELECTED_FLOOR_|PRIVATE_/);
    }
    assert.equal(f.saves,0);
    assert.deepEqual(f.effects,['repair','repair','repair']);
  } finally { f.close(); }
});

test('a grounding correction consumes the same three-repair budget, leaving only two expression repairs',async () => {
  const f = await fixture(); f.narrative.source_states[0].events[0].paragraphId = 'P6';
  try {
    await assert.rejects(f.run(async (messages,definition) => definition.schemaId === NARRATIVE
      ? followGroundingDiagnostic(messages) : JSON.stringify({schema:EXPRESSION,shots:[]})),error => {
      assert.equal(error.code,'storyboard_contract_failed');
      assert.equal(error.diagnostic.stage,'expression');
      assert.equal(error.diagnostic.repairCalls,3);
      assert.equal(error.diagnostic.repairBudgetUsed,3);
      assert.equal(error.diagnostic.stopReason,'budget_exhausted');
      assert.deepEqual(error.diagnostic.completedStages,['narrative']);
      return true;
    });
    assert.equal(f.calls.filter(call => call.definition.schemaId === NARRATIVE).length,1);
    assert.equal(f.calls.filter(call => call.definition.schemaId === EXPRESSION && call.definition.repair).length,2);
    assert.equal(f.calls.length,4,'one narrative repair, one expression request and two expression repairs');
    assert.deepEqual(f.effects,['repair','publish','expression','repair','repair']);
    assert.equal(f.saves,1,'only the corrected narrative is published, never the invalid original');
    for (const call of f.calls.filter(call => call.definition.schemaId === EXPRESSION)) {
      assert.doesNotMatch(JSON.stringify(call.messages),/OTHER_SELECTED_FLOOR_|UNSELECTED_FLOOR_|PRIVATE_CHARACTER_|PRIVATE_PERSONA_|PRIVATE_WORLD_/);
    }
  } finally { f.close(); }
});
