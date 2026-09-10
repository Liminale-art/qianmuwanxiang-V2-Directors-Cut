// Development-only: use Node's module parser/linker; never execute the application.
// Run with: node --experimental-vm-modules scripts/check-focus-boundaries.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const rules = {
  'qianmu-focus-time.js': [],
  'qianmu-focus-history.js': ['./qianmu-focus-time.js'],
  'qianmu-focus-voice.js': [],
  'qianmu-focus-lock.js': [],
  'qianmu-focus-runtime.js': [],
  'qianmu-focus-session.js': [],
  'qianmu-focus-sound.js': [],
  'qianmu-focus-speech.js': [],
  'qianmu-focus-preparation.js': [],
  'qianmu-focus-voice-cache.js': [],
  'qianmu-focus-view.js': ['./qianmu-focus-time.js'],
  'qianmu-focus-events.js': [],
};
if (!vm.SourceTextModule) throw new Error('Run this development check with --experimental-vm-modules.');

function inspect(sources, entry) {
  const context = vm.createContext({}), modules = new Map();
  for (const [file, allowed] of Object.entries(rules)) {
    const module = new vm.SourceTextModule(sources[file], {context,identifier:file});
    assert.deepEqual([...module.dependencySpecifiers].sort(), [...allowed].sort(), `${file}: static dependency boundary changed`);
    modules.set(file,module);
  }
  const entryModule = new vm.SourceTextModule(entry,{identifier:'index.js'});
  for (const file of Object.keys(rules)) {
    const paths = entryModule.dependencySpecifiers.filter(ref=>ref.split(/[?#]/)[0] === `./${file}`);
    assert.deepEqual(paths,[`./${file}`],`${file}: entry must use one canonical module identity`);
  }
  return modules;
}

const entries = await Promise.all(Object.keys(rules).map(async file => [file,await readFile(new URL(`../${file}`,import.meta.url),'utf8')]));
const sources = Object.fromEntries(entries);
const entry = await readFile(new URL('../index.js',import.meta.url),'utf8');
const modules = inspect(sources,entry);
for (const module of modules.values()) {
  if (module.status === 'unlinked') await module.link(ref => modules.get(ref.slice(2)));
}
// Link export names and imports without evaluating module bodies or starting UI/timers.
assert.ok([...modules.values()].every(module=>module.status === 'linked'));

// Negative fixtures change strings in memory only, never user files or real settings.
const change = (file, text) => ({...sources,[file]:text});
assert.throws(()=>inspect(change('qianmu-focus-time.js',"import './index.js';"),entry),/boundary changed/);
assert.throws(()=>inspect(change('qianmu-focus-time.js',"export * from './qianmu-focus-history.js';"),entry),/boundary changed/);
assert.throws(()=>inspect(change('qianmu-focus-history.js',"import './qianmu-focus-time.js?v=other';"),entry),/boundary changed/);
assert.throws(()=>inspect(change('qianmu-focus-time.js','export function broken('),entry),{name:'SyntaxError'});
assert.throws(()=>inspect(sources,entry+"\nimport './qianmu-focus-time.js?v=other';"),/canonical module identity/);
assert.doesNotThrow(()=>inspect(change('qianmu-focus-time.js',sources['qianmu-focus-time.js']+"\n// import './index.js';\nthrow new Error('must not execute');"),entry));
console.log(JSON.stringify({modules:Object.keys(rules).length,linked:true,executed:false,negativeFixtures:5,nonExecutionFixture:true,scope:'static imports/re-exports and canonical entry paths only',dependencies:rules}));
