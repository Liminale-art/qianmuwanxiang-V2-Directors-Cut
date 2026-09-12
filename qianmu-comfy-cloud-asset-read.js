// Server-internal metadata coordination. Returned source URLs are short-lived
// download inputs, never HTTP responses, ledger rows, logs or archived results.
import { bindComfyCloudTask, comfyCloudAssetId } from './qianmu-comfy-cloud-protocol.js';
import { queryComfyCloudTask } from './qianmu-comfy-cloud-query.js';
import { createComfyCloudAssetTransport, createComfyCloudFileTransport } from './qianmu-comfy-server-transport.js';
import { readComfyCloudJsonResponse, readComfyCloudImageResponse } from './qianmu-comfy-cloud-response.js';
import { matchComfyCloudAssetMetadata } from './qianmu-comfy-cloud-asset.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { verifyComfyCloudImageDigest } from './qianmu-comfy-cloud-digest.js';
import { COMFY_CLOUD_STAGE_SCHEMA, normalizeComfyCloudStage } from './qianmu-comfy-cloud-stage-contract.js';

export async function readComfyCloudAsset(req, input, options) {
  return readAsset(req, input, options, false);
}

// Integrity checked only: not yet staged or acknowledged. Missing platform hash
// remains explicitly unverified, even though local digests are computed.
// This server-only result deliberately excludes the sensitive signed source URL.
export async function downloadComfyCloudAsset(req, input, options = {}) {
  return readAsset(req, input, { ...options, timeoutMs: options.timeoutMs === undefined ? 60000 : options.timeoutMs }, true);
}

// Server-only whole-job handoff. The original grant accompanies the verified
// bytes for subsequent staging; this is not an HTTP packet or acknowledgement.
export async function downloadComfyCloudJob(req, input, options = {}) {
  return readAsset(req, input, { ...options, timeoutMs: options.timeoutMs === undefined ? 60000 : options.timeoutMs }, 'job');
}

async function readAsset(req, { task: rawTask, assetId: rawId, channelKey, attemptId, apiKey } = {}, {
  ledger, authorizeTarget, timeoutMs = 15000, signal, resolveHost, requestImpl, maxBytes, now = Date.now,
} = {}, download) {
  const task = bindComfyCloudTask(rawTask, rawTask?.taskId, rawTask?.links), all = download === 'job', assetId = comfyCloudAssetId(rawId), ownErrors = new WeakSet();
  const fail = (code, message) => {
    const error = Object.assign(new Error(message), { code: `comfy_cloud_asset_read_${code}`, submissionState: 'accepted', upstreamId: task.taskId, retryable: false });
    ownErrors.add(error); return error;
  };
  let account; try { account = imageServiceAccount(req); } catch (_) { throw fail('account', '请先登录原ST账户读取图片信息'); }
  if ((!all && !assetId) || task.provider !== 'comfy-cloud') throw fail('asset', '原图片资产身份或平台无效');
  if (typeof ledger?.[all ? 'authorizeStaging' : 'authorizeQuery'] !== 'function' || typeof authorizeTarget !== 'function') throw fail('authorization', '原图片缺少持久归属或连接授权');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof now !== 'function') throw fail('limits', '图片信息读取限制无效');
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  let timer, onAbort, interruption, response, stage = 'authorization';
  const check = () => {
    if (interruption) throw interruption;
    if (performance.now() >= deadline) throw fail('timeout', '读取图片信息超时，原任务仍保留');
    if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST账户已变化，未交付图片信息');
  };
  const remaining = () => { check(); return Math.max(1, Math.ceil(deadline - performance.now())); };
  const stopped = new Promise((_, reject) => {
    const stop = error => { interruption ||= error; reject(interruption); controller.abort(); };
    timer = setTimeout(() => stop(fail('timeout', '读取图片信息超时，原任务仍保留')), timeoutMs);
    onAbort = () => stop(fail('cancelled', '已停止读取图片信息，原任务仍保留'));
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  });
  const work = async () => {
    check();
    const grant = all ? await ledger.authorizeStaging(req, { channelKey, attemptId, apiKey }, task) : null;
    const verifyOriginal = all ? grant?.verify : await ledger.authorizeQuery(req, { channelKey, attemptId, apiKey }, task); check();
    if (typeof verifyOriginal !== 'function') throw fail('authorization', '原任务缺少持续归属校验');
    const verify = async () => { check(); const receipt = await verifyOriginal(); check(); return receipt; };
    await verify(); stage = 'query';
    const result = await queryComfyCloudTask(req, task, { apiKey, authorizeTask: async () => verify, authorizeTarget,
      signal: controller.signal, timeoutMs: remaining(), resolveHost, requestImpl, maxBytes, includeStillOutputs: true });
    await verify();
    if (result.status !== 'succeeded') return Object.freeze({ task, status: result.status, ...(all ? { result: null } : { asset: null }) });
    if (all) {
      const selection = result.stillOutputs.outputs, received = [];
      // Sequential collection bounds transient image buffers and keeps the
      // original output order. All files share one deadline and one grant.
      for (const selected of selection) received.push(await readExpected(selected));
      await verify(); check(); stage = 'contract';
      const cloud = normalizeComfyCloudStage({ schema: COMFY_CLOUD_STAGE_SCHEMA, identity: grant.identity, receipt: grant.receipt, selection,
        images: received.map(image => ({ assetId: image.asset.assetId, hash: image.asset.hash, integrity: image.integrity })) }, grant.identity);
      check();
      return Object.freeze({ status: 'integrity_checked', task, grant, result: Object.freeze({ ok: true, provider: task.provider,
        model: cloud.receipt.stillOutput.model, upstreamId: task.taskId, cloud,
        images: Object.freeze(received.map(image => Object.freeze({ bytes: image.bytes }))) }) });
    }
    const expected = result.stillOutputs.outputs.find(row => row.assetId === assetId);
    if (!expected) throw fail('asset', '此图片不在原任务的最终输出中，未读取');
    return readExpected(expected);
    async function readExpected(expected) {
      const assetId = expected.assetId;
      stage = 'metadata';
      const transport = await createComfyCloudAssetTransport(req, { task, assetId }, {
        authorizeTarget, signal: controller.signal, resolveHost, requestImpl,
        authorizeAsset: async (_req, resource, owner) => {
          await verify();
          if (owner.namespace !== account.namespace || resource.assetId !== assetId || JSON.stringify(resource.task) !== JSON.stringify(task)) throw fail('asset', '原图片读取目标已变化');
          return verify;
        },
      });
      await verify();
      response = await transport.fetchImpl(transport.plan.url, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: controller.signal });
      check(); stage = 'response';
      const body = await readComfyCloudJsonResponse(response, { task, signal: controller.signal, timeoutMs: remaining(), maxBytes });
      check(); stage = 'match'; const matched = matchComfyCloudAssetMetadata(task, expected, body, { now: now() });
      stage = 'delivery'; await transport.verify(); await verify();
      if (!download) return Object.freeze({ status: 'metadata_ready', ...matched });
      stage = 'file';
      const file = await createComfyCloudFileTransport(req, { task, assetId, source: matched.source }, {
        authorizeTarget, signal: controller.signal, resolveHost, requestImpl, now,
        authorizeAsset: async (_req, resource, owner) => {
          await verify();
          if (owner.namespace !== account.namespace || resource.assetId !== assetId || JSON.stringify(resource.task) !== JSON.stringify(task)
            || resource.source.url !== matched.source.url || resource.source.expiresAt !== matched.source.expiresAt) throw fail('asset', '原图片下载目标已变化');
          return verify;
        },
      });
      await verify();
      response = await file.fetchImpl(matched.source.url, { method: 'GET', signal: controller.signal });
      check(); stage = 'bytes';
      const image = await readComfyCloudImageResponse(response, { task, mime: matched.asset.mime, sizeBytes: matched.asset.sizeBytes,
        signal: controller.signal, timeoutMs: remaining() });
      stage = 'digest';
      const verified = await verifyComfyCloudImageDigest(image.bytes, matched.asset.hash, { signal: controller.signal, timeoutMs: remaining() });
      stage = 'delivery'; await verify(); await file.verify(); check();
      const deliveredAt = now();
      if (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0 || deliveredAt >= matched.source.expiresAt) throw fail('expired', '图片链接已失效，请刷新原任务，不必重新生图');
      return Object.freeze({ status: 'integrity_checked', task, asset: matched.asset, bytes: verified.bytes, mime: image.mime, integrity: verified.integrity });
    }
  };
  try { return await Promise.race([work(), stopped]); }
  catch (cause) {
    if (interruption) throw interruption;
    if (ownErrors.has(cause)) throw cause;
    const readableCause = stage === 'match' && String(cause?.code).startsWith('comfy_cloud_asset_')
      || stage === 'bytes' && String(cause?.code).startsWith('comfy_cloud_response_')
      || stage === 'digest' && String(cause?.code).startsWith('comfy_cloud_digest_');
    const error = fail(stage, readableCause ? cause.message : '原图片信息暂无法确认，请核查原任务，未重新生图');
    if (response && !response.ok && Number.isInteger(response.status)) error.httpStatus = response.status;
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
    try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* Transport owns any remaining stream. */ }
  }
}
