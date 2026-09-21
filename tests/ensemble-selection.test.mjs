import test from 'node:test';
import assert from 'node:assert/strict';
import * as ensemble from '../qianmu-ensemble-selection.js';
import {ensembleStyleOrigins} from '../qianmu-ensemble-origin.js';
const owner='st-user:fixture',chatKey='chat-a',key='a'.repeat(64);
function fixture(){
  const library={schema:ensemble.ENSEMBLE_LIBRARY_SCHEMA,namespace:owner,schemes:[
    {id:'ink',revision:'v1',name:'水墨',description:'静默、留白与回忆',tags:['ink wash','soft contrast'],binding:{routeId:'nai-1',artistPresetId:'ink-artist'}},
    {id:'cg',revision:'v2',name:'CG',description:'场景空间与强烈光影',tags:['CG'],binding:{routeId:'comfy-fixed'}}]};
  const selection={schema:ensemble.ENSEMBLE_SELECTION_SCHEMA,namespace:owner,chatKey,revision:'chosen-1',enabled:true,schemeIds:['ink','cg'],styleLock:true};
  const proof=(revision,formats=['tags'])=>({namespace:owner,chatKey,preparationId:'prepare-1',revision,ready:true,bindingKey:key,promptFormats:formats});
  const eligibility=new Map([['ink',proof('v1')],['cg',proof('v2',['natural_language'])]]),base=proof('base-1');let active=true;
  const options={library,selection,namespace:owner,chatKey,preparationId:'prepare-1',eligibility,base,guard:()=>{if(!active)throw Error('changed owner');}};
  return {...options,open:()=>ensemble.createEnsembleStyleSession(options),stop:()=>{active=false;}};
}
const choose=(scheme='ink',shot='S1')=>({shot_id:shot,scheme_id:scheme,reason:'本镜的留白表现增益'});

test('historical origin selects only an unchanged current binding and does not authorize generation',()=>{
  const f=fixture(),session=f.open(),origin=ensembleStyleOrigins(session.resolve([choose()],['S1']),['S1'])[0];
  assert.equal(session.verifyOrigin({...origin,preparationId:'earlier-batch'}),'ink');assert.equal(origin.executionAuthorized,false);
  for(const change of [v=>v.namespace='st-user:other',v=>v.chatKey='other',v=>v.selectionRevision='other',v=>v.schemeId='missing',v=>v.revision='other',v=>v.bindingKey='b'.repeat(64)]){
    const value={...origin};change(value);assert.throws(()=>session.verifyOrigin(value),{code:'storyboard_style_selection'});
  }
  f.stop();assert.throws(()=>session.verifyOrigin(origin),/changed owner/);
});

test('model catalogue is only the enabled usable style descriptions, never route, workflow or credentials',()=>{
  const f=fixture();f.library.schemes[0].apiKey='secret';f.eligibility.get('ink').workflow={secretGraph:true};f.base.url='https://private.invalid';
  const session=f.open();assert.deepEqual(session.catalogue.map(r=>r.id),['current','ink','cg']);assert.deepEqual(session.promptFormats,['tags','natural_language']);
  assert.doesNotMatch(JSON.stringify(session.catalogue),/secret|nai-1|ink-artist|comfy-fixed|private.invalid|st-user/);assert.ok(Object.isFrozen(session.catalogue[1].tags));
});
test('chat selection cannot inherit another chat or account while the global library remains reusable',()=>{
  for(const mutate of [f=>f.selection.chatKey='another',f=>f.selection.namespace='st-user:another',f=>f.library.namespace='st-user:another']){const f=fixture();mutate(f);assert.throws(f.open,{code:'storyboard_style_selection'});}
  const f=fixture();f.selection.schemeIds=[];assert.deepEqual(f.open().catalogue.map(r=>r.id),['current']);
});
test('disabled ensemble ignores saved active ids, keeps only the current style and does not alter old preferences',()=>{
  const f=fixture();f.selection.enabled=false;const before=JSON.stringify(f.selection),session=f.open();assert.equal(session.enabled,false);
  assert.deepEqual(session.catalogue.map(r=>r.id),['current']);assert.equal(JSON.stringify(f.selection),before);assert.throws(()=>session.resolve([choose()],['S1']));
});
test('missing, archived and technically unavailable choices remain excluded rather than being silently replaced by another route',()=>{
  const f=fixture();f.selection.schemeIds.push('missing');f.library.schemes[0].archived=true;f.eligibility.get('cg').ready=false;
  const session=f.open();assert.deepEqual(session.excluded,[{id:'ink',reason:'archived'},{id:'cg',reason:'technical_gate'},{id:'missing',reason:'missing'}]);assert.deepEqual(session.catalogue.map(r=>r.id),['current']);
  assert.throws(()=>session.resolve([choose('cg')],['S1']));
});
test('each eligibility proof must match this exact preparation, revision, account, chat and supported prompt formats',()=>{
  for(const change of [r=>r.preparationId='old',r=>r.revision='old',r=>r.namespace='st-user:other',r=>r.chatKey='other',r=>r.bindingKey='bad',r=>r.promptFormats=['unknown'],r=>r.promptFormats=[],r=>r.ready='true']){
    const f=fixture();change(f.eligibility.get('ink'));assert.ok(!f.open().catalogue.some(r=>r.id==='ink'));
  }
  const f=fixture();f.base.ready=false;assert.throws(f.open,{code:'storyboard_style_selection'});
});
test('scheme names or imported metadata do not create duplicate, reserved, oversized or implicit enabled selections',()=>{
  for(const change of [f=>f.library.schemes[0].id='current',f=>f.library.schemes[0].id='cg',f=>f.library.schemes[0].description='x'.repeat(801),f=>f.selection.schemeIds=['ink','ink'],f=>f.selection.enabled='true',f=>f.selection.schemeIds=Array.from({length:33},(_,i)=>'style-'+i)]){
    const f=fixture();change(f);assert.throws(f.open,{code:'storyboard_style_selection'});
  }
});
test('selection preserves narrative order, permits repeated styles and returns only pinned ids without execution permission',()=>{
  const f=fixture(),session=f.open(),result=session.resolve([choose('ink','S3'),choose('current','S1'),choose('ink','S2')],['S1','S2','S3']);
  assert.deepEqual(result.assignments.map(r=>r.shotId),['S1','S2','S3']);assert.deepEqual(result.assignments.map(r=>r.schemeId),['current','ink','ink']);
  assert.equal(result.executionAuthorized,false);assert.equal(result.assignments[1].revision,'v1');assert.equal(result.assignments[1].bindingKey,key);assert.ok(Object.isFrozen(result.assignments[1]));
});
test('unknown or disabled scheme, invented route payload, duplicate, extra or missing shots cannot be used as assignments',()=>{
  for(const rows of [[choose('invented')],[{...choose(),route:{providerId:'comfy'}}],[],[choose(),choose()],[choose('ink','S2')],[{...choose(),reason:''}]]){
    assert.throws(()=>fixture().open().resolve(rows,['S1']),{code:'storyboard_style_selection'});
  }
  assert.equal(fixture().open().resolve([{...choose('current'),reason:''}],['S1']).assignments.length,1);
});
test('response schema names only existing shot and style ids and no-illustration plans do not invent one',()=>{
  const session=fixture().open(),schema=session.responseSchema(['S1','S2']);assert.deepEqual(schema.items.properties.shot_id.enum,['S1','S2']);assert.deepEqual(schema.items.properties.scheme_id.enum,['current','ink','cg']);assert.equal(schema.minItems,2);assert.equal(schema.maxItems,2);
  assert.deepEqual(session.resolve([],[]).assignments,[]);assert.throws(()=>session.responseSchema(['S1','S1']));assert.throws(()=>session.responseSchema(Array.from({length:21},(_,i)=>'S'+i)));
});
test('edits to a selected style, reference, selection or eligibility invalidate the pending session, never rewrite frozen results',()=>{
  for(const change of [f=>f.library.schemes[0].name='changed',f=>f.library.schemes[0].binding.routeId='other',f=>f.library.schemes[0].revision='new',f=>f.selection.schemeIds.pop(),f=>f.selection.enabled=false,f=>f.eligibility.get('ink').bindingKey='b'.repeat(64),f=>f.base.revision='new']){
    const f=fixture(),session=f.open(),before=session.resolve([choose()],['S1']);change(f);assert.throws(()=>session.resolve([choose()],['S1']),{code:'storyboard_style_selection'});assert.equal(before.assignments[0].bindingKey,key);
  }
});
test('account or source cancellation stays mandatory at schema and result boundaries',()=>{
  const f=fixture(),session=f.open();f.stop();assert.throws(()=>session.responseSchema(['S1']),/changed owner/);assert.throws(()=>session.resolve([choose()],['S1']),/changed owner/);
});
test('unselected library edits do not pull new styles into the current chat or change already offered choices',()=>{
  const f=fixture();f.selection.schemeIds=['ink'];const session=f.open();f.library.schemes[1].name='later CG';assert.deepEqual(session.resolve([choose()],['S1']).assignments.map(r=>r.schemeId),['ink']);assert.equal(session.catalogue.some(r=>r.id==='cg'),false);
});

test('false or asynchronous guards cannot be mistaken for a successful synchronous source assertion',async()=>{
  const f=fixture();assert.throws(()=>ensemble.createEnsembleStyleSession({...f,guard:()=>false}),{code:'storyboard_style_selection'});
  assert.throws(()=>ensemble.createEnsembleStyleSession({...f,guard:async()=>{throw Error('late');}}),{code:'storyboard_style_selection'});await Promise.resolve();
});

test('declared Comfy character blocks participate alongside tags and natural language without format guessing',()=>{
  const f=fixture();f.eligibility.get('cg').promptFormats=['character_blocks','natural_language'];
  const session=f.open();assert.deepEqual(session.promptFormats,['tags','character_blocks','natural_language']);assert.equal(session.resolve([choose('cg')],['S1']).assignments[0].schemeId,'cg');
  const invalid=fixture();invalid.eligibility.get('cg').promptFormats=['character_blocks','character_blocks'];assert.ok(!invalid.open().catalogue.some(row=>row.id==='cg'));
});
