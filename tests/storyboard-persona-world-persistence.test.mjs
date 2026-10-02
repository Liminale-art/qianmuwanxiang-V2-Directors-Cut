import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardDefaults,normalizeStoryboardState} from '../qianmu-storyboard.js';
import {captureStoryboardPackageSettings} from '../qianmu-storyboard-package-fields.js';
import {prepareStoryboardPackageDraft} from '../qianmu-storyboard-package-draft.js';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {inspectStoryboardPackageFile} from '../qianmu-storyboard-package-input.js';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';

const clone = structuredClone;
const namespace = 'st-user:fixture';
const record = (overrides = {}) => ({kind:'user',owner:'synthetic-user.png',book:'Synthetic book',entryIds:['Synthetic book::1'],enabled:true,...overrides});
const stateWith = records => {
  const value = createStoryboardDefaults();
  Object.assign(value.promptCompiler,{worldBookNames:['Manual book'],worldEntryIds:['Manual book::1'],personaWorldSelections:clone(records)});
  return normalizeStoryboardState(value);
};
const sourceRecords = () => [record(),record({kind:'char',owner:'synthetic-character.png',entryIds:[]}),
  record({owner:'paused-user.png',entryIds:['Synthetic book::2'],enabled:false})];
const largeRecords = () => Array.from({length:125},(_,index) => record({owner:`synthetic-user-${index}.png`,
  entryIds:Array.from({length:index === 0 ? 150 : 1},(_,entry) => `Synthetic book::${entry}`)}));
const prepare = (settings,incoming) => prepareStoryboardPackageDraft({settings,chat:{},incoming,images:[],collections:[],chatKey:'chat-a',namespace,sourceNamespace:namespace});
async function portableFile(settings) {
  const payload = {type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings,chat:{images:[],collections:[]}};
  return (await buildStoryboardVibePackage(payload,{namespace,load:() => assert.fail('synthetic selection package has no media')})).file;
}

test('new and legacy states start without persona confirmation and never promote manual selections',() => {
  const fresh = createStoryboardDefaults(), other = createStoryboardDefaults();
  assert.deepEqual(fresh.promptCompiler.personaWorldSelections,[]);
  fresh.promptCompiler.personaWorldSelections.push(record());
  assert.deepEqual(other.promptCompiler.personaWorldSelections,[]);
  const legacy = createStoryboardDefaults();
  delete legacy.promptCompiler.personaWorldSelections;
  Object.assign(legacy.promptCompiler,{worldBookNames:['Manual book'],worldEntryIds:['Manual book::1']});
  const normalized = normalizeStoryboardState(legacy);
  assert.deepEqual(normalized.promptCompiler.personaWorldSelections,[]);
  assert.deepEqual(normalized.promptCompiler.worldBookNames,['Manual book']);
  assert.deepEqual(normalized.promptCompiler.worldEntryIds,['Manual book::1']);
});

test('explicit empty confirmation, disabled selection and separate owners survive normalization and JSON reload',() => {
  const records = sourceRecords(), state = stateWith(records);
  assert.deepEqual(state.promptCompiler.personaWorldSelections,records);
  const reloaded = normalizeStoryboardState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reloaded.promptCompiler.personaWorldSelections,records);
  assert.deepEqual(reloaded.promptCompiler.worldBookNames,['Manual book']);
  assert.deepEqual(reloaded.promptCompiler.worldEntryIds,['Manual book::1']);
  records[0].entryIds.push('not saved');
  assert.deepEqual(reloaded.promptCompiler.personaWorldSelections[0].entryIds,['Synthetic book::1']);
});

test('typed persona normalization preserves more than 100 owners and entries without generic safeData truncation',() => {
  const records = largeRecords(), state = stateWith(records);
  assert.equal(state.promptCompiler.personaWorldSelections.length,125);
  assert.equal(state.promptCompiler.personaWorldSelections[0].entryIds.length,150);
  assert.deepEqual(state.promptCompiler.personaWorldSelections,records);
  assert.deepEqual(normalizeStoryboardState(JSON.parse(JSON.stringify(state))).promptCompiler.personaWorldSelections,records);
});

test('portable capture and detached import retain all persona selections with independent manual selections',() => {
  const records = [...largeRecords(),...sourceRecords()], source = stateWith(records), before = clone(source);
  const incoming = captureStoryboardPackageSettings(source), local = stateWith([record({owner:'local-user.png'})]), localBefore = clone(local);
  const prepared = prepare(local,incoming);
  assert.deepEqual(prepared.settings.promptCompiler.personaWorldSelections,records);
  assert.deepEqual(prepared.settings.promptCompiler.worldBookNames,['Manual book']);
  assert.deepEqual(prepared.settings.promptCompiler.worldEntryIds,['Manual book::1']);
  assert.deepEqual(source,before);
  assert.deepEqual(local,localBefore);
  prepared.settings.promptCompiler.personaWorldSelections[0].entryIds.push('detached');
  assert.deepEqual(incoming.promptCompiler.personaWorldSelections,records);
  assert.deepEqual(source,before);
});

test('actual portable export, confirmed import and recovery preserve the new nested field exactly',async () => {
  const source = stateWith([...largeRecords(),...sourceRecords()]), captured = captureStoryboardPackageSettings(source);
  const file = await portableFile(captured), parsed = await inspectStoryboardPackageFile(file);
  assert.equal(parsed.payload.version,7);
  assert.deepEqual(parsed.payload.settings.promptCompiler.personaWorldSelections,source.promptCompiler.personaWorldSelections);
  const f = createPackageImportFixture();
  f.e.state = stateWith([record({owner:'previous-user.png',enabled:false})]);
  const original = clone(f.e.state);
  f.e.confirm = false;
  await f.import(file);
  assert.deepEqual(f.e.state,original);
  assert.equal(f.e.pending,null);
  f.e.confirm = true;
  await f.import(file);
  assert.ok(f.e.pending,JSON.stringify(f.e.notices));
  assert.deepEqual(f.e.state.promptCompiler.personaWorldSelections,source.promptCompiler.personaWorldSelections);
  assert.deepEqual(f.e.state.promptCompiler.worldBookNames,['Manual book']);
  assert.deepEqual(f.e.state.promptCompiler.worldEntryIds,['Manual book::1']);
  assert.ok(f.e.events.indexOf('journal') < f.e.events.indexOf('settings'));
  assert.deepEqual(captured.promptCompiler.personaWorldSelections,source.promptCompiler.personaWorldSelections);
  f.e.choice = '2';
  await f.recover();
  assert.deepEqual(f.e.state,original);
});

test('modern import rejects lossy malformed persona records before changing destination state',() => {
  const local = stateWith(sourceRecords()), before = clone(local);
  for (const corrupt of [
    rows => { delete rows[0].enabled; },
    rows => { rows[0].enabled = 'true'; },
    rows => { rows[0].entryIds.push(null); },
    rows => { rows[0].entryIds.push(rows[0].entryIds[0]); },
    rows => { rows[0].futureField = 'must not silently disappear'; },
    rows => { rows.push(clone(rows[0])); },
  ]) {
    const incoming = captureStoryboardPackageSettings(stateWith(sourceRecords()));
    corrupt(incoming.promptCompiler.personaWorldSelections);
    const sourceBefore = clone(incoming);
    assert.throws(() => prepare(local,incoming),{code:'storyboard_portable_relations'});
    assert.deepEqual(local,before);
    assert.deepEqual(incoming,sourceBefore);
  }
});

test('actual invalid import refuses before confirmation, journal or settings writes',async () => {
  const incoming = captureStoryboardPackageSettings(stateWith(sourceRecords()));
  incoming.promptCompiler.personaWorldSelections[0].entryIds.push(null);
  const file = await portableFile(incoming), f = createPackageImportFixture();
  f.e.state = stateWith([record({owner:'previous-user.png'})]);
  const original = clone(f.e.state);
  await f.import(file);
  assert.deepEqual(f.e.state,original);
  assert.equal(f.e.pending,null);
  assert.equal(f.e.lastConfirmation,undefined);
  assert.deepEqual(f.e.events,[]);
  assert.match(f.e.notices.at(-1)?.[0] || '',/promptCompiler.*完整保留/);
});

test('actual recovery protects a later persona selection edit instead of overwriting it',async () => {
  const f = createPackageImportFixture(), file = await portableFile(captureStoryboardPackageSettings(stateWith(sourceRecords())));
  await f.import(file);
  assert.ok(f.e.pending,JSON.stringify(f.e.notices));
  f.e.state.promptCompiler.personaWorldSelections[0].enabled = false;
  const changed = clone(f.e.state);
  f.e.choice = '2';
  await f.recover();
  assert.deepEqual(f.e.state,changed);
  assert.ok(f.e.pending,'conflicted recovery retains its journal');
});
