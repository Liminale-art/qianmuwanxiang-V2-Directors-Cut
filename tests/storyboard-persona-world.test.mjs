import test from 'node:test';
import assert from 'node:assert/strict';
import {readPersonaWorldBindings,personaWorldSelectionKey,normalizePersonaWorldSelections,activePersonaWorldSelections} from '../qianmu-storyboard-persona-world.js';

const character = (avatar='same-name.png',book='char-main') => ({avatar,name:'Same display name',data:{extensions:{world:book}}});
const context = () => ({characterId:0,characters:[character()],powerUserSettings:{persona_description_lorebook:'user-book'},chatMetadata:{world_info:'chat-book'}});
const host = () => ({userAvatar:'user-a.png',worldInfo:{charLore:[{name:'same-name',extraBooks:['extra','char-main','extra']}],globalSelect:['global-book']}});
const record = (overrides={}) => ({kind:'char',owner:'same-name.png',book:'char-main',entryIds:['char-main::1'],enabled:true,...overrides});

test('official primary/additional character books and independent USER book form only metadata', () => {
  const c=context(), h=host();c.characters[0].description='private char';c.powerUserSettings.persona_description='private user';
  const actual=readPersonaWorldBindings(c,h);
  assert.deepEqual(actual.owners,[{kind:'char',id:'same-name.png',books:['char-main','extra']},{kind:'user',id:'user-a.png',books:['user-book']}]);
  assert.equal(actual.signature,JSON.stringify(actual.owners));
  assert.doesNotMatch(actual.signature,/private|global-book|chat-book|Same display name/);
});

test('same display names use exact avatar filenames and only the currently selected group character', () => {
  const c=context(),h=host();c.groupId='group';c.characters.push(character('other.png','other-main'));
  h.worldInfo.charLore.push({name:'other',extraBooks:['other-extra']});
  const first=readPersonaWorldBindings(c,h);c.characterId=1;
  const second=readPersonaWorldBindings(c,h);
  assert.deepEqual(second.owners[0],{kind:'char',id:'other.png',books:['other-main','other-extra']});
  assert.notEqual(first.signature,second.signature);
  c.characterId=undefined;assert.deepEqual(readPersonaWorldBindings(c,h).owners,[{kind:'user',id:'user-a.png',books:['user-book']}]);
});

test('extraBooks use ST final-extension removal, preserve names, and cannot borrow another character binding', () => {
  const c=context(),h=host();c.characters[0]=character('name.with.dots.png','');
  h.worldInfo.charLore=[{name:'name.with.dots',extraBooks:[' spaced book ','__proto__']},{name:'name',extraBooks:['wrong']}];
  assert.deepEqual(readPersonaWorldBindings(c,h).owners[0].books,[' spaced book ','__proto__']);
});

test('persona changes with identical names/descriptions/books still change identity and never activate prior confirmation', () => {
  const c=context(),h=host(),selections=[record({kind:'user',owner:'user-a.png',book:'user-book',entryIds:['user-book::1']})];
  c.name1='Same user';c.powerUserSettings.persona_description='';
  const a=readPersonaWorldBindings(c,h);h.userAvatar='user-b.png';
  const b=readPersonaWorldBindings(c,h);
  assert.notEqual(a.signature,b.signature);
  assert.equal(activePersonaWorldSelections(selections,a).length,1);
  assert.deepEqual(activePersonaWorldSelections(selections,b),[]);
  h.userAvatar='user-a.png';assert.equal(readPersonaWorldBindings(c,h).signature,a.signature);
});

test('binding removal and changing a book fail closed without deleting retained confirmation records', () => {
  const c=context(),h=host(),selections=[record(),record({book:'extra'}),record({book:'not-bound'})];
  const before=structuredClone(selections);assert.equal(activePersonaWorldSelections(selections,readPersonaWorldBindings(c,h)).length,2);
  c.characters[0].data.extensions.world='new-book';h.worldInfo.charLore=[];
  assert.deepEqual(activePersonaWorldSelections(selections,readPersonaWorldBindings(c,h)),[]);
  assert.deepEqual(selections,before);
});

test('records require explicit confirmation; disabled remains retained and empty entries stay explicitly empty', () => {
  const bindings=readPersonaWorldBindings(context(),host());
  const records=[record({enabled:false}),record({book:'extra',entryIds:[]})];
  assert.equal(normalizePersonaWorldSelections(records).length,2);
  assert.deepEqual(activePersonaWorldSelections(records,bindings),[record({book:'extra',entryIds:[]})]);
  assert.deepEqual(activePersonaWorldSelections([],bindings),[]);
  assert.deepEqual(normalizePersonaWorldSelections([{kind:'char',owner:'same-name.png',book:'char-main',entryIds:['1']}]),[]);
});

test('normalization deduplicates exact keys and entries, keeps the final explicit edit, and never mutates inputs', () => {
  const values=[record({entryIds:['1','1','2',null,1,'']}),record({book:'extra'}),record({enabled:false,entryIds:['3']})],before=structuredClone(values);
  const normalized=normalizePersonaWorldSelections(values);
  assert.deepEqual(normalized,[record({enabled:false,entryIds:['3']}),record({book:'extra'})]);
  assert.deepEqual(normalizePersonaWorldSelections([before[0]])[0].entryIds,['1','2']);
  assert.deepEqual(normalizePersonaWorldSelections(normalized),normalized);assert.deepEqual(values,before);
});

test('tuple keys do not collide on separators, quotes, malicious property names or char/user overlap', () => {
  const values=[record({owner:'a::b',book:'c'}),record({owner:'a',book:'b::c'}),record({owner:'__proto__',book:'constructor'}),record({owner:'a"b',book:'[]'}),record({kind:'user',owner:'a::b',book:'c'})];
  assert.equal(new Set(values.map(personaWorldSelectionKey)).size,values.length);
  assert.equal(normalizePersonaWorldSelections(values).length,values.length);
  assert.equal({}.polluted,undefined);
});

test('inherited identities, entries and enable flags are not proof of consent', () => {
  assert.deepEqual(normalizePersonaWorldSelections([Object.create(record()),{...record(),entryIds:undefined},record({enabled:'true'}),record({kind:'global'})]),[]);
  const inherited=Object.create({characters:[character()],characterId:0,powerUserSettings:{persona_description_lorebook:'bad'}});
  assert.deepEqual(readPersonaWorldBindings(inherited,{}).owners,[]);
  assert.deepEqual(activePersonaWorldSelections([record()],Object.create({owners:[{kind:'char',id:'same-name.png',books:['char-main']}]})),[]);
});

test('known book without exact char or USER avatar produces a fixed visible error instead of guessing from display/default/locked persona', () => {
  const c=context();delete c.characters[0].avatar;
  assert.throws(()=>readPersonaWorldBindings(c,host()),{code:'storyboard_persona_world_owner_unavailable',kind:'char'});
  const other=context();other.name1='Display';other.powerUserSettings.default_persona='guess.png';other.chatMetadata.persona='locked.png';
  assert.throws(()=>readPersonaWorldBindings(other,{worldInfo:host().worldInfo}),{code:'storyboard_persona_world_owner_unavailable',kind:'user'});
  assert.throws(()=>readPersonaWorldBindings(other,{userAvatar:{id:'guess'}}),/当前用户人设身份未能确认/);
});

test('unbound owners retain stable identity, while absent/unknown legacy inputs cannot grow a selection', () => {
  const c=context();c.characters[0].data.extensions.world='';c.powerUserSettings.persona_description_lorebook='';
  assert.deepEqual(readPersonaWorldBindings(c,{userAvatar:'user-a.png'}).owners,[{kind:'char',id:'same-name.png',books:[]},{kind:'user',id:'user-a.png',books:[]}]);
  for(const input of [undefined,null,{},'',false,{worldEntryIds:['book::1']},['book::1']]) assert.deepEqual(normalizePersonaWorldSelections(input),[]);
  assert.deepEqual(readPersonaWorldBindings().owners,[]);
});

test('snapshots and active records are detached metadata and adding a host entry does not expand confirmation', () => {
  const c=context(),h=host(),before=structuredClone({c,h}),bindings=readPersonaWorldBindings(c,h),selections=[record()];
  const active=activePersonaWorldSelections(selections,bindings);active[0].entryIds.push('new-entry');bindings.owners[0].books.push('new-book');
  assert.deepEqual(selections,[record()]);assert.deepEqual({c,h},before);
  assert.deepEqual(activePersonaWorldSelections(selections,readPersonaWorldBindings(c,h))[0].entryIds,['char-main::1']);
});
