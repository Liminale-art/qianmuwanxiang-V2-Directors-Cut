import { inspectHistoricalStoryboardBundle } from './qianmu-historical-storyboard-bundle.js';
import { openStoryboardBundle } from './qianmu-storyboard-bundle.js';
import { planHistoricalStoryboardMerge } from './qianmu-historical-storyboard-merge.js';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';
import { createImageRestoreClient } from './qianmu-image-restore-client.js';
import { chatCharacterReceiptTarget } from './qianmu-chat-character-receipt.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'historical_original_restore', submissionState: 'not_submitted' }); };
const clone = structuredClone;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const encode = bytes => {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
};

// Only the original IMAGE FILE stage. No metadata assignment, recipe archive,
// library import, generation or destructive rollback. The caller must explicitly
// confirm a fresh preview; a compatible metadata plan is not that confirmation.
export function createHistoricalOriginalRestore({ file, namespace, target, readCurrent, guard, isCurrent,
  headers = () => ({}), fetchImpl = globalThis.fetch, timeoutMs = 600000, signal } = {}) {
  if (!(file instanceof Blob) || typeof namespace !== 'string' || ![readCurrent, guard, isCurrent, headers, fetchImpl].every(fn => typeof fn === 'function')
    || !Number.isFinite(timeoutMs) || timeoutMs < 1) fail('缺少历史原图恢复文件、准确来源或页面保护');
  const selectedTarget = chatCharacterReceiptTarget(target);
  let closed = false, busy = false, pendingAbort = null, preview = null;
  const close = () => { closed = true; preview = null; pendingAbort?.(); };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  const current = () => {
    if (closed || signal?.aborted || isCurrent() !== true) fail('历史原图恢复页面或账户已变化，请保留原包核对');
  };
  async function operation(work) {
    current(); if (busy) fail('已有原图核对或恢复正在进行'); busy = true;
    const controller = new AbortController(), completed = []; let attempted = false, reject;
    const cancelled = new Promise((_, no) => reject = no);
    const abort = () => { controller.abort(); reject(new Error('历史原图恢复已取消或超时')); };
    pendingAbort = abort;
    const timer = setTimeout(abort, Math.min(600000, timeoutMs));
    const check = async () => {
      current(); if (controller.signal.aborted) fail('历史原图恢复已停止');
      if (await guard() === false) fail('历史原图恢复来源保护未通过');
      current(); if (controller.signal.aborted) fail('历史原图恢复已停止');
    };
    // The existing client owns its request deadline and aborts on body completion.
    // Link that lifetime with this stage without losing cancellation after headers.
    const fetchLinked = async (url, options) => {
      await check();
      const linked = new AbortController();
      const stop = () => {
        linked.abort(); controller.signal.removeEventListener('abort', stop); options.signal.removeEventListener('abort', stop);
      };
      controller.signal.addEventListener('abort', stop, { once: true }); options.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted || options.signal.aborted) stop();
      try { return await fetchImpl(url, { ...options, signal: linked.signal }); }
      catch (error) { stop(); throw error; }
    };
    try {
      const images = createImageRestoreClient({ namespace, headers, fetchImpl: fetchLinked, guard: check });
      return await Promise.race([Promise.resolve().then(() => work({ check, images, completed, markWrite: () => { attempted = true; } })), cancelled]);
    } catch (cause) {
      preview = null;
      // A started request may already have committed even if its reply was lost.
      // Do not report an automatic rollback or replay it on a late response.
      if (attempted) closed = true;
      throw Object.assign(new Error(attempted ? '历史原图写入尚未完整确认；已完成的原件保留，请重新核对，未自动重传或删除' : cause.message), {
        code: 'historical_original_restore', cause, originalsState: attempted ? 'needs_review' : 'not_started',
        completed: clone(completed), metadataRestored: false, submissionState: 'not_submitted',
      });
    } finally {
      clearTimeout(timer); controller.abort(); pendingAbort = null; busy = false;
      if (closed) signal?.removeEventListener('abort', close);
    }
  }
  async function snapshot(check) {
    await check(); const value = clone(await readCurrent()); await check();
    if (!value || value.namespace !== namespace || !same(chatCharacterReceiptTarget(value.target), selectedTarget)) fail('当前聊天不再是原账户及原角色／群组的准确聊天');
    // Select only the detached source contract, not a live context/global settings.
    return { namespace, target: selectedTarget, saved: value.saved, evidence: value.evidence };
  }
  async function prepare({ check, images }) {
    const inspected = await inspectHistoricalStoryboardBundle(file, { guard: check }); await check();
    if (inspected.source.namespace !== namespace || !same(chatCharacterReceiptTarget(inspected.source.target), selectedTarget)) fail('原件包不属于所选账户和聊天');
    const baseline = await snapshot(check);
    const plan = await planHistoricalStoryboardMerge({ source: inspected.source, namespace, target: selectedTarget,
      currentSaved: baseline.saved, currentEvidence: baseline.evidence, guard: check });
    if (!plan.compatible) fail('当前资料与历史原件存在冲突，未写入任何原图');
    const receipts = new Map();
    for (let i = 0; i < inspected.media.images.length; i++) {
      const row = inspected.media.images[i], url = inspected.source.saved.storyboardImages[i].url;
      const receipt = imageRestoreReceipt({ url, sha256: row.sha256, bytes: row.bytes, mime: row.mime });
      // Encoded spellings of one path are one destination, not independent writes.
      const key = decodeURIComponent(receipt.url), previous = receipts.get(key);
      if (previous && ['sha256', 'mime', 'bytes'].some(field => previous[field] !== receipt[field])) fail('历史原件中同一图片路径对应不同内容，未开始写入');
      if (!previous) receipts.set(key, receipt);
    }
    const originals = [];
    // Preflight EVERY destination before the first write. Existing conflicts may
    // never be hidden behind successfully restored earlier files.
    for (const receipt of receipts.values()) {
      await check(); const result = await images.inspect(receipt); await check();
      originals.push({ receipt, state: result.state });
    }
    const baselineDigest = await vibeDigest(JSON.stringify(baseline));
    if (await vibeDigest(JSON.stringify(await snapshot(check))) !== baselineDigest) fail('核对期间正文或聊天资料已变化');
    const core = { scope: 'historical-original-files-only', fingerprint: inspected.fingerprint, namespace, target: selectedTarget,
      metadataDigest: plan.digest, originals, ready: originals.every(row => row.state !== 'conflict'),
      metadataRestored: false, recipesRestored: false, dependenciesRestored: false };
    const digest = await vibeDigest(JSON.stringify(core)); await check();
    return { view: { ...core, digest }, baselineDigest };
  }
  return Object.freeze({
    close() { signal?.removeEventListener('abort', close); close(); },
    preview() { return operation(async context => { preview = null; const result = await prepare(context); preview = clone(result.view); return clone(result.view); }); },
    restore({ confirmed = false, expectedDigest, scope } = {}) {
      // Capture primitive confirmation before any asynchronous work, and consume
      // the preview once. Failures always require a fresh inspect + confirmation.
      if (confirmed !== true || scope !== 'historical-original-files-only' || !preview?.ready || expectedDigest !== preview.digest) return Promise.reject(Object.assign(new Error('请核对并明确确认仅补齐历史原图文件'), { code: 'historical_original_restore', originalsState: 'not_started' }));
      const selectedDigest = expectedDigest;
      return operation(async context => {
        preview = null; const { check, images, completed, markWrite } = context;
        const prepared = await prepare(context);
        if (!prepared.view.ready || prepared.view.digest !== selectedDigest) fail('原图或聊天资料已变化，请重新核对并确认');
        const verifyBaseline = async () => { if (await vibeDigest(JSON.stringify(await snapshot(check))) !== prepared.baselineDigest) fail('恢复期间正文或资料已变化，未继续写入'); await check(); };
        const opened = await openStoryboardBundle(file, { guard: check });
        if (opened.fingerprint !== prepared.view.fingerprint) fail('原件文件指纹已变化');
        for (const row of prepared.view.originals) {
          await verifyBaseline();
          if (row.state === 'present') continue;
          const part = await opened.read('image:' + row.receipt.sha256); await check();
          if (part.bytes.length !== row.receipt.bytes) fail('原图分段长度不符');
          const data = encode(part.bytes); await verifyBaseline();
          markWrite(); const result = await images.restore(row.receipt, data, { confirmed: true }); await check();
          // A positive POST reply is not the final file readback.
          const verified = await images.inspect(row.receipt); await check();
          if (verified.state !== 'present') fail('刚写入的原图读回未确认');
          completed.push({ receipt: row.receipt, state: result.state });
        }
        await verifyBaseline();
        for (const row of prepared.view.originals) { const result = await images.inspect(row.receipt); await check(); if (result.state !== 'present') fail('恢复完成核对发现原图缺失或变化'); }
        await verifyBaseline();
        return { scope: 'historical-original-files-only', fingerprint: prepared.view.fingerprint,
          originalsVerified: prepared.view.originals.length, completed: clone(completed),
          metadataRestored: false, recipesRestored: false, dependenciesRestored: false, restoreSupported: false };
      });
    },
  });
}
