import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { fingerprintMessages } from '../yimu/contract.mjs';

const direct = async message => {
  const bytes = new TextEncoder().encode(JSON.stringify([String(message.name || ''), Boolean(message.is_user), false, String(message.mes || ''), String(message.send_date ?? '')]));
  return Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
};

test('remembered floor fingerprints always equal a direct digest, and any identity field change is seen', async () => {
  const chat = [{ name: 'A', is_user: false, mes: '第一层正文', send_date: '2026-01-01' }, { name: 'U', is_user: true, mes: '第二层', send_date: 1 }, { name: 'A', mes: '' }];
  const first = await fingerprintMessages(chat);
  assert.deepEqual(first, await Promise.all(chat.map(direct)));
  assert.deepEqual(await fingerprintMessages(structuredClone(chat)), first, 'a cloned snapshot of the same floors reuses the entries');
  for (const change of [m => { m.mes += '。'; }, m => { m.name = 'B'; }, m => { m.is_user = true; }, m => { m.send_date = '2026-01-02'; }]) {
    const edited = structuredClone(chat); change(edited[0]);
    const hashes = await fingerprintMessages(edited);
    assert.notEqual(hashes[0], first[0]); assert.equal(hashes[0], await direct(edited[0])); assert.equal(hashes[1], first[1]);
  }
  // 隐藏标记不属于楼层身份：忆幕自己会隐藏旧楼，隐藏不能让自己的切片来源失效。
  const hidden = structuredClone(chat); hidden[0].is_system = true;
  assert.deepEqual(await fingerprintMessages(hidden), first);
  // Fields outside the identity (swipes, extra) never affected the digest and still do not.
  assert.deepEqual(await fingerprintMessages(chat.map(m => ({ ...m, extra: { x: 1 }, swipes: ['z'] }))), first);
});

test('a long chat is hashed once; later rounds only pay for floors that changed', async () => {
  const chat = Array.from({ length: 600 }, (_, i) => ({ name: 'A', is_user: i % 2 === 0, mes: `长聊天第 ${i} 层 ` + '正文'.repeat(500), send_date: String(i) }));
  const cold = performance.now(); const first = await fingerprintMessages(chat); const coldMs = performance.now() - cold;
  const next = structuredClone(chat); next.push({ name: 'A', mes: '新的一层', send_date: 'n' });
  const warm = performance.now(); const second = await fingerprintMessages(next); const warmMs = performance.now() - warm;
  assert.deepEqual(second.slice(0, 600), first); assert.equal(second[600], await direct(next[600]));
  assert.ok(warmMs < coldMs, `repeat round should be cheaper (cold ${coldMs.toFixed(1)}ms, warm ${warmMs.toFixed(1)}ms)`);
});

test('the pre-send check compares the whole chat once per synchronous stretch, and streamed previews repaint at a bounded rate', async () => {
  const host = await readFile(new URL('../yimu/host.mjs', import.meta.url), 'utf8');
  assert.match(host, /sourceJson \?\?= JSON\.stringify\(record\.source\.messages\);\s*chatSame = JSON\.stringify\(ctx\.chat\) === sourceJson;\s*queueMicrotask\(\(\) => \{ chatSame = null; \}\);/);
  const current = host.slice(host.indexOf('const current = () => {', host.indexOf('const chatUnchanged')), host.indexOf('record.running = true;'));
  assert.match(current, /record\.used \|\| record\.generation !== generation \|\| isCurrent\(\) !== true/, 'cheap lifecycle flags are still read on every call');
  assert.match(current, /chatUnchanged\(ctx\)/); assert.doesNotMatch(current, /sameMessages\(ctx\.chat/);
  const runtime = await readFile(new URL('../yimu/runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /state\.streamPreview = accumulated\.slice\(-12000\);/);
  assert.match(runtime, /if \(streamTimer === null\) streamTimer = setTimeout\(\(\) => \{ streamTimer = null; emit\(\); \}, 120\);/);
  // 流式过程中的日志更新只改内存，不每个分块都写一次本机存储。
  assert.match(runtime, /journal\.update\(liveLog, \{ raw: accumulated \}, \{ persist: false \}\)/);
});
