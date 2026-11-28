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
    assert.match(html, /<p data-off="0">她说：<span class="sd-reader-q">“走吧。”<\/span>然后停下。<\/p>/);
    assert.match(html, /<p data-off="14"><span class="sd-reader-q">「等等」<\/span>他喊，<span class="sd-reader-q">『别走』<\/span>。<\/p>/);
    assert.match(html, /<p data-off="27">没有引号的一段 &lt;b&gt;。<\/p>/, 'no quotes: untouched, still escaped');
    assert.match(html, /<span class="sd-reader-q">&quot;plain&quot;<\/span> and <span class="sd-reader-q">«guillemets»<\/span> and <span class="sd-reader-q">＂全角＂<\/span>/);
    assert.equal(build('他说：“没说完', []), '<p data-off="0">他说：“没说完</p>', 'an unclosed quote is left alone');
});

test('a highlight that cuts through a quote keeps one mark; the quote wrapper is split around it, never across it', () => {
    const html = build('她说：“走吧，天快黑了。”然后停下。', [{ id: 'n1', from: 1, to: 6, hlStyle: 'mark' }]);
    assert.equal(plain(html), '她说：“走吧，天快黑了。”然后停下。');
    assert.equal((html.match(/<mark /g) || []).length, 1);
    assert.match(html, /<mark class="sd-reader-hl sd-reader-hl-mark" data-note="n1">说：<span class="sd-reader-q">“走吧<\/span><\/mark><span class="sd-reader-q">，天快黑了。”<\/span>然后停下。/);
    // 每个标签都成对闭合在同一层里。
    const stack = [];
    for (const [, close, name] of html.matchAll(/<(\/?)(p|mark|span)\b[^>]*>/g)) { if (!close) stack.push(name); else assert.equal(stack.pop(), name); }
    assert.equal(stack.length, 0);
});

// 旧渲染器两处缺陷的复现（S1 修）：一处空行让整章单换行并成空格；同一句话划一次，章内各处都亮。
test('one line is one paragraph even when the chapter has a blank line somewhere', () => {
    const text = '第一行。\n第二行。\n\n第三行。\n　　第四行有缩进。';
    const html = build(text, []);
    assert.deepEqual([...html.matchAll(/<p data-off="(\d+)">([^<]*)<\/p>/g)].map(m => [Number(m[1]), m[2]]),
        [[0, '第一行。'], [5, '第二行。'], [11, '第三行。'], [18, '第四行有缩进。']], 'each line its own paragraph, the blank line only separates');
    for (const [off, line] of [[5, '第二行。'], [18, '第四行有缩进。']]) assert.equal(text.slice(off, off + line.length), line, 'data-off is where the line starts in the chapter');
    assert.match(build('图前\n⟦img:3⟧\n图后', []), /<p data-off="0">图前<\/p><figure class="sd-reader-inline-fig" data-off="3"><img[^>]*data-img="3"/);
});

test('a highlight lights only the occurrence it was made on, not every copy of the same words', () => {
    const text = '同一句话。\n中间一行。\n同一句话。';
    const second = text.lastIndexOf('同一句话');
    const html = build(text, [{ id: 'n1', from: second, to: second + 4, hlStyle: 'wavy', color: '#123456' }]);
    assert.equal((html.match(/<mark /g) || []).length, 1, 'only one occurrence is marked');
    assert.match(html, /<p data-off="0">同一句话。<\/p>/);
    assert.match(html, /<p data-off="12"><mark class="sd-reader-hl sd-reader-hl-wavy" data-note="n1" style="--hl-color:#123456">同一句话<\/mark>。<\/p>/);
    // 跨段的一条划线：两段各画一截；旧划线待挑的位置只画虚线；样式名不在白名单里时按荧光画。
    const across = build(text, [{ id: 'n2', from: 2, to: 8, hlStyle: 'bad"x' }, { id: 'n3', from: second, to: second + 2, pick: 0 }]);
    assert.match(across, /同一<mark class="sd-reader-hl sd-reader-hl-mark" data-note="n2">句话。<\/mark><\/p><p data-off="6"><mark class="sd-reader-hl sd-reader-hl-mark" data-note="n2">中间<\/mark>一行。/);
    assert.match(across, /<mark class="sd-reader-hl-pick" data-note="n3" data-pick="0">同一<\/mark>句话。/);
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
