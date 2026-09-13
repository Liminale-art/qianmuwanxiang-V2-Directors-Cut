// Host-owned cloud service. New-task UI stays gated until the complete client
// path is available. No workflow topology mutation or remote deletion.
import { Buffer } from 'node:buffer';
import { createImageServiceStore } from './qianmu-image-service-store.js';
import { createImageServiceResults } from './qianmu-image-service-results.js';
import { createComfyCloudLedger, comfyCloudResourceKey } from './qianmu-comfy-cloud-ledger.js';
import { submitComfyCloudTask } from './qianmu-comfy-cloud-submit.js';
import { createComfyCloudReceiver } from './qianmu-comfy-cloud-receive.js';
import { queryComfyCloudTask } from './qianmu-comfy-cloud-query.js';
import { bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { imageServiceAccount, imageServiceAccountStillMatches, imageServiceTaskView } from './qianmu-image-service-access.js';
import { describeImageServiceRequest } from './qianmu-image-service-queue.js';
import { parseBoundedJson } from './qianmu-json-input.js';
import { ImageGatewayError } from './qianmu-image-gateway.js';

const fail = (code, message, status = 409) => Object.assign(new ImageGatewayError(status, `comfy_cloud_service_${code}`, message), { retryable: false });
const keyOf = row => JSON.stringify([row.channelKey, row.attemptId]);

export function createComfyCloudService({ dataRoot, store, cache, transportOptions = {} } = {}) {
  store ||= createImageServiceStore({ dataRoot, scope: 'comfy-cloud' });
  cache ||= createImageServiceResults({ dataRoot, store, scope: 'comfy-cloud' });
  const ledger = createComfyCloudLedger({ store }), receiver = createComfyCloudReceiver({ ledger, cache });
  const active = new Set(); let closed = false, closing;
  const live = row => [...active].some(item => item.key === keyOf(row) && item.namespace === row.namespace);
  function run(req, raw, options, operation, tracksTask = false) {
    const submission = typeof tracksTask === 'function';
    try {
      const account = imageServiceAccount(req);
      if (closed || active.size >= 2) throw fail('busy', '云任务服务正在处理或停止，请稍后核查', 503);
      // Snapshot before asynchronous work; reject descriptors/cycles before JSON.
      if (describeImageServiceRequest({ input: raw }).requestBytes > 2 * 1024 * 1024) throw fail('input', '云任务请求过大');
      const input = parseBoundedJson(JSON.stringify(raw), { maxBytes: 2 * 1024 * 1024, maxDepth: 40, maxNodes: 50000, label: '云任务' });
      if (input?.version !== 1 || input.expectedAccount !== account.namespace) throw fail('account', 'ST账户已变化，请回原账户核查', 401);
      const taskKey = submission ? tracksTask(input) : tracksTask ? keyOf(input) : null;
      const controller = new AbortController(), signal = controller.signal, external = options?.signal;
      const onAbort = () => controller.abort(); external?.addEventListener('abort', onAbort, { once: true });
      if (external?.aborted) onAbort();
      const check = () => {
        if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST账户已变化，未交付云任务结果', 401);
        if (closed || signal.aborted) throw fail('stopped', '已停止等待，原任务和暂存仍保留');
      };
      const item = { key: taskKey, namespace: account.namespace, controller }; let started = false;
      active.add(item);
      item.work = Promise.resolve().then(async () => {
        check(); started = true; const value = await operation(input, account, signal, check);
        try { check(); } catch (cause) { if (submission && value?.status === 'accepted') cause.submissionState = 'accepted'; throw cause; }
        return value;
      })
        .catch(cause => {
          if (submission && !started) cause.submissionState = 'not_submitted';
          if (cause instanceof ImageGatewayError && String(cause.code).startsWith('comfy_cloud_service_')) throw cause;
          // Never echo arbitrary transport, filesystem or stored-record errors.
          const error = fail('unconfirmed', '云任务处理未完成，请核查原记录；未重新生成');
          if (['not_submitted', 'unknown', 'accepted'].includes(cause?.submissionState)) error.submissionState = cause.submissionState;
          throw error;
        }).finally(() => { external?.removeEventListener('abort', onAbort); active.delete(item); });
      return item.work;
    } catch (cause) {
      const error = cause instanceof ImageGatewayError ? cause : fail('input', '请登录原ST账户并核对云任务请求', cause?.status === 401 ? 401 : 400);
      if (submission) error.submissionState = 'not_submitted';
      return Promise.reject(error);
    }
  }
  return Object.freeze({
    submit(req, input, options) {
      return run(req, input, options, async (value, _account, signal) => ({ version: 1,
        ...(await submitComfyCloudTask(req, value, { ...transportOptions, ledger, signal })) }),
      value => keyOf({ attemptId: value.attemptId, channelKey: comfyCloudResourceKey(value.request?.connection, value.apiKey) }));
    },
    query(req, input, options) {
      return run(req, input, options, async (value, _account, signal, check) => {
        const task = bindComfyCloudTask(value.task, value.task?.taskId, value.task?.links);
        const grant = await ledger.authorizeStaging(req, value, task); check();
        const delivery = await grant.readDelivery(); check();
        if (delivery) return { ok: true, version: 1, status: delivery.state, task, delivery };
        const result = await queryComfyCloudTask(req, task, { ...transportOptions, apiKey: value.apiKey, signal, authorizeTask: async () => grant.verify });
        check();await grant.recordUsage(result);check();
        return { ok: true, version: 1, ...result };
      });
    },
    result(req, input, options) {
      return run(req, input, options, async (value, _account, signal, check) => {
        const packet = await receiver.receive(req, value, { ...transportOptions, signal }); check();
        if (packet.status !== 'staged') return { ok: true, version: 1, status: packet.status, task: packet.task, result: null,
          ...(packet.usage ? {usage:packet.usage} : {}) };
        const result = packet.result;
        const images = result.images.map((image, index) => ({ id: result.cloud.selection[index].outputKey ?? result.cloud.selection[index].assetId,
          mime: result.cloud.selection[index].mime, data: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64') }));
        await packet.grant.verify(); check();
        const delivery = await packet.grant.readDelivery(); check();
        if (delivery?.state === 'archived') return { ok: true, version: 1, status: 'archived', task: packet.task, result: null };
        if (delivery?.cacheReceipt !== result.receipt) throw fail('changed', '原图暂存凭证已变化，未交付');
        return { ok: true, version: 1, status: 'ready', provider: result.provider, model: result.model, upstreamId: result.upstreamId, images,
          task: packet.task, receipt: result.receipt, delivery, locator: { version: 1, channelKey: value.channelKey, attemptId: value.attemptId } };
      }, true);
    },
    acknowledge(req, input, options) {
      return run(req, input, options, async (value, _account, signal) => ({ ok: true, version: 1, ...(await receiver.acknowledge(req, value, { signal })) }), true);
    },
    catalog(req, input, options) {
      return run(req, input, options, async (value, account, _signal, check) => {
        let inventory;
        try { inventory = await cache.inventory(account.namespace); } catch (_) { /* Do not replace unreadable storage with zero. */ }
        check();
        const listed = await store.inspectAccount(account.namespace, { cursor: value.cursor ?? null, limit: value.limit ?? 40, select: inventory?.entries || [] }); check();
        const matches = new Map(listed.selected.map(row => [keyOf(row), row]));
        const cachedKeys = inventory ? new Set(inventory.entries.map(keyOf)) : null;
        const view = row => ({ ...imageServiceTaskView(row), taskLocator: { version: 1, channelKey: row.channelKey },
          task: row.cloudReceipt?.task || null, archiveState: row.cloudDelivery?.state || null, live: live(row),
          ...(row.cloudDelivery ? { cacheReceipt: row.cloudDelivery.cacheReceipt } : {}),
          ...(row.cloudDelivery?.usage||row.cloudObservation?.usage ? {usage:row.cloudDelivery?.usage||row.cloudObservation.usage} : {}),
          ...(row.cloudObservation ? {reportedStatus:row.cloudObservation.status,usageCheckedAt:row.cloudObservation.observedAt} : {}),
          canRetryCleanup: row.cloudDelivery?.state === 'archived' && !live(row) && (!cachedKeys || cachedKeys.has(keyOf(row))) });
        const originals = (inventory?.entries || []).map(meta => {
          const row = matches.get(keyOf(meta)), matched = row && row.fence === meta.fence && row.requestDigest === meta.requestDigest;
          return { ...(matched ? view(row) : { attemptId: meta.attemptId, status: 'unverified', taskLocator: { version: 1, channelKey: meta.channelKey } }),
            cacheBytes: meta.imageBytes, metadataBytes: meta.metadataBytes, temporaryBytes: meta.temporaryBytes, reservedBytes: meta.reservedBytes,
            imageCount: meta.imageCount, model: meta.model, resultStored: meta.ready,
            resultAvailable: Boolean(matched && meta.ready && row.cloudReceipt && row.cloudDelivery?.state !== 'archived'), canDiscard: false };
        });
        return { ok: true, version: 1, catalogVersion: 1, storageReadable: Boolean(inventory),
          totals: { ...(inventory?.totals || { count: null, imageBytes: null, metadataBytes: null, temporaryBytes: null, reservedBytes: null }), tasks: listed.total },
          originals, tasks: listed.entries.map(view), nextCursor: listed.nextCursor,
          ...(inventory ? {} : { warning: '暂存占用暂不可读取，请保留原记录并重试' }) };
      });
    },
    close() {
      if (closing) return closing;
      closed = true; for (const item of active) item.controller.abort();
      closing = Promise.allSettled([...active].map(item => item.work)).then(() => store.close());
      return closing;
    },
  });
}
