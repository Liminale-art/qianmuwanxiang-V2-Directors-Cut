import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, resolvePromptConfig, composePrompt, validatePromptConfig, exportPromptPreset, importPromptPreset, mergeImportedPromptConfig } from '../yimu/prompt-settings.mjs';
test('actual defaults are visible independent copies and legacy preferences remain editable entries', () => {
    const value = resolvePromptConfig({preference:'保留约定'});
    assert.equal(value.groups.summary.at(-1).text,'保留约定'); assert.equal(value.groups.stage.at(-1).text,'保留约定');
    assert.equal(value.groups.recall.some(item=>item.id==='legacy-preference'),false);
    value.groups.summary[0].text='自定义'; assert.notEqual(DEFAULT_PROMPTS.groups.summary[0].text,'自定义');
});
test('only enabled entries in explicit order compose; an emptied group does not secretly restore defaults', () => {
    const config=resolvePromptConfig(); config.groups.summary=[{id:'b',name:'B',text:'第二段',enabled:true},{id:'a',name:'A',text:'不使用',enabled:false},{id:'c',name:'C',text:'第三段',enabled:true}];
    assert.equal(composePrompt({prompts:config},'summary',{protocol:'格式',data:'数据'}),'第二段\n第三段\n\n格式\n\n数据');
    config.groups.summary=[]; assert.equal(composePrompt({prompts:config},'summary',{data:'数据'}),'数据');
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
});
