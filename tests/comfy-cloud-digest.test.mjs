import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyComfyCloudImageDigest as verify } from '../qianmu-comfy-cloud-digest.js';

// BLAKE3-team official one-byte vector (input byte = 0).
const oneByteHash = '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213';

test('known platform BLAKE3 is checked while absent platform evidence is explicitly not marked verified', async () => {
  const bytes = new Uint8Array([0]);
  for (const expected of [null, `blake3:${oneByteHash}`]) {
    const result = await verify(bytes, expected);
    assert.deepEqual(result.bytes, bytes); assert.notEqual(result.bytes.buffer, bytes.buffer);
    assert.equal(result.integrity.blake3, oneByteHash); assert.equal(result.integrity.platformHash, expected);
    assert.equal(result.integrity.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.integrity.platformVerified, expected === null ? null : true);
    assert.ok(Object.isFrozen(result.integrity)); assert.equal(result.integrity.sizeBytes, 1);
  }
  await assert.rejects(verify(bytes, `blake3:${'0'.repeat(64)}`), { code: 'comfy_cloud_digest_mismatch', retryable: false });
  assert.deepEqual(bytes, new Uint8Array([0]), 'failed verification must not wipe the caller input');
});

test('async integrity proof belongs to the returned snapshot, not to a mutated caller buffer', async () => {
  const original = new Uint8Array(1024 * 1024).fill(3);
  const pending = verify(original, null); original.fill(9);
  const result = await pending;
  assert.equal(result.bytes[0], 3); assert.equal(result.bytes.at(-1), 3);
  assert.equal(result.integrity.sha256, createHash('sha256').update(new Uint8Array(1024 * 1024).fill(3)).digest('hex'));
});

test('image hashing rejects ambiguous evidence, empty/shared bytes and unbounded deadlines', async () => {
  for (const expected of [undefined, '', 'sha256:abc', 'blake3:abc']) await assert.rejects(verify(new Uint8Array([0]), expected), { code: 'comfy_cloud_digest_expected' });
  for (const input of [[], new Uint8Array(), new Uint8Array(new SharedArrayBuffer(1))]) await assert.rejects(verify(input, null), { code: 'comfy_cloud_digest_bytes' });
  for (const timeoutMs of [0, -1, 60001, NaN]) await assert.rejects(verify(new Uint8Array([0]), null, { timeoutMs }), { code: 'comfy_cloud_digest_limits' });
});

test('chunked hashing yields to cancellation and enforces its whole calculation deadline', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024), controller = new AbortController(); let ticked = false;
  const pending = verify(bytes, null, { signal: controller.signal });
  setImmediate(() => { ticked = true; controller.abort('private-test-reason'); });
  await assert.rejects(pending, error => error.code === 'comfy_cloud_digest_cancelled' && !error.message.includes('private-test-reason'));
  assert.equal(ticked, true);
  await assert.rejects(verify(bytes, null, { timeoutMs: 1 }), { code: 'comfy_cloud_digest_timeout' });
  await assert.rejects(verify(bytes, null, { signal: controller.signal }), { code: 'comfy_cloud_digest_cancelled' });
});
