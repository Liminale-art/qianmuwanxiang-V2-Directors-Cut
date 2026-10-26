import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { mountPromptView } from '../yimu/prompt-view.mjs';
import { DEFAULT_PROMPTS, exportPromptPreset } from '../yimu/prompt-settings.mjs';
function fixture(onSave) {
    const dom = textCollectionDom(), create = dom.doc.createElement, saves = [], errors = [], exports = [];
    dom.doc.createElement = tag => { const node = create(tag); if (tag === 'span') Object.defineProperty(node, 'innerHTML', { set(value) { assert.match(value, /^<svg xmlns=/); } }); return node; };
    const view = mountPromptView(dom.parent, { document: dom.doc, onSave: async (...args) => { saves.push(args); return onSave?.(...args); }, onError: error => errors.push(error), onExport: value => exports.push(value) });
    const render = value => view.render({ settings: {}, scope: 'chat-a', revision: 2, ...value }); render();
    return { ...dom, view, saves, errors, exports, render };
}
test('actual defaults are visible/editable and background renders retain the exact draft node', async () => {
    const f = fixture(), content = f.get('叙事与依据提示词正文');
    assert.equal(content.value, DEFAULT_PROMPTS.groups.summary[0].text); content.value = '<img>只保留已确认的承诺'; content.emit('input');
    f.render({ revision: 3 }); assert.equal(f.get('叙事与依据提示词正文'), content); assert.equal(content.value, '<img>只保留已确认的承诺');
    f.get('保存提示词').click(); await f.wait(() => f.saves.length === 1 && f.get('保存提示词').disabled);
    assert.equal(f.saves[0][0].groups.summary[0].text, content.value); assert.equal(f.saves[0][1].revision, 2); assert.equal(f.saves[0][1].scope, 'chat-a'); f.view.destroy();
});
test('a successful save advances the next edit revision and busy drag cannot alter the submitted configuration', async () => {
    let release, current; const f = fixture(async () => { await new Promise(resolve => { release = resolve; }); f.render({ settings: { prompts: current }, revision: 3 }); });
    const text = f.get('叙事与依据提示词正文'); text.value = '第一版'; text.emit('input');
    f.get('导出').click(); current = JSON.parse(f.exports[0]).config; f.get('保存提示词').click();
    const handle = f.byClass('ym-prompt-drag'); assert.equal(handle.emit('dragstart').defaultPrevented, true);
    release(); await f.wait(() => f.parent.textContent.includes('提示词已保存'));
    text.value = '第二版'; text.emit('input'); f.get('保存提示词').click(); assert.equal(f.saves[1][1].revision, 3); release(); f.view.destroy();
});
test('group labels match slice/stage vocabulary and the recall badge reflects the single functional setting', () => {
    const f = fixture(); f.render({ recallEnabled: false });
    assert.ok(f.get('切片总结')); assert.ok(f.get('阶段总结')); assert.equal(f.byClass('ym-prompt-recall-badge').textContent, '未开启');
    f.render({ recallEnabled: true }); assert.equal(f.byClass('ym-prompt-recall-badge').textContent, '已开启'); f.view.destroy();
});
test('enable, move, add/delete and per-scope drafts work without affecting ST presets', () => {
    const f = fixture(); f.get('启用叙事与依据').click(); f.get('下移叙事与依据').click();
    f.get('新增条目').click(); const draft = f.get('自定义提示词提示词正文'); draft.value = '仅此聊天'; draft.emit('input');
    f.render({ scope: 'chat-b' }); assert.equal(f.get('自定义提示词提示词正文'), undefined);
    f.render(); assert.equal(f.get('自定义提示词提示词正文').value, '仅此聊天');
    f.get('删除自定义提示词').click(); assert.equal(f.get('自定义提示词提示词正文'), undefined);
    f.get('导出').click(); const output = JSON.parse(f.exports[0]); assert.equal(output.config.groups.summary[1].id, 'facts'); assert.equal(output.config.groups.summary[1].enabled, false);
    f.view.destroy();
});
test('failed saves retain edits and import is parsed before an explicit replacement confirmation', async () => {
    const f = fixture(async () => { throw new Error('offline'); });
    const text = f.get('叙事与依据提示词正文'); text.value = '草稿'; text.emit('input'); f.get('保存提示词').click(); await f.wait(() => f.errors.length === 1);
    assert.equal(f.get('叙事与依据提示词正文').value, '草稿');
    const file = f.get('导入忆幕提示词文件'); file.files = [{ name: 'safe.json', size: 100, text: async () => exportPromptPreset(DEFAULT_PROMPTS) }]; file.emit('change');
    await f.wait(() => f.visible(f.get('确认提示词操作'))); assert.equal(f.get('叙事与依据提示词正文').value, '草稿');
    f.get('取消提示词操作').click(); assert.equal(f.get('叙事与依据提示词正文').value, '草稿');
    f.view.destroy();
});
test('restore and load require confirmation and named preset save persists the whole configuration', async () => {
    const f = fixture(); f.get('保存为预设').click(); f.get('总结提示词预设名称').value = '叙事'; f.get('确认保存提示词预设').click();
    await f.wait(() => f.saves.length === 1 && f.get('确认保存提示词预设').disabled === false);
    assert.equal(f.saves[0][0].presets[0].name, '叙事');
    f.get('恢复内置默认').click(); assert.equal(f.visible(f.get('确认提示词操作')), true); f.get('确认提示词操作').click();
    f.get('导出').click(); assert.deepEqual(JSON.parse(f.exports[0]).config.groups, DEFAULT_PROMPTS.groups); f.view.destroy();
});
