// Read-only verification against an explicitly supplied local official upstream clone.
// Run: QIANMU_ST_UPSTREAM=<clone> node scripts/check-st-upstream-compat.mjs
// No checkout, fetch, settings access, credentials, generation or production endpoint.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import * as sources from '../qianmu-st-context-sources.js';
const repository = process.env.QIANMU_ST_UPSTREAM;
if (!repository) throw Error('Set QIANMU_ST_UPSTREAM to a local SillyTavern reference clone containing tag 1.19.0.');
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1048576 });
const commit = git('rev-parse', '1.19.0^{commit}').trim();
assert.equal(commit, '7e8663cd9c184a550b37238218bdd32c6efc68e9');
const read = file => git('show', `1.19.0:${file}`);
const contextSource = read('public/scripts/st-context.js'), presetSource = read('public/scripts/preset-manager.js'), worldSource = read('public/scripts/world-info.js');
const checks = [], check = (name, fn) => { fn(); checks.push(name); };
const member = (source, name, exported = false) => {
    const start = source.indexOf(exported ? `export ${name}` : `    ${name}(`);
    if (start < 0) throw Error(`Official member not found: ${name}`);
    const end = source.indexOf(exported ? '\n}' : '\n    }', start);
    if (end < 0) throw Error(`Official member not terminated: ${name}`);
    return source.slice(start, end + (exported ? 2 : 6)).replace(/^export /, '');
};
check('official 1.19.0 context exposes all required read-only extension APIs', () => {
    for (const pattern of [/chatCompletionSettings: oai_settings/, /powerUserSettings: power_user/, /\n\s+getPresetManager,/, /\n\s+loadWorldInfo,/, /getWorldInfoNames: \(\) => Array\.isArray\(world_names\)/]) assert.match(contextSource, pattern);
});
const oai = { preset_settings_openai: 'Current', prompts: [{ identifier: 'live', content: 'unsaved edit' }] };
const presets = [{ prompts: [{ content: 'saved current' }] }, { prompts: [{ content: 'saved other' }] }];
const presetContext = vm.createContext({ console, openai_settings: presets, openai_setting_names: { Current: 0, Other: 1 }, oai_settings: oai, main_api: 'novel',
    $: () => ({ find: () => ({ map: fn => ({ toArray: () => ['Current','Other'].map(text => fn(0, { text })) }), text: () => 'Current' }) }),
});
const methods = ['getAllPresets','getSelectedPresetName','getPresetList','getCompletionPresetByName'].map(name => member(presetSource, name)).join('\n');
const officialManager = vm.runInContext(`class OfficialPresetManager { ${methods} }\nnew OfficialPresetManager()`, presetContext);
officialManager.apiId = 'openai'; presetContext.presetManagers = { openai: officialManager };
const getPresetManager = vm.runInContext(`${member(presetSource, 'function getPresetManager', true)}\ngetPresetManager`, presetContext);
const context = { getPresetManager, chatCompletionSettings: oai };
check('actual official manager works with index-zero names and explicit CC access while main API is novel', () => {
    assert.equal(sources.stCurrentPresetName(context), 'Current'); assert.deepEqual(sources.stPresetNames(context), ['Current','Other']);
    assert.equal(sources.stPresetEntries(context, 'Other')[0].content, 'saved other'); assert.equal(presetContext.main_api, 'novel');
});
check('actual official manager preserves unsaved live prompt edits and never modifies its stored settings', () => {
    const current = sources.stPresetEntries(context, 'Current'), other = sources.stPresetEntries(context, 'Other');
    assert.equal(current[0].content, 'unsaved edit'); current[0].content = 'changed copy'; other[0].content = 'changed copy';
    assert.equal(oai.prompts[0].content, 'unsaved edit'); assert.equal(presets[1].prompts[0].content, 'saved other');
    oai.prompts = []; assert.deepEqual(sources.stPresetEntries(context, 'Current'), []);
});
let reads = 0;
const book = { entries: { 0: { uid: 0, content: 'original world', extensions: { preserved: true } } } };
const worldContext = vm.createContext({ console, world_names: ['file-id','settings'], worldInfoCache: new Map(), getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    fetch: async (url, request) => { reads++; assert.equal(url, '/api/worldinfo/get'); assert.equal(request.method, 'POST'); assert.equal(JSON.parse(request.body).name, 'file-id'); return { ok: true, json: async () => book }; },
});
context.loadWorldInfo = vm.runInContext(`${member(worldSource, 'async function loadWorldInfo', true)}\nloadWorldInfo`, worldContext);
const namesArrow = /getWorldInfoNames: (\(\) => Array\.isArray\(world_names\) \? \[\.\.\.world_names\] : \[\])/.exec(contextSource)?.[1];
assert.ok(namesArrow); context.getWorldInfoNames = vm.runInContext(`(${namesArrow})`, worldContext);
assert.deepEqual(await sources.stWorldBookNames(context), ['file-id','settings']); checks.push('actual official context returns file identities, including a legitimate book named settings');
const first = await sources.stWorldBookEntries(context, 'file-id'); first[0].extensions.preserved = false;
const second = await sources.stWorldBookEntries(context, 'file-id');
assert.equal(second[0].extensions.preserved, true); assert.equal(book.entries[0].extensions.preserved, true); assert.equal(reads, 1);
checks.push('actual official world loader uses its cache and copies material without changing cached entries');
check('legacy endpoint fallback agrees with official POST/file_id contract, not a display-name alias', () => {
    const endpoint = read('src/endpoints/worldinfo.js'); assert.match(endpoint, /router\.post\('\/list'/); assert.match(endpoint, /file_id: fileNameWithoutExt/);
});
console.log(JSON.stringify({ passed: checks.length, checks, officialVersion: '1.19.0', commit, productionDataRead: false, external: 0,
    scope: 'actual tagged preset manager and world reader with synthetic state; not a running ST or third-party patched installation acceptance' }));
