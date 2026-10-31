import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_RULES, filterContextText, normalizeContextRules, validateContextRules } from '../yimu/context-filter.mjs';
import { DEFAULTS, validateSettings } from '../yimu/contract.mjs';
import { portableDocument } from '../yimu/backup-contract.mjs';
import { summaryPrompt } from '../yimu/core.mjs';

test('default context rules remove comments and presentation-only tags while unwrapping content', () => {
    const raw = '<content>正文一<!-- 状态注释 -->\n正文二</content><status>状态栏</status><style>.card{color:red}</style><p>保留</p>';
    assert.equal(filterContextText(raw), '正文一\n正文二');
    assert.deepEqual(DEFAULT_CONTEXT_RULES.blockedTags, ['status', 'status-bar', 'statusbar', 'progress', 'progress-bar', 'style', 'script', 'svg']);
    assert.deepEqual(DEFAULT_CONTEXT_RULES.includedTags, ['content']);
});

test('context rules accept user tags, keep ordinary text, and reject unsafe names', () => {
    const rules = validateContextRules({ stripComments: false, blockedTags: ['debug'], includedTags: ['content', '<quote>'] });
    assert.deepEqual(rules, { stripComments: false, blockedTags: ['debug'], includedTags: ['content', 'quote'] });
    assert.equal(filterContextText('<debug>drop</debug><quote>keep</quote><!--leave-->', rules), 'keep');
    assert.equal(filterContextText('没有 content 标签的普通正文', { includedTags: ['content'] }), '没有 content 标签的普通正文');
    assert.equal(filterContextText('<content>第一段</content><content>第二段</content><status>去掉</status>', { includedTags: ['content'] }), '第一段\n第二段');
    assert.equal(filterContextText('<content>第一段</content><aside>不在提取范围</aside>', { includedTags: ['content'] }), '第一段');
    assert.equal(filterContextText('<quote>先</quote><content>后</content><quote>再</quote>', { includedTags: ['content', 'quote'] }), '先\n后\n再');
    assert.throws(() => validateContextRules({ blockedTags: ['bad tag'] }), /标签名无效/);
    assert.throws(() => validateContextRules({ includedTags: Array.from({ length: 33 }, () => 'content') }), /标签规则过多/);
});

test('context rules persist in ordinary settings and memory backup settings', () => {
    const values = validateSettings({ contextRules: { blockedTags: ['status'], includedTags: ['content'] } }, false);
    assert.deepEqual(values.contextRules, { stripComments: true, blockedTags: ['status'], includedTags: ['content'] });
    const document = { schema: 7, revision: 0, binding: { avatar: 'a.png', file: 'a.jsonl', integrity: 'a'.repeat(64) }, enabled: false, autoSummary: false,
        epoch: 0, configRevision: 0, settings: { contextRules: values.contextRules }, initialRange: null, entries: [], entryOrder: [], operations: [], receipts: {} };
    assert.deepEqual(portableDocument(document).settings.contextRules, values.contextRules);
});

test('summary prompt applies context cleanup without mutating the source message', () => {
    const message = { name: '角色', is_user: false, mes: '<content>正文<!--装饰--><status>在线</status></content>' };
    const before = structuredClone(message);
    const prompt = summaryPrompt([message], { start: 1, end: 1 }, DEFAULTS);
    const source = JSON.parse(prompt.split('原文：')[1]);
    assert.equal(source[0].text, '正文');
    assert.deepEqual(message, before);
});
