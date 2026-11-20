// 伴读记忆链路上「失败不出声」的几处：提示要真的弹得出来，必然失败的请求不反复发，没成功不报成功。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const between = (from, to) => { const start = source.indexOf(from); assert.ok(start >= 0, from); const end = source.indexOf(to, start + from.length); assert.ok(end > start, to); return source.slice(start, end); };

test('every toast uses a level the toast library actually has', () => {
    // toastr 只有 info / success / warning / error；写成 'warn' 的提示只会进控制台，用户什么都看不到。
    const levels = [...source.matchAll(/\btoast\((?:[^()]|\([^()]*\))*?,\s*'([a-z]+)'\)/g)].map(match => match[1]);
    assert.ok(levels.length > 200);
    assert.deepEqual([...new Set(levels)].filter(level => !['info', 'success', 'warning', 'error'].includes(level)), []);
});

test('a failed companion reply says why', () => {
    const reply = between('async function coreadGenerateReply', '\nasync function ');
    assert.match(reply, /toast\(`伴读对话生成失败：\$\{coreadExplainError\(error\)\}`, 'warning'\)/);
    assert.match(between('function coreadExplainError', '\n}'), /HTTP\\s\*400[^\n]+msg\.slice\(0, 120\)/, 'a 400 keeps the provider wording: it is not always the model name');
});

test('automatic text summaries report a real failure once and stop for this reading session', () => {
    const auto = between('async function coreadMaybeAutoDistillText', '\n}');
    assert.match(auto, /readerView\.autoTextOff\) return;/);
    assert.match(auto, /if \(r\?\.made > 0\) \{ toast\(/, 'a first batch that succeeded is still reported when the second fails');
    assert.match(auto, /if \(r && !r\.ok && r\.failed\) \{ view\.autoTextOff = true; toast\(`自动总结正文失败：\$\{r\.reason\}`, 'warning'\); \}/);
    assert.doesNotMatch(auto, /catch \(_\) \{\}/, 'no empty catch on this path');
    const read = between('async function coreadDistillReadText', '\nasync function ');
    assert.equal((read.match(/failed: true/g) || []).length, 3, 'request error, no valid summary, and save failure are the real failures');
    assert.doesNotMatch(read, /failed: true, reason: '(没有新读|已读内容都已)/, 'nothing new to summarize is not a failure');
});

test('summarizing the whole book stops at an error that will not fix itself and never reports success with nothing made', () => {
    const book = between('async function coreadDistillFullBook', '\nasync function ');
    assert.match(book, /if \(!coreadIsTransientError\(e\)\) \{ stopped = true; break; \}/);
    assert.match(book, /if \(stopped\) return \{ ok: false, reason: `蒸馏全书已停下：/);
    assert.match(book, /if \(!ok && fail && !aborted\) return \{ ok: false, reason: `蒸馏全书没有成功：/);
});

test('the two text summary buttons answer when another summary is already running', () => {
    assert.equal((source.match(/if \(coreadDistilling\) \{ toast\('正在总结中，请稍候。', 'info'\); return; \}/g) || []).length, 2);
    assert.doesNotMatch(source, /if \(coreadDistilling\) return;/);
});
