import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { DEFAULT_CONTEXT_RULES, mountContextRulesView } from '../yimu/context-view.mjs';

function fixture(onSave = async () => {}) {
    const dom = textCollectionDom(), saves = [], errors = [];
    const view = mountContextRulesView({ document: dom.doc, onSave: async value => { saves.push(structuredClone(value)); return onSave(value); }, onError: error => errors.push(error) });
    dom.parent.append(view.element); view.render({ settings: {} });
    return { ...dom, view, saves, errors };
}

test('正文提取卡默认折叠，只显示提取 content，屏蔽规则留空待用户添加', () => {
    const f = fixture();
    assert.equal(f.get('正文提取').getAttribute('aria-expanded'), 'false');
    assert.equal(f.get('清除 HTML 注释').checked, true);
    assert.deepEqual(DEFAULT_CONTEXT_RULES.blockedTags, []);
    assert.equal(f.all().filter(node => node.classList.contains('ym-context-rule-row')).length, 1);
    assert.equal(f.get('提取标签').value, 'content');
    f.get('正文提取').click();
    assert.equal(f.get('正文提取').getAttribute('aria-expanded'), 'true');
    assert.equal(f.byClass('ym-context-rule-list').hidden, false);
    f.view.destroy();
});

test('正文提取规则只在明确修改后保存，并规范化标签名称', async () => {
    const f = fixture(); f.byClass('ym-context-rule-add').click();
    const blocked = f.get('屏蔽标签'); blocked.value = 'Status'; blocked.emit('change');
    await f.wait(() => f.saves.length === 1);
    assert.deepEqual(f.saves[0], { stripComments: true, blockedTags: ['status'], includedTags: ['content'] });
    f.get('屏蔽标签').value = '<style>'; f.get('屏蔽标签').emit('change');
    await f.wait(() => f.saves.length === 2);
    assert.deepEqual(f.saves[1].blockedTags, ['style']);
    f.get('清除 HTML 注释').click(); await f.wait(() => f.saves.length === 3); assert.equal(f.saves[2].stripComments, false);
    assert.deepEqual(f.errors, []); f.view.destroy();
});

test('远端刷新不覆盖正在编辑的正文提取规则，禁用态仍保持可见', () => {
    const f = fixture(), blocked = f.byClass('ym-context-rule-add'); blocked.click();
    const input = f.get('屏蔽标签'); input.focus(); input.value = '自定义';
    f.view.render({ settings: { contextRules: { stripComments: false, blockedTags: ['aside'], includedTags: ['content'] } } });
    assert.equal(input.value, '自定义');
    f.view.render({ settings: { contextRules: { stripComments: false, blockedTags: ['aside'], includedTags: ['content'] } }, disabled: true });
    assert.equal(f.get('屏蔽标签').disabled, true); assert.equal(f.get('正文提取').hidden, false); f.view.destroy();
});
