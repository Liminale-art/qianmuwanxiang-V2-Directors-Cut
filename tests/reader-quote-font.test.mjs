// 伴读阅读页的书籍正文跟字体库的「正文」「引用」走；其余排版归伴读自己。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fontScopeCss } from '../qianmu-font-runtime.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const READER_QUOTE_RE'), source.indexOf('// 颜色白名单'));
const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const build = new Function('htmlEscape', 'sanitizeHexColor', `${code}; return buildReaderParagraphs;`)(htmlEscape, value => /^#[0-9a-f]{3,6}$/i.test(value || '') ? value : '');
const plain = html => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('quoted speech in the book text is wrapped for the quote font without changing a single character', () => {
    const text = '她说：“走吧。”然后停下。\n「等等」他喊，『别走』。\n没有引号的一段 <b>。\n"plain" and «guillemets» and ＂全角＂';
    const html = build(text, []);
    assert.equal(plain(html), text.replace(/\n/g, ''));
    assert.match(html, /<p>她说：<span class="sd-reader-q">“走吧。”<\/span>然后停下。<\/p>/);
    assert.match(html, /<p><span class="sd-reader-q">「等等」<\/span>他喊，<span class="sd-reader-q">『别走』<\/span>。<\/p>/);
    assert.match(html, /<p>没有引号的一段 &lt;b&gt;。<\/p>/, 'no quotes: untouched, still escaped');
    assert.match(html, /<span class="sd-reader-q">&quot;plain&quot;<\/span> and <span class="sd-reader-q">«guillemets»<\/span> and <span class="sd-reader-q">＂全角＂<\/span>/);
    assert.equal(build('他说：“没说完', []), '<p>他说：“没说完</p>', 'an unclosed quote is left alone');
});

test('a highlight that cuts through a quote keeps one mark; the quote wrapper is split around it, never across it', () => {
    const html = build('她说：“走吧，天快黑了。”然后停下。', [{ id: 'n1', text: '说：“走吧', hlStyle: 'mark' }]);
    assert.equal(plain(html), '她说：“走吧，天快黑了。”然后停下。');
    assert.equal((html.match(/<mark /g) || []).length, 1);
    assert.match(html, /<mark class="sd-reader-hl sd-reader-hl-mark" data-note="n1">说：<span class="sd-reader-q">“走吧<\/span><\/mark><span class="sd-reader-q">，天快黑了。”<\/span>然后停下。/);
    // 每个标签都成对闭合在同一层里。
    const stack = [];
    for (const [, close, name] of html.matchAll(/<(\/?)(p|mark|span)\b[^>]*>/g)) { if (!close) stack.push(name); else assert.equal(stack.pop(), name); }
    assert.equal(stack.length, 0);
});

test('the font library body and quote fonts reach the reader article; sizes and spacing are not touched', () => {
    const body = fontScopeCss('body', 'QianmuFont_61', { weight: '500', style: 'normal' }), quote = fontScopeCss('quote', 'QianmuFont_62', { weight: '400', style: 'italic' });
    assert.match(body, /\.sd-reader-article, \.sd-reader-article :is\(h2, p, mark, span\) \{ font-family:"QianmuFont_61"[^}]*!important; font-weight:500 !important; font-style:normal !important; \}/);
    assert.match(quote, /\.sd-reader-article \.sd-reader-q, \.sd-reader-article \.sd-reader-q \* \{ font-family:"QianmuFont_62"[^}]*!important; font-weight:400 !important; font-style:italic !important; \}/);
    for (const css of [body, quote]) {
        const reader = css.split('\n').filter(line => line.includes('.sd-reader-')).join('\n');
        assert.doesNotMatch(reader, /font-size|line-height|letter-spacing|margin|text-indent/, 'typography other than the face stays with the reader');
    }
    assert.equal(fontScopeCss('st', 'QianmuFont_63').includes('.sd-reader-article'), false, 'the interface font does not reach the book text');
});
