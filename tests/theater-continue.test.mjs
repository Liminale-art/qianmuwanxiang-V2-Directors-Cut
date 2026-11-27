import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sceneTurns, canContinue, turnChars, buildContinueMessages, flattenContinueMessages, renderTheaterTurns,
  THEATER_TURN_CHARS_LIMIT, THEATER_CONTINUE_GUIDE } from '../features/theater/qianmu-theater-continue.js';

const extract = value => (/<幕外正文>([\s\S]*?)<\/幕外正文>/.exec(value) || [, value])[1];
const esc = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const scene = {
  id: 's1', instruction: '雨夜重逢', content: '想一想<幕外正文>雨下了一整夜。</幕外正文>', isHtml: false,
  turns: [{ id: 't1', role: 'user', content: '我把伞递给他' }, { id: 't2', role: 'assistant', content: '<幕外正文>他接了。</幕外正文>' }, { role: 'assistant', content: '  ' }, null],
};

test('turns are cleaned; HTML scenes and full scenes cannot be continued', () => {
  assert.deepEqual(sceneTurns(scene).map(turn => [turn.id, turn.role]), [['t1', 'user'], ['t2', 'assistant']]);
  assert.equal(canContinue(scene), true);
  assert.equal(canContinue({ ...scene, isHtml: true }), false);
  assert.equal(canContinue({ ...scene, turns: [{ role: 'user', content: 'x'.repeat(THEATER_TURN_CHARS_LIMIT) }] }), false);
  assert.equal(turnChars(sceneTurns(scene)), '我把伞递给他'.length + '<幕外正文>他接了。</幕外正文>'.length);
});

test('the request replays the scene as a conversation and ends with this turn, the guide and the output format', () => {
  const messages = buildContinueMessages({ background: '【当前角色设定】甲', scene, input: '他没有接', userName: '乙', extract });
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(messages[0].content, /【当前角色设定】甲[\s\S]*【此幕指令】\n雨夜重逢/);
  assert.equal(messages[1].content, '雨下了一整夜。', 'only the body inside the tag, never the model’s thinking');
  assert.equal(messages[2].content, '【乙这一回】\n我把伞递给他');
  assert.equal(messages[3].content, '他接了。');
  assert.ok(messages[4].content.startsWith('【乙这一回】\n他没有接'));
  assert.ok(messages[4].content.includes(THEATER_CONTINUE_GUIDE));
  assert.match(messages[4].content, /<幕外正文> 与 <\/幕外正文>/);
  const flat = flattenContinueMessages(messages);
  assert.match(flat, /【已经写出的这一幕】\n雨下了一整夜。[\s\S]*【已经写出的这一幕（续）】\n他接了。/);
});

test('the reader shows each turn, tools only on the last continuation, and a composer unless read-only', () => {
  const html = renderTheaterTurns(scene, { esc, markdown: value => `<p>${esc(value)}</p>`, extract, userName: '乙<', scale: 'large', draft: '草稿' });
  assert.match(html, /class="sd-theater-turns sd-reader-prose" data-scale="large"/);
  assert.match(html, /is-user[\s\S]*乙&lt;[\s\S]*我把伞递给他/);
  assert.match(html, /<p>他接了。<\/p>[\s\S]*sd-theater-turn-redo[\s\S]*sd-theater-turn-drop/);
  assert.match(html, /sd-theater-turn-input[^>]*>草稿<\/textarea>/);
  const busy = renderTheaterTurns(scene, { esc, markdown: esc, extract, busy: true, pendingId: 'p1' });
  assert.doesNotMatch(busy, /sd-theater-turn-redo/);
  assert.match(busy, /data-pending="p1"[\s\S]*sd-as-stop/);
  const readonly = renderTheaterTurns(scene, { esc, markdown: esc, extract, readonly: true });
  assert.doesNotMatch(readonly, /sd-theater-turn-input|sd-theater-turn-redo/);
  assert.equal(renderTheaterTurns({ ...scene, isHtml: true }, { esc, markdown: esc, extract }), '');
});

test('index.js keeps every copy of a scene in step and favorites carry the continuation', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /function theaterSceneCopies[\s\S]*t\.lastOutput, \.\.\.\(t\.recentOutputs \|\| \[\]\), \.\.\.\(t\.favorites \|\| \[\]\)/);
  assert.match(source, /t\.favorites\.unshift\(\{[^}]*turns: sceneTurns\(scene\)/);
  assert.match(source, /setTheaterSceneTurns\(scene, previous\);/, 'a failed continuation restores the scene exactly');
});
