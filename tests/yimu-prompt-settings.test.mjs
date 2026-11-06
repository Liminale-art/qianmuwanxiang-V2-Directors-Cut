import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, BUILTIN_PROMPT_PRESET, selectPromptPreset, resolvePromptConfig, composePrompt, validatePromptConfig, exportPromptPreset, importPromptPreset, mergeImportedPromptConfig } from '../yimu/prompt-settings.mjs';
test('actual defaults are visible independent copies and legacy preferences remain editable entries', () => {
    const value = resolvePromptConfig({preference:'保留约定'});
    assert.equal(value.groups.summary.at(-1).text,'保留约定'); assert.equal(value.groups.stage.at(-1).text,'保留约定');
    assert.equal(value.groups.recall.some(item=>item.id==='legacy-preference'),false);
    assert.equal(value.groups.identity[0].id,'persona');
    assert.match(value.groups.summary.find(item => item.id === 'facts').text, /日后能直接帮助续写/);
    assert.match(value.groups.summary.find(item => item.id === 'facts').text, /例：/);
    assert.match(value.groups.recall.find(item => item.id === 'recall-purpose').text, /最后放在哪里/);
    value.groups.summary[0].text='自定义'; assert.notEqual(DEFAULT_PROMPTS.groups.summary[0].text,'自定义');
});
test('only enabled entries in explicit order compose; an emptied group does not secretly restore defaults', () => {
    const config=resolvePromptConfig(); config.groups.summary=[{id:'b',name:'B',text:'第二段',enabled:true},{id:'a',name:'A',text:'不使用',enabled:false},{id:'c',name:'C',text:'第三段',enabled:true}];
    config.groups.identity=[];
    assert.equal(composePrompt({prompts:config},'summary',{protocol:'格式',data:'数据'}),'第二段\n第三段\n\n格式\n\n数据');
    config.groups.summary=[]; assert.equal(composePrompt({prompts:config},'summary',{data:'数据'}),'数据');
});
test('the editable default persona is shared by every request-specific prompt group', () => {
    const config=resolvePromptConfig();
    const persona=config.groups.identity[0].text;
    assert.match(persona,/我是忆幕/);
    assert.doesNotMatch(persona,/人工修订/);
    assert.match(persona,/故事记忆的梳理者与封存者/);
    assert.match(composePrompt({prompts:config},'summary',{data:'数据'}),new RegExp(persona.slice(0,18)));
    config.groups.identity[0].text='用户自定义的人格';
    assert.match(composePrompt({prompts:config},'stage',{data:'数据'}),/用户自定义的人格/);
});
test('legacy prompt configs gain the default persona without changing their existing groups', () => {
    const current=resolvePromptConfig(), legacy={groups:{summary:current.groups.summary,stage:current.groups.stage,recall:current.groups.recall},presets:[],selectedPreset:''};
    const migrated=validatePromptConfig(legacy);
    assert.equal(migrated.groups.identity[0].id,'persona');
    assert.equal(migrated.groups.summary.length,current.groups.summary.length);
});
test('presets roundtrip without importing unrelated ST or account fields', () => {
    const config=resolvePromptConfig(); config.presets=[{id:'one',name:'简洁',groups:structuredClone(config.groups)}]; config.selectedPreset='one';
    assert.deepEqual(importPromptPreset(exportPromptPreset(config)),config);
    assert.throws(()=>importPromptPreset('{"prompts":[]}'),/忆幕/);
    config.apiKey='not-exported'; assert.equal(exportPromptPreset(config).includes('not-exported'),false);
});
test('malformed groups, duplicates and missing selected preset fail before saving', () => {
    const config=resolvePromptConfig(); config.groups.summary.push({...config.groups.summary[0]}); assert.throws(()=>validatePromptConfig(config),/重复/);
    const other=resolvePromptConfig(); other.selectedPreset='missing'; assert.throws(()=>validatePromptConfig(other),/不存在/);
});
test('importing a prompt config preserves existing presets and conflicting preset IDs do not overwrite them', () => {
    const before=resolvePromptConfig(); before.presets=[{id:'saved',name:'原预设',groups:structuredClone(before.groups)}];
    const empty=mergeImportedPromptConfig(before,resolvePromptConfig(),()=> 'unused');
    assert.deepEqual(empty.presets,before.presets);
    const incoming=structuredClone(before); incoming.presets[0].groups.summary[0].text='另一份规则'; incoming.selectedPreset='saved';
    const merged=mergeImportedPromptConfig(before,incoming,()=> 'new-import');
    assert.equal(merged.presets.length,2); assert.deepEqual(merged.presets[0],before.presets[0]); assert.equal(merged.selectedPreset,'new-import');
    assert.deepEqual(mergeImportedPromptConfig(merged,incoming,()=> 'must-not-allocate'),merged);
});

test('built-in selection is UI-only and preserves the named preset library',()=>{
    const value=resolvePromptConfig();value.presets=[{id:'mine',name:'已存预设',groups:structuredClone(value.groups)}];value.presets[0].groups.summary[0].text='自定义内容';
    const named=selectPromptPreset(value,'mine');assert.equal(named.groups.summary[0].text,'自定义内容');assert.equal(named.selectedPreset,'mine');
    const builtin=selectPromptPreset(named,BUILTIN_PROMPT_PRESET);assert.deepEqual(builtin.groups,DEFAULT_PROMPTS.groups);assert.deepEqual(builtin.presets,value.presets);assert.equal(builtin.selectedPreset,'');
    assert.throws(()=>selectPromptPreset(value,'missing'),/不存在/);assert.equal(value.groups.summary[0].text,DEFAULT_PROMPTS.groups.summary[0].text);
});
