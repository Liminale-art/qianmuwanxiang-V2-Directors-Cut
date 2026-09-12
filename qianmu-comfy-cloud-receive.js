// Server-internal collection coordinator, not an HTTP route. The host supplies
// one receiver per cloud service and its shutdown signal. No submission, ACK,
// ledger settlement, cache deletion or ownership of the host store here.
import { bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { downloadComfyCloudJob } from './qianmu-comfy-cloud-asset-read.js';
import { normalizeComfyCloudStage } from './qianmu-comfy-cloud-stage-contract.js';

export function createComfyCloudReceiver({ ledger, cache, download = downloadComfyCloudJob } = {}) {
  if (typeof ledger?.authorizeStaging !== 'function' || typeof download !== 'function'
    || ['load', 'reserve', 'save'].some(name => typeof cache?.[name] !== 'function')) throw new Error('云端领取服务缺少原任务或暂存接口');
  const active = new Set(); let admitted = 0;
  return Object.freeze({
    async receive(req, input = {}, options = {}) {
      const task = bindComfyCloudTask(input.task, input.task?.taskId, input.task?.links), signal = options.signal;
      const fail = (code, message) => Object.assign(new Error(message), { code: `comfy_cloud_receive_${code}`, submissionState: 'accepted', upstreamId: task.taskId, retryable: false });
      if (task.provider !== 'comfy-cloud') throw fail('provider', '此平台的原图领取尚未就绪');
      if (admitted >= 2) throw fail('busy', '原图正在领取，请稍后核查');
      admitted++;
      let key, owned = false, stage = 'authorization';
      const check = () => { if (signal?.aborted) throw fail('cancelled', '已停止领取，原任务和暂存仍保留'); };
      try {
        check();
        const locator = { channelKey: input.channelKey, attemptId: input.attemptId, apiKey: input.apiKey };
        const grant = await ledger.authorizeStaging(req, locator, task);
        const verify = async () => { check(); const receipt = await grant.verify(); check(); return receipt; };
        await verify();
        key = JSON.stringify([grant.identity.namespace, grant.identity.channelKey, grant.identity.attemptId]);
        if (active.has(key)) return Object.freeze({ status: 'collecting', task, result: null });
        active.add(key); owned = true;
        const read = async () => {
          await verify();
          const result = await cache.load(grant.identity); // Full byte/hash check, never metadataOnly proof.
          await verify();
          if (result) {
            const cloud = normalizeComfyCloudStage(result.cloud, grant.identity);
            if (result.ok !== true || result.ready !== true || !/^[a-f0-9]{64}$/.test(result.receipt || '')
              || result.provider !== task.provider || result.upstreamId !== task.taskId || result.model !== grant.receipt.stillOutput.model
              || JSON.stringify(cloud.receipt) !== JSON.stringify(grant.receipt)) throw fail('readback', '暂存原图与原任务不一致，未交付');
          }
          return result;
        };
        stage = 'readback'; let result = await read();
        if (!result) {
          stage = 'reserve';
          const meta = await cache.load(grant.identity, { metadataOnly: true }); await verify();
          if (meta?.ready) result = await read();
          else if (!meta) {
            try { await cache.reserve(grant.identity); }
            catch (cause) { if (cause?.code !== 'image_service_result_exists') throw cause; result = await read(); }
            await verify();
          }
          if (!result) {
            stage = 'download';
            // Reuse the initial grant, not a fresh authorization after cache IO.
            const downloaded = await download(req, { task, ...locator }, { ...options, signal,
              ledger: { authorizeStaging: async () => { await verify(); return grant; } } });
            await verify();
            if (downloaded.status !== 'integrity_checked') {
              if (!['queued', 'running', 'canceling', 'canceled', 'failed', 'expired'].includes(downloaded.status) || downloaded.result !== null) throw fail('download', '原任务收图状态不完整，未交付');
              return Object.freeze({ status: downloaded.status, task, result: null });
            }
            if (downloaded.grant !== grant || JSON.stringify(downloaded.task) !== JSON.stringify(task)) throw fail('download', '原图未沿用原任务授权，未暂存');
            const cloud = normalizeComfyCloudStage(downloaded.result?.cloud, grant.identity);
            if (JSON.stringify(cloud.receipt) !== JSON.stringify(grant.receipt)) throw fail('download', '原图收据已变化，未暂存');
            stage = 'save'; await verify();
            try { await cache.save(grant.identity, downloaded.result); }
            catch (cause) { if (cause?.code !== 'image_service_result_exists') throw cause; }
            // Do not invoke ledger reads inside cache.exclusive: both use the
            // host store queue. Late writes stay at the ORIGINAL private slot;
            // changed identity/cancellation blocks delivery, not evidence retention.
            await verify(); stage = 'readback'; result = await read();
          }
        }
        if (!result) throw fail('readback', '原图暂存尚未完整，原任务仍保留');
        await verify();
        return Object.freeze({ status: 'staged', task, grant, result });
      } catch (cause) {
        if (signal?.aborted) throw fail('cancelled', '已停止领取，原任务和暂存仍保留');
        if (String(cause?.code).startsWith('comfy_cloud_receive_')) throw cause;
        throw fail(stage, stage === 'download' && String(cause?.code).startsWith('comfy_cloud_asset_read_') ? cause.message
          : '原图领取尚未确认，请核查原任务；未重新生成或清理暂存');
      } finally {
        if (owned) active.delete(key);
        admitted--;
      }
    },
  });
}
