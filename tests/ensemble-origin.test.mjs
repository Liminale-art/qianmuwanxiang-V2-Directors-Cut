import test from 'node:test';
import assert from 'node:assert/strict';
import {ENSEMBLE_STYLE_ORIGIN_SCHEMA as schema,ensembleStyleOrigins,normalizeEnsembleStyleOrigin as normalize,retainEnsembleStyleOrigin as retain} from '../qianmu-ensemble-origin.js';
import {normalizeStoryboardState,sanitizeStoryboardSnapshot} from '../qianmu-storyboard.js';
import {captureStoryboardHistoryData,assertStoryboardHistoryRetained} from '../qianmu-storyboard-package-history.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const receipt=()=>({namespace:'st-user:fixture',chatKey:'chat-a',preparationId:'prep-1',selectionRevision:'choice-2',executionAuthorized:false,
  assignments:[1,2,3].map(n=>({shotId:`S${n}`,schemeId:n===3?'current':`style-${n}`,revision:`r${n}`,bindingKey:String(n).repeat(64),reason:'fixture only',route:{baseUrl:'must not be copied'},apiKey:'must not be copied'}))});
const origin=()=>ensembleStyleOrigins(receipt(),['S2'])[0];

test('style provenance retains exact scope and revisions without exposing routes, prompts or credentials',()=>{
  const value=origin();assert.deepEqual(value,{schema,namespace:'st-user:fixture',chatKey:'chat-a',preparationId:'prep-1',selectionRevision:'choice-2',
    shotId:'S2',schemeId:'style-2',revision:'r2',bindingKey:'2'.repeat(64),executionAuthorized:false});
  assert.ok(Object.isFrozen(value));assert.doesNotMatch(JSON.stringify(value),/reason|apiKey|baseUrl|route|prompt/);
});

test('omitted shots keep original S identities and current is an explicit style, never inferred from model identity',()=>{
  const values=ensembleStyleOrigins(receipt(),['S2','S3']);assert.deepEqual(values.map(row=>[row.shotId,row.schemeId]),[['S2','style-2'],['S3','current']]);assert.ok(Object.isFrozen(values));
});

test('missing, duplicate, invented or over-budget origins fail rather than partially preserving a batch',()=>{
  for(const ids of [[],['S4'],['S1','S1'],Array.from({length:21},(_,i)=>`S${i+1}`),null])assert.throws(()=>ensembleStyleOrigins(receipt(),ids),{code:'ensemble_style_origin'});
  const value=receipt();value.assignments.push(copy(value.assignments[0]));assert.throws(()=>ensembleStyleOrigins(value,['S1']),{code:'ensemble_style_origin'});
});

test('origins cannot gain execution authority and reject incomplete, future or injected fields',()=>{
  for(const change of [v=>v.executionAuthorized=true,v=>delete v.executionAuthorized,v=>v.schema='future',v=>v.route={},v=>v.apiKey='secret',v=>delete v.bindingKey,v=>v.bindingKey='partial',
    v=>v.namespace='other',v=>v.namespace+='\n',v=>v.chatKey='',v=>v.chatKey='x'.repeat(1025),v=>v.preparationId='bad id',v=>v.selectionRevision='',v=>v.shotId='S01',v=>v.revision='']){
    const value=copy(origin());change(value);assert.throws(()=>normalize(value),{code:'ensemble_style_origin'});
    const invalid=retain(value);assert.deepEqual(invalid,{schema,invalid:true,executionAuthorized:false});assert.deepEqual(retain(invalid),invalid);
  }
});

test('style origin numbers use exact positive safe integers, independent of narrative examples',()=>{
  for(const shotId of ['S7','S13','S21','S169',`S${Number.MAX_SAFE_INTEGER}`])assert.equal(normalize({...origin(),shotId}).shotId,shotId);
  for(const shotId of ['S0','S01','S-1','S1.5','S1e2','S+1','S1 ','S9007199254740992','S999999999999999999999999',1,null]){
    assert.throws(()=>normalize({...origin(),shotId}),{code:'ensemble_style_origin'});
  }
});

test('snapshot sanitizer preserves the typed bindingKey through repeated log/gallery reloads without weakening general credential scrubbing',()=>{
  const value=origin();let snapshot={source:'novel',ensembleStyleOrigin:value,apiKey:'secret',arbitrary:{authorization:'secret'}};
  for(let i=0;i<3;i++)snapshot=sanitizeStoryboardSnapshot(copy(snapshot));
  assert.deepEqual(snapshot.ensembleStyleOrigin,value);assert.doesNotMatch(JSON.stringify(snapshot),/secret/);
  let state={logs:[{id:'log-1',source:'novel',snapshot}]};for(let i=0;i<3;i++)state=normalizeStoryboardState(copy(state));
  assert.deepEqual(state.logs[0].snapshot.ensembleStyleOrigin,value);
});

test('legacy snapshots do not invent origins; invalid origins do not become plausible partial metadata',()=>{
  assert.equal(Object.hasOwn(sanitizeStoryboardSnapshot({}),'ensembleStyleOrigin'),false);
  for(const value of [null,{}, {...origin(),executionAuthorized:true}]){
    let snapshot={ensembleStyleOrigin:value};for(let i=0;i<2;i++)snapshot=sanitizeStoryboardSnapshot(snapshot);
    assert.deepEqual(snapshot.ensembleStyleOrigin,{schema,invalid:true,executionAuthorized:false});
  }
});

test('portable historical logs retain complete descriptive style identity across normalization',()=>{
  const before=normalizeStoryboardState({logs:[{id:'log-1',source:'novel',status:'success',snapshot:{ensembleStyleOrigin:origin()}}]});
  const captured=captureStoryboardHistoryData(before),after=normalizeStoryboardState(copy(before));
  assert.doesNotThrow(()=>assertStoryboardHistoryRetained(captured,after));assert.deepEqual(after.logs[0].snapshot.ensembleStyleOrigin,origin());
});
