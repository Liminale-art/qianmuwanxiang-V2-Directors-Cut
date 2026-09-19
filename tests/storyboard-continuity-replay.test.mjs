import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardMessageReference} from '../qianmu-storyboard.js';
import {replayStoryboardContinuityAt as replay} from '../qianmu-storyboard-continuity-events.js';
const paragraphs=[{id:'P1',text:'A穿着外套。'},{id:'P2',text:'A拿起杯子。A脱下外套。'},{id:'P3',text:'A回忆自己穿着蓝色外套。'},{id:'P4',text:'A回过神继续聊天。'},{id:'P5',text:'A放下杯子。'}];
const scope=()=>({chatKey:'chat',messageRef:createStoryboardMessageReference({chatKey:'chat',floor:3,message:{mes:paragraphs.map(p=>p.text).join('\n'),name:'A'},now:1}),paragraphs:structuredClone(paragraphs),branches:[{id:'now',layer:'present'},{id:'memory',layer:'memory'}],subjectIds:['A']});
const event=(id,paragraphId,evidence,extra={})=>({id,paragraphId,evidence,branchId:'now',subjectId:'A',category:'outfit',key:'coat',value:'on',persistence:'persistent',...extra});
const events=[event('on','P1','A穿着外套。'),event('held','P2','A拿起杯子。',{category:'prop',key:'held',value:'cup'}),event('lifting','P2','A拿起杯子。',{category:'action',key:'hand',value:'lifting cup',persistence:'momentary'}),event('off','P2','A脱下外套。',{value:'off'}),event('blue','P3','A回忆自己穿着蓝色外套。',{branchId:'memory',value:'blue'}),event('empty','P5','A放下杯子。',{category:'prop',key:'held',value:'none'})];
const target=(paragraphId,evidence,branchId='now')=>({branchId,paragraphId,evidence});
const state=(result,key)=>result.activeFacts.find(fact=>fact.key===key)?.value;

test('earlier shots never receive later coat removal, even when events arrive in reverse model order',()=>{
 const result=replay([...events].reverse(),scope(),target('P1','A穿着外套。'));
 assert.deepEqual(result.appliedEventIds,['on']);assert.equal(state(result,'coat'),'on');assert.equal(state(result,'held'),undefined);
 const atCup=replay(events,scope(),target('P2','A拿起杯子。'));assert.equal(state(atCup,'coat'),'on');assert.equal(state(atCup,'hand'),'lifting cup');
});
test('unillustrated paragraph changes survive independently of selected or failed pictures; temporary actions do not freeze',()=>{
 const result=replay(events,scope(),target('P4','A回过神继续聊天。'));
 assert.equal(state(result,'coat'),'off');assert.equal(state(result,'held'),'cup');assert.equal(state(result,'hand'),undefined);
 assert.equal(result.facts.find(fact=>fact.id==='lifting').status,'expired');assert.equal(result.facts.find(fact=>fact.id==='on').replacedBy,'off');
 assert.deepEqual(result.facts.find(fact=>fact.id==='off').supersedes,['on']);assert.equal(result.facts.some(fact=>fact.id==='blue'),false);
 const after=replay(events,scope(),target('P5','A放下杯子。'));assert.equal(state(after,'held'),'none');assert.equal(after.facts.find(fact=>fact.id==='held').status,'superseded');
});
test('memory remains its own branch rather than receiving present clothing or replacing present state',()=>{
 const result=replay(events,scope(),target('P3','A回忆自己穿着蓝色外套。','memory'));assert.equal(state(result,'coat'),'blue');assert.equal(state(result,'held'),undefined);assert.deepEqual(result.appliedEventIds,['blue']);
});
test('targets must quote a unique current paragraph and explicit known branch, without fallback to paragraph end or previous floor',()=>{
 for(const point of [target('P4','missing'),target('unknown','A回过神继续聊天。'),target('P4','A回过神继续聊天。','unknown'),{...target('P4','A回过神继续聊天。'),offset:0}])assert.throws(()=>replay(events,scope(),point));
 const options=scope();options.paragraphs[3].text+='A回过神继续聊天。';assert.throws(()=>replay(events,options,target('P4','A回过神继续聊天。')),{code:'storyboard_continuity_grounding'});
 assert.equal(replay([],scope(),target('P4','A回过神继续聊天。')).activeFacts.length,0);
});
test('replaying does not mutate events or expose source prose and snapshots cannot be rewritten by later replay',()=>{
 const input=structuredClone(events),before=structuredClone(input),result=replay(input,scope(),target('P2','A拿起杯子。'));
 replay(input,scope(),target('P5','A放下杯子。'));assert.deepEqual(input,before);assert.equal(state(result,'held'),'cup');assert.ok(Object.isFrozen(result.activeFacts[0]));assert.equal('paragraphs' in result,false);
});

test('matching attributes of another character stay separate and expired replacement never resurrects an older state',()=>{
 const options=scope();options.subjectIds.push('B');options.paragraphs[0].text+='B穿着外套。';
 const changes=[...events,event('b-on','P1','B穿着外套。',{subjectId:'B',value:'B coat'}),event('resting','P1','A穿着外套。',{category:'action',key:'hand',value:'resting'})];
 const result=replay(changes,options,target('P4','A回过神继续聊天。'));
 assert.equal(result.activeFacts.find(f=>f.subject==='A'&&f.key==='coat').value,'off');assert.equal(result.activeFacts.find(f=>f.subject==='B'&&f.key==='coat').value,'B coat');
 assert.equal(result.facts.find(f=>f.id==='resting').status,'superseded');assert.equal(state(result,'hand'),undefined);
});

test('opaque character IDs that differ in case never merge into the legacy lowercased human-name slot',()=>{
 const options=scope();options.subjectIds.push('a');options.paragraphs[0].text+='另一个人物穿蓝外套。';
 const result=replay([...events,event('lowercase','P1','另一个人物穿蓝外套。',{subjectId:'a',value:'blue'})],options,target('P4','A回过神继续聊天。'));
 assert.equal(result.activeFacts.find(f=>f.subject==='A'&&f.key==='coat').value,'off');assert.equal(result.activeFacts.find(f=>f.subject==='a'&&f.key==='coat').value,'blue');
});
