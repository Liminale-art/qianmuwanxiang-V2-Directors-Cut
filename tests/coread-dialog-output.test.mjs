import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const start = source.indexOf('const COREAD_DIALOG_OUTPUT_PROTOCOL');
const end = source.indexOf('function renderReaderDialogMessages', start);
assert.ok(start >= 0 && end > start, 'dialog output protocol/parser block should exist');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.__parse = parseCoreadDialogOutput;`, sandbox);
const parse = sandbox.__parse;

const leaked = parse(`<thought>\nThe user is testing a reading companion.\nI need to reply in 3 to 6 lines.\nLine 1: 收到，测试没有问题\nLine 2: 我刚读到最后一句`, false);
assert.deepEqual(Array.from(leaked.lines), ['收到，测试没有问题', '我刚读到最后一句']);
assert.match(leaked.thought, /The user is testing/);
assert.doesNotMatch(leaked.reply, /thought|Line 1|I need to reply/i);

const canonical = parse(`<qianmu_response><qianmu_thought>先判断语气</qianmu_thought><qianmu_reply><qianmu_line>第一句。</qianmu_line><qianmu_line>第二句。</qianmu_line></qianmu_reply></qianmu_response>`, false);
assert.deepEqual(Array.from(canonical.lines), ['第一句。', '第二句。']);
assert.equal(canonical.thought, '先判断语气');

const chineseTags = parse('<思考>先核对已读范围</思考>\n回复：只谈你现在读到的内容。', false);
assert.equal(chineseTags.thought, '先核对已读范围');
assert.equal(chineseTags.reply, '只谈你现在读到的内容。');

const hiddenDuringStream = parse('The user wants a concise reply, so I should think first.', true);
assert.equal(hiddenDuringStream.reply, '', 'unmarked stream text must not flash into the chat bubble');
assert.equal(parse('这是一句正常回复。', false).reply, '这是一句正常回复。');

assert.match(source, /reasoning_content[\s\S]*onReasoning/);
assert.match(source, /repairLegacyCoreadDialogMessages/);
assert.match(source, /sd-reader-thought-note/);
assert.match(style, /\.sd-reader-thought-note/);
assert.match(source, /不得输出 Line 1、行数说明、格式解释/);

console.log('Coread dialog output isolation contract OK');
