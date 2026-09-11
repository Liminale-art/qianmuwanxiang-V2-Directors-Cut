import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as utilities from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture() {
  let saves=0;
  const c=vm.createContext({...utilities,settings:{theater:{scripts:[{id:'sd-bt-0',title:'old'}],favorites:[{id:'fav'}]}},
    theaterCatalogReady:false,BUILTIN_THEATERS:[],QIANMU_THEATERS:[],
    BUILTIN_THEATER_FOLDER:'builtin',QIANMU_THEATER_FOLDER:'qianmu',BUILTIN_THEATER_REVISION:6,QIANMU_THEATER_REVISION:5,
    saveSettings(){saves++;}});
  vm.runInContext('"use strict";\n'+['getTheater','isOrphanBuiltinCopy','seedBuiltinTheaters'].map(section).join('\n'),c);
  const load=()=>Object.assign(c,{theaterCatalogReady:true,BUILTIN_THEATERS:[{title:'base',instruction:'original'}],QIANMU_THEATERS:[{title:'q',instruction:'q'}]});
  return {c,load,saves:()=>saves};
}

test('opening or restoring before lazy catalogs arrive never stamps empty catalogs or removes old scripts',()=>{
  const e=fixture(),before=structuredClone(e.c.settings),copy=structuredClone(before);
  e.c.seedBuiltinTheaters();e.c.seedBuiltinTheaters(copy);
  assert.deepEqual(e.c.settings,before);assert.deepEqual(copy,before);assert.equal(e.saves(),0);
  e.load();e.c.seedBuiltinTheaters();assert.equal(e.saves(),1);
  assert.deepEqual(Array.from(e.c.settings.theater.scripts,s=>s.title),['base','q']);
  e.c.seedBuiltinTheaters();assert.equal(e.saves(),1,'current catalogs are idempotent');
});

test('preparing imported catalogs preserves custom and edited scripts without saving or changing live settings',()=>{
  const e=fixture();e.load();const before=structuredClone(e.c.settings);
  const owner={theater:{scripts:[{id:'custom',title:'mine'},
    {id:'old-copy',title:'base',folder:'builtin',instruction:'original'},
    {id:'edited',title:'base',folder:'builtin',instruction:'edited'},
    {id:'sd-bt-0',title:'old'},{id:'sd-qm-0',title:'old-q'}],favorites:[{id:'keep'}]}};
  e.c.seedBuiltinTheaters(owner);
  assert.deepEqual(e.c.settings,before);assert.equal(e.saves(),0);
  assert.deepEqual(Array.from(owner.theater.scripts,s=>s.id),['custom','edited','sd-bt-0','sd-qm-0']);
  assert.deepEqual(owner.theater.favorites,[{id:'keep'}]);assert.equal(owner.theater.builtinRevision,6);assert.equal(owner.theater.qianmuRevision,5);
  const seeded=structuredClone(owner);e.c.seedBuiltinTheaters(owner);assert.deepEqual(structuredClone(owner),seeded);assert.equal(e.saves(),0);
});

test('a broken catalog fails before mutating the prepared scripts or revisions',()=>{
  const e=fixture();e.load();e.c.QIANMU_THEATERS=[null];
  const owner=structuredClone(e.c.settings),before=structuredClone(owner);
  assert.throws(()=>e.c.seedBuiltinTheaters(owner));assert.deepEqual(owner,before);assert.equal(e.saves(),0);
});
