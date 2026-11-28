import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTextCollectionTagRules, normalizeTextCollectionTagRules, textCollectionPlainText,
    TEXT_COLLECTION_DEFAULT_TAG_RULES, TEXT_COLLECTION_TAG_RULE_LIMIT} from '../qianmu-text-collection-markup.js';

test('tag rules default to removing thinking; saved rows keep the 取材 model', () => {
    assert.deepEqual(normalizeTextCollectionTagRules(undefined), [{name: 'thinking', action: 'remove'}]);
    assert.deepEqual(normalizeTextCollectionTagRules(null), [{name: 'thinking', action: 'remove'}]);
    assert.deepEqual(TEXT_COLLECTION_DEFAULT_TAG_RULES, [{name: 'thinking', action: 'remove'}]);
    assert.deepEqual(normalizeTextCollectionTagRules([]), [], 'an explicit empty list means no rules');
    assert.deepEqual(normalizeTextCollectionTagRules([{name: ' <status> ', action: 'extract'}, {name: 'x', action: 'other'}, null, 'bad']),
        [{name: 'status', action: 'extract'}, {name: 'x', action: 'remove'}]);
    assert.equal(normalizeTextCollectionTagRules(Array.from({length: 99}, () => ({name: 'a'}))).length, TEXT_COLLECTION_TAG_RULE_LIMIT);
});

test('remove rules drop whole tag blocks and keep every other piece of markup verbatim', () => {
    const raw = '<thinking>\n想法\n</thinking>\n\n正文<b>加粗</b>\n<Status hp="1">HP 10</Status>\n\n<!-- 记号 -->尾';
    assert.equal(applyTextCollectionTagRules(raw, [{name: 'thinking', action: 'remove'}]),
        '正文<b>加粗</b>\n<Status hp="1">HP 10</Status>\n\n<!-- 记号 -->尾');
    assert.equal(applyTextCollectionTagRules(raw, [{name: 'thinking', action: 'remove'}, {name: 'status', action: 'remove'}]),
        '正文<b>加粗</b>\n\n\n<!-- 记号 -->尾'.replace('\n\n\n', '\n\n'), 'case-insensitive, extra blank lines collapse');
    assert.equal(applyTextCollectionTagRules(raw, []), raw.trim(), 'no rules: the source is unchanged');
    assert.equal(applyTextCollectionTagRules(raw, [{name: '', action: 'remove'}, {name: 'a b', action: 'remove'}]), raw.trim(),
        'blank or invalid names are ignored, never turned into a match-all pattern');
});

test('extract rules keep only those tags’ inner content in source order', () => {
    const raw = '<b>旁白</b><content>第一段 <i>斜</i></content>杂项<summary>摘要</summary><content>\n第二段\n</content>';
    assert.equal(applyTextCollectionTagRules(raw, [{name: 'summary', action: 'extract'}, {name: 'content', action: 'extract'}, {name: 'b', action: 'remove'}]),
        '第一段 <i>斜</i>\n\n摘要\n\n第二段');
    assert.equal(applyTextCollectionTagRules('没有标签', [{name: 'content', action: 'extract'}]), '');
});

test('plain text from formatted markup breaks blocks like the floor and decodes entities', () => {
    const html = '<p>第一段<br>同段换行</p>\n<p><q>“你好”</q> &amp; &lt;b&gt; &#26085;&#x672C;</p>'
        + '<style>.mes_text .bar{color:red}</style><div class="bar"><span>HP</span> <b>10</b></div><div>MP 3</div><!-- 注释 --><script>x()</script>';
    assert.equal(textCollectionPlainText(html), '第一段\n同段换行\n\n“你好” & <b> 日本\n\nHP 10\n\nMP 3');
    assert.equal(textCollectionPlainText('首段\n\n\n\n　　缩进保留  '), '首段\n\n　　缩进保留', 'full-width indentation inside the text stays');
    assert.equal(textCollectionPlainText(''), '');
});
