// Server-only integrity computation. This does not grant ownership, persist a
// result or acknowledge a cloud task. Use the returned private byte snapshot.
import { createHash } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { blake3 } from './vendor/noble-hashes-2.4.0/blake3.js';

export async function verifyComfyCloudImageDigest(input, expectedHash, { signal, timeoutMs = 15000 } = {}) {
  const ownErrors = new WeakSet();
  const fail = (code, message) => {
    const error = Object.assign(new Error(message), { code: `comfy_cloud_digest_${code}`, retryable: false });
    ownErrors.add(error); return error;
  };
  let bytes, state, saved = false;
  try {
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 48 * 1024 * 1024
      || !(input.buffer instanceof ArrayBuffer)) throw fail('bytes', '待核对的原图片数据无效或超限');
    if (expectedHash !== null && (typeof expectedHash !== 'string' || !/^blake3:[a-f0-9]{64}$/.test(expectedHash))) throw fail('expected', '原任务的图片摘要无效');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('limits', '图片摘要计算期限无效');
    const deadline = performance.now() + timeoutMs;
    const check = () => {
      if (signal?.aborted) throw fail('cancelled', '已停止图片校验，原任务仍保留');
      if (performance.now() >= deadline) throw fail('timeout', '图片校验超时，原任务仍保留');
    };
    check();
    // The source may be reused/mutated while this async calculation yields.
    // Keep exactly one private copy, and return that copy with its own proof.
    bytes = new Uint8Array(input); state = blake3.create();
    const local = createHash('sha256'); check();
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      check(); const chunk = bytes.subarray(offset, offset + 256 * 1024);
      state.update(chunk); local.update(chunk); check();
      await yieldToIO(undefined, { signal }); check();
    }
    const actual = Buffer.from(state.digest()).toString('hex'), sha256 = local.digest('hex'); check();
    if (expectedHash !== null && expectedHash !== `blake3:${actual}`) throw fail('mismatch', '图片摘要与平台原记录不一致，未入库，请核查原任务');
    const integrity = Object.freeze({ version: 1, sizeBytes: bytes.length, sha256, blake3: actual,
      platformHash: expectedHash, platformVerified: expectedHash === null ? null : true });
    saved = true; return Object.freeze({ bytes, integrity });
  } catch (cause) {
    if (ownErrors.has(cause)) throw cause;
    if (signal?.aborted) throw fail('cancelled', '已停止图片校验，原任务仍保留');
    throw fail('unavailable', '图片摘要暂无法核对，未入库，请核查原任务');
  } finally {
    state?.destroy();
    if (!saved) bytes?.fill(0);
  }
}
