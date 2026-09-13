// Internal original-job download only. No submit, retry, archive or platform
// deletion. Reuse the cloud transport, byte limits, digest and staging contracts.
import { bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { queryComfyCloudTask } from './qianmu-comfy-cloud-query.js';
import { createRunningHubFileTransport } from './qianmu-comfy-server-transport.js';
import { readRunningHubImageResponse } from './qianmu-comfy-cloud-response.js';
import { verifyComfyCloudImageDigest } from './qianmu-comfy-cloud-digest.js';
import { RUNNINGHUB_STAGE_SCHEMA, normalizeComfyCloudStage } from './qianmu-comfy-cloud-stage-contract.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

export async function downloadRunningHubJob(req, { task: rawTask, channelKey, attemptId, apiKey } = {}, {
  ledger, authorizeTarget, timeoutMs = 60000, signal, resolveHost, requestImpl, maxBytes,
} = {}) {
  const task = bindComfyCloudTask(rawTask, rawTask?.taskId, rawTask?.links), ownErrors = new WeakSet();
  const fail = (code, message) => {
    const error = Object.assign(new Error(message), { code: `runninghub_download_${code}`, submissionState: 'accepted', upstreamId: task.taskId, retryable: false });
    ownErrors.add(error); return error;
  };
  const account = imageServiceAccount(req);
  if (task.provider !== 'runninghub' || typeof ledger?.authorizeStaging !== 'function' || typeof authorizeTarget !== 'function') throw fail('authorization', '原图片缺少持久归属或连接授权');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('limits', '图片读取限制无效');
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  let timer, onAbort, interruption, response, stage = 'authorization';
  const check = () => {
    if (interruption) throw interruption;
    if (performance.now() >= deadline) throw fail('timeout', '读取图片超时，原任务仍保留');
    if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST账户已变化，未交付原图');
  };
  const remaining = () => { check(); return Math.max(1, Math.ceil(deadline - performance.now())); };
  const stopped = new Promise((_, reject) => {
    const stop = error => { interruption ||= error; reject(interruption); controller.abort(); };
    timer = setTimeout(() => stop(fail('timeout', '读取图片超时，原任务仍保留')), timeoutMs);
    onAbort = () => stop(fail('cancelled', '已停止读取原图，原任务仍保留'));
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  });
  const work = async () => {
    check(); const grant = await ledger.authorizeStaging(req, { channelKey, attemptId, apiKey }, task); check();
    if (typeof grant?.verify !== 'function') throw fail('authorization', '原任务缺少持续归属校验');
    const verify = async () => { check(); const receipt = await grant.verify(); check(); return receipt; };
    await verify(); stage = 'query';
    const query = await queryComfyCloudTask(req, task, { apiKey, authorizeTask: async () => verify, authorizeTarget,
      signal: controller.signal, timeoutMs: remaining(), resolveHost, requestImpl, maxBytes, includeStillOutputs: true });
    await verify();await grant.recordUsage?.(query);await verify();
    if (query.status !== 'succeeded') return Object.freeze({ status: query.status, task, result: null });
    const selection = [], images = [], proofs = []; let bytesRemaining = 48 * 1024 * 1024;
    for (const output of query.stillOutputs.outputs) {
      stage = 'file';
      const file = await createRunningHubFileTransport(req, { task, output }, { signal: controller.signal, resolveHost, requestImpl,
        authorizeTarget: async (request, target) => {
          if (target.baseUrl !== `${new URL(output.sourceUrl).origin}/` || target.allowPrivateNetwork) throw fail('source', '原图片地址已变化');
          await verify(); return authorizeTarget(request, { baseUrl: `${task.origin}/`, allowPrivateNetwork: false });
        },
        authorizeAsset: async (_req, resource, owner) => {
          await verify();
          if (owner.namespace !== account.namespace || JSON.stringify(resource.task) !== JSON.stringify(task)
            || resource.nodeId !== output.nodeId || resource.outputIndex !== output.outputIndex || resource.source.url !== output.sourceUrl) throw fail('source', '原图片归属已变化');
          return verify;
        },
      });
      await verify(); response = await file.fetchImpl(output.sourceUrl, { method: 'GET', signal: controller.signal }); check();
      stage = 'bytes'; const image = await readRunningHubImageResponse(response, { task, mime: output.mime, maxBytes: bytesRemaining, timeoutMs: remaining(), signal: controller.signal });
      bytesRemaining -= image.bytes.byteLength;
      stage = 'digest'; const verified = await verifyComfyCloudImageDigest(image.bytes, null, { signal: controller.signal, timeoutMs: remaining() });
      await verify(); await file.verify(); check();
      const outputKey = `rh:${task.taskId}:${output.outputIndex}:${output.nodeId}`;
      selection.push({ outputKey, outputIndex: output.outputIndex, nodeId: output.nodeId, mime: image.mime, sizeBytes: verified.bytes.byteLength, hash: null });
      proofs.push({ outputKey, hash: null, integrity: verified.integrity }); images.push(Object.freeze({ bytes: verified.bytes }));
    }
    stage = 'contract'; await verify();
    const cloud = normalizeComfyCloudStage({ schema: RUNNINGHUB_STAGE_SCHEMA, identity: grant.identity, receipt: grant.receipt, selection, images: proofs,
      ...(query.usage ? {usage:query.usage} : {}) }, grant.identity);
    check(); return Object.freeze({ status: 'integrity_checked', task, grant, result: Object.freeze({ ok: true, provider: task.provider,
      model: cloud.receipt.stillOutput.model, upstreamId: task.taskId, cloud, images: Object.freeze(images) }) });
  };
  try { return await Promise.race([work(), stopped]); }
  catch (cause) {
    if (interruption) throw interruption;
    if (ownErrors.has(cause)) throw cause;
    const readable = stage === 'bytes' && String(cause?.code).startsWith('comfy_cloud_response_') || stage === 'digest' && String(cause?.code).startsWith('comfy_cloud_digest_');
    const error = fail(stage, readable ? cause.message : '原图暂无法读取，请刷新原任务核查；未重新生图');
    if (response && !response.ok && Number.isInteger(response.status)) error.httpStatus = response.status;
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
    try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* Transport owns remaining bytes. */ }
  }
}
