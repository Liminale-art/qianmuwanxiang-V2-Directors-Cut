import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { blake3 } from '../vendor/noble-hashes-2.4.0/blake3.js';

const root = new URL('../vendor/noble-hashes-2.4.0/', import.meta.url);
// Public BLAKE3-team test vectors: input[i] = i % 251, first 32 output bytes.
// https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json
const vectors = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
  [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [2049, '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030'],
  [31744, '62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47'],
  [102400, 'bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085'],
];
const input = length => Uint8Array.from({ length }, (_, index) => index % 251);
const hex = bytes => Buffer.from(bytes).toString('hex');

test('offline BLAKE3 dependency subset retains exact upstream files and the full MIT notice', async () => {
  const manifest = JSON.parse(await readFile(new URL('VENDOR.json', root), 'utf8'));
  assert.equal(manifest.version, '2.4.0'); assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.upstreamNode, '>=20.19.0');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['LICENSE', '_blake.js', '_md.js', '_u64.js', 'blake2.js', 'blake3.js', 'utils.js']);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, root));
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${name} must not be locally rewritten`);
    if (name.endsWith('.js')) for (const match of bytes.toString().matchAll(/^import[\s\S]*?\bfrom\s+["']([^"']+)["']/gm)) {
      assert.ok(match[1].startsWith('./') && Object.hasOwn(manifest.files, match[1].slice(2)), 'all runtime dependencies must be bundled locally');
    }
  }
  assert.match(await readFile(new URL('LICENSE', root), 'utf8'), /Copyright \(c\) 2022 Paul Miller/);
});

test('vendored BLAKE3 matches official block and tree boundary vectors, not a substitute hash', () => {
  for (const [length, expected] of vectors) assert.equal(hex(blake3(input(length))), expected, `official length ${length}`);
});

test('incremental BLAKE3 gives the same official result across awkward byte boundaries', () => {
  for (const [length, expected] of vectors) {
    const bytes = input(length), state = blake3.create();
    try {
      for (let offset = 0; offset < length; offset += 127) state.update(bytes.subarray(offset, offset + 127));
      assert.equal(hex(state.digest()), expected, `incremental length ${length}`);
    } finally { state.destroy(); }
  }
});

test('interleaved tasks own separate hash state and a destroyed instance cannot be reused', () => {
  const a = blake3.create(), b = blake3.create(), bytes = input(2049);
  try {
    a.update(bytes.subarray(0, 1000)); b.update(bytes.subarray(0, 1)); a.update(bytes.subarray(1000));
    assert.equal(hex(b.digest()), vectors.find(row => row[0] === 1)[1]);
    assert.equal(hex(a.digest()), vectors.find(row => row[0] === 2049)[1]);
  } finally { a.destroy(); b.destroy(); }
  assert.throws(() => a.update(bytes));
});
