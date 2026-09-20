import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
import {buildStoryboardPlanContractRequest} from '../qianmu-storyboard-contract.js';
import {assertStoryboardInputBudget,STORYBOARD_INPUT_MAX_BYTES} from '../qianmu-storyboard-complete-context.js';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
import {normalizeStoryboardParagraphSelection} from '../qianmu-storyboard.js';
test('manual paragraph selection keeps every selected paragraph and the real last insertion point',()=>{const selection=normalizeStoryboardParagraphSelection({mode:'manual_supplement',indexes:Array.from({length:281},(_,i)=>i)});assert.equal(selection.indexes.length,281);assert.equal(selection.indexes.at(-1),280);});
test('selected narrative and settings retain their tails, including paragraphs beyond 240',()=>{
 const long='叙事'.repeat(6500)+'最后脱下外套。',paragraphs=Array.from({length:280},(_,i)=>'片段'+i);paragraphs[279]=long;
 const context={messages:[{floor:8,role:'character',text:long}],paragraphs,currentCharacter:long,persona:long,world:long+long};
 const payload=JSON.parse(buildStoryboardPlanContractRequest(context).messages[1].content);
 assert.equal(payload.target_paragraphs.length,280);assert.equal(payload.target_paragraphs[279].text,long);assert.equal(payload.recent_messages[0].text,long);
 assert.equal(payload.character_setting,long);assert.equal(payload.user_persona,long);assert.equal(payload.selected_worldbook,long+long);
});
test('oversize context fails explicitly instead of producing a partial outbound request',()=>{
 const text='a'.repeat(STORYBOARD_INPUT_MAX_BYTES+1);assert.throws(()=>assertStoryboardInputBudget(text),{code:'storyboard_input_capacity'});
 assert.throws(()=>buildStoryboardPlanContractRequest({paragraphs:[text]}),/未发送、未截断/);
});
test('internal world/casting copies do not count twice against the actual outbound budget',()=>{
 const world='w'.repeat(600000);const request=buildStoryboardPlanContractRequest({world,worldRows:[{item:{content:world}}]});assert.equal(JSON.parse(request.messages[1].content).selected_worldbook,world);
});
test('missing selected world entries stop compilation without interpreting a failed directory as deselection',async()=>{
 const state={promptCompiler:{worldBookNames:['book'],worldEntryIds:['book::1','book::2']}};
 const context=vm.createContext({Set,storyboardWorldEntryCache:{rows:[{id:'book::1',book:'book',title:'one',item:{content:'one'}}]},
  storyboardWarmCompilerWorldEntries:async()=>{state.promptCompiler.worldBookNames=[];return [];},storyboardLoadCompilerWorldBook:async()=>[],resolveMacro:async v=>v,storyboardCleanMessageText:v=>v});
 vm.runInContext(storyboardFunctionSource('storyboardCompilerWorldText'),context);await assert.rejects(()=>context.storyboardCompilerWorldText(state),{code:'storyboard_context_unavailable'});
});
test('runtime compiler keeps selected floor range and complete tail without enlarging the selection',async()=>{
 const tail='甲'.repeat(7000)+'拿起杯子',chat=[{mes:'outside'},{mes:tail},{mes:tail,is_user:true},{mes:tail}];
 const state={promptCompiler:{includeRecentFloors:2,includeCharacterCards:true,includeUserPersona:true},profiles:{},paragraphMode:'auto'};
 const context=vm.createContext({ctx:()=>({chat}),storyboardTargetFloor:()=>3,storyboardCleanWithTagRules:x=>x,storyboardCleanMessageText:x=>x,
  cleanContextText:x=>x,resolveMacro:async x=>x,getCharacterDescription:()=>tail,getPersonaDescription:()=>tail,storyboardMessageParagraphs:x=>[x],
  storyboardCompilerWorldText:async()=>({text:tail,rows:[]}),storyboardUsesComfyCharacters:()=>false,storyboardCompilerCharacterCasting:async()=>({prepared:{}})});
 vm.runInContext(storyboardFunctionSource('storyboardCompilerContext'),context);const out=await context.storyboardCompilerContext(state);
 assert.deepEqual(Array.from(out.messages,x=>x.floor),[1,2,3]);assert.equal(out.messages[2].text,tail);assert.equal(out.currentCharacter,tail);assert.equal(out.persona,tail);
 const source=await readFile(new URL('../index.js',import.meta.url),'utf8');const parser=source.slice(source.indexOf('function storyboardMessageParagraphs('),source.indexOf('function storyboardParagraphTokenSet('));assert.doesNotMatch(parser,/slice\(0,\s*240\)/);
});
