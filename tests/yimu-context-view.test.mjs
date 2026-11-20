import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { DEFAULT_CONTEXT_RULES, mountContextRulesView } from '../yimu/context-view.mjs';

// 多数用例从「没有屏蔽规则」起步，便于逐条添加；内置默认另有一条用例单看。
const EMPTY_RULES = { contextRules: { stripComments: true, blockedTags: [], includedTags: ['content'] } };
function fixture(onSave = async () => {}, settings = EMPTY_RULES) {
    const dom = textCollectionDom(), saves = [], errors = [];
    const create = dom.doc.createElement;
    dom.doc.createElement = tag => {
        const node = create(tag);
        if (tag === 'span') Object.defineProperty(node, 'innerHTML', { set(value) { assert.match(value, /^<svg xmlns=/); }, configurable: true });
        return node;
    };
    const view = mountContextRulesView({ document: dom.doc, onSave: async value => { saves.push(structuredClone(value)); return onSave(value); }, onError: error => errors.push(error) });
    dom.parent.append(view.element); view.render({ settings });
    return { ...dom, view, saves, errors };
}

test('标签规则卡默认折叠；内置默认屏蔽思考过程的三个标签、提取 content', () => {
    const f = fixture();
    assert.equal(f.get('标签规则').classList.contains('ym-button'), true);
    assert.equal(f.get('标签规则').getAttribute('aria-expanded'), 'false');
    assert.equal(f.get('标签规则').querySelector('[data-ym-icon="expand"]'), null);
    assert.equal(f.get('清除 HTML 注释').checked, true);
    assert.deepEqual(DEFAULT_CONTEXT_RULES.blockedTags, ['think', 'thinking', 'thought']);
    assert.equal(f.all().filter(node => node.classList.contains('ym-context-rule-row')).length, 1);
    const builtin = fixture(undefined, {});
    assert.equal(builtin.all().filter(node => node.classList.contains('ym-context-rule-row')).length, 4, '三条屏蔽加一条提取');
    builtin.view.destroy();
    assert.equal(f.get('提取标签').value, 'content');
    f.get('标签规则').click();
    assert.equal(f.get('标签规则').getAttribute('aria-expanded'), 'true');
    assert.equal(f.byClass('ym-context-rule-list').hidden, false);
    f.view.destroy();
});

test('标签规则规则只在明确修改后保存，并规范化标签名称', async () => {
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

test('远端刷新不覆盖正在编辑的标签规则规则，禁用态仍保持可见', () => {
    const f = fixture(), blocked = f.byClass('ym-context-rule-add'); blocked.click();
    const input = f.get('屏蔽标签'); input.focus(); input.value = '自定义';
    f.view.render({ settings: { contextRules: { stripComments: false, blockedTags: ['aside'], includedTags: ['content'] } } });
    assert.equal(input.value, '自定义');
    f.view.render({ settings: { contextRules: { stripComments: false, blockedTags: ['aside'], includedTags: ['content'] } }, disabled: true });
    assert.equal(f.get('屏蔽标签').disabled, true); assert.equal(f.get('标签规则').hidden, false); f.view.destroy();
});

test('编辑一个标签时各行节点不被重建、也不在自己保存期间置灰（不再连闪三次）', async () => {
    let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
    f.byClass('ym-context-rule-add').click();
    const input = f.get('屏蔽标签'), row = input.parentNode; input.value = 'aside'; input.emit('change');
    await f.wait(() => f.saves.length === 1);
    const same = () => { assert.equal(f.get('屏蔽标签'), input, '输入框还是原来那个节点'); assert.equal(input.parentNode, row); assert.equal(input.disabled, false); };
    // 外层在这次保存期间依次报：忙 → 新值到达 → 不忙。三次状态变化都不应重建或置灰。
    const saved = { contextRules: { stripComments: true, blockedTags: ['aside'], includedTags: ['content'] } };
    f.view.render({ settings: {}, disabled: true }); same();
    f.view.render({ settings: saved, disabled: true }); same();
    release(true); await f.wait(() => f.get('屏蔽标签').disabled === false);
    f.view.render({ settings: saved, disabled: false }); same();
    assert.deepEqual(f.errors, []); f.view.destroy();
});
