// Server-internal collection coordinator, not an HTTP route. The host supplies
// one receiver per cloud service and its shutdown signal. Storage is confirmed
// only after full readback. Client ACK is durable before bounded cache cleanup.
// No submission, cloud deletion or store ownership.
import { bindComfyCloudTask } from './qianmu-comfy-cloud-protocol.js';
import { downloadComfyCloudJob } from './qianmu-comfy-cloud-asset-read.js';
import { downloadRunningHubJob } from './qianmu-runninghub-download.js';
import { normalizeComfyCloudStage } from './qianmu-comfy-cloud-stage-contract.js';
import { readRunningHubUsage } from './qianmu-runninghub-usage.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';

const downloadCloudJob = (req, input, options) => input.task.provider === 'runninghub'
  ? downloadRunningHubJob(req, input, options) : downloadComfyCloudJob(req, input, options);
export function createComfyCloudReceiver({ ledger, cache, download = downloadCloudJob } = {}) {
  if (typeof ledger?.authorizeStaging !== 'function' || typeof download !== 'function'
    || ['load', 'reserve', 'save'].some(name => typeof cache?.[name] !== 'function')) throw new Error('云端领取服务缺少原任务或暂存接口');
  const active = new Set(); let admitted = 0;
  return Object.freeze({
    async acknowledge(req, input = {}, options = {}) {
      const task = bindComfyCloudTask(input.task, input.task?.taskId, input.task?.links), signal = options.signal;
      const account = imageServiceAccount(req);
      const fail = (code, message) => Object.assign(new Error(message), { code: `comfy_cloud_archive_${code}`, submissionState: 'accepted', upstreamId: task.taskId, retryable: false });
      const check = () => {
        if (signal?.aborted) throw fail('cancelled', '已停止归档处理，原记录仍保留');
        if (!imageServiceAccountStillMatches(req, account)) throw fail('account', 'ST账户已变化，未交付归档状态');
      };
      const { receipt, archived } = input;
      if (!['comfy-cloud', 'runninghub'].includes(task.provider) || archived !== true || typeof receipt !== 'string' || !/^[a-f0-9]{64}$/.test(receipt)) throw fail('confirmation', '请保存原图后使用原任务凭证确认归档');
      if (typeof cache.discard !== 'function') throw fail('storage', '原图暂存清理尚未就绪');
      if (admitted >= 2) throw fail('busy', '原任务正在处理，请稍后核查');
      admitted++;
      let key, owned = false;
      try {
        check();
        if (typeof ledger.authorizeArchive !== 'function') throw fail('authorization', '原任务缺少本地归档授权能力');
        const grant = await ledger.authorizeArchive(req, { channelKey: input.channelKey, attemptId: input.attemptId }, task);
        if (typeof grant?.recordArchived !== 'function') throw fail('authorization', '原任务缺少持久归档确认能力');
        const verify = async () => { check(); await grant.verify(); check(); };
        await verify();
        key = JSON.stringify([grant.identity.namespace, grant.identity.channelKey, grant.identity.attemptId]);
        if (active.has(key)) throw fail('busy', '原任务正在领取或归档，请稍后确认');
        active.add(key); owned = true;
        const delivery = await grant.recordArchived(cache, { receipt, archived, signal });
        await verify();
        const latest = await grant.readDelivery(); check();
        if (delivery?.state !== 'archived' || delivery.cacheReceipt !== receipt || latest?.state !== 'archived'
          || latest.cacheReceipt !== receipt) throw fail('confirmation', '原任务归档尚未确认，未清理暂存');
        let cleanup = 'complete';
        try {
          // No ledger IO inside cache.exclusive (it shares the host store queue).
          // A missing directory counts as clean ONLY after the durable exact ACK.
          await cache.discard(grant.identity, receipt, { valid: () => !signal?.aborted && imageServiceAccountStillMatches(req, account) });
        } catch (_) { cleanup = 'pending'; }
        await verify();
        return Object.freeze({ status: 'archived', task, result: null, delivery, cleanup,
          message: cleanup === 'complete' ? '已确认归档，暂存已清理' : '已确认归档，暂存清理待重试' });
      } catch (cause) {
        check();
        if (String(cause?.code).startsWith('comfy_cloud_archive_')) throw cause;
        throw fail('unconfirmed', '归档处理尚未确认，请核查原任务；未重新生成');
      } finally {
        if (owned) active.delete(key);
        admitted--;
      }
    },
    async receive(req, input = {}, options = {}) {
      const task = bindComfyCloudTask(input.task, input.task?.taskId, input.task?.links), signal = options.signal;
      const fail = (code, message) => Object.assign(new Error(message), { code: `comfy_cloud_receive_${code}`, submissionState: 'accepted', upstreamId: task.taskId, retryable: false });
      if (!['comfy-cloud', 'runninghub'].includes(task.provider)) throw fail('provider', '此平台的原图领取尚未就绪');
      if (admitted >= 2) throw fail('busy', '原图正在领取，请稍后核查');
      admitted++;
      let key, owned = false, stage = 'authorization';
      const check = () => { if (signal?.aborted) throw fail('cancelled', '已停止领取，原任务和暂存仍保留'); };
      try {
        check();
        const locator = { channelKey: input.channelKey, attemptId: input.attemptId, apiKey: input.apiKey };
        const grant = await ledger.authorizeStaging(req, locator, task);
        if (typeof grant?.readDelivery !== 'function' || typeof grant?.recordStored !== 'function') throw fail('authorization', '原任务缺少持久领取确认能力');
        const verify = async () => { check(); const receipt = await grant.verify(); check(); return receipt; };
        await verify();
        key = JSON.stringify([grant.identity.namespace, grant.identity.channelKey, grant.identity.attemptId]);
        if (active.has(key)) return Object.freeze({ status: 'collecting', task, result: null });
        active.add(key); owned = true;
        const read = async () => {
          await verify();
          const delivery = await grant.readDelivery(); await verify();
          if (delivery?.state === 'archived') return Object.freeze({ status: 'archived', task, result: null });
          const meta = await cache.load(grant.identity, { metadataOnly: true });
          await verify();
          if (!meta?.ready) {
            if (delivery) throw fail('readback', '原任务已确认暂存但原图缺失，请核查；未重新下载');
            return null;
          }
          // recordStored performs the full read/hash check and returns those
          // bytes, so the receiver does not hold two full readback copies.
          const confirmed = await grant.recordStored(cache, { signal }); await verify();
          if (confirmed.delivery.state === 'archived') return Object.freeze({ status: 'archived', task, result: null });
          return Object.freeze({ status: 'staged', task, grant, result: confirmed.result, delivery: confirmed.delivery });
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
            const networkGrant = Object.freeze({ ...grant, verify: async () => {
              const receipt = await verify();
              if (await grant.readDelivery()) throw fail('result_changed', '原任务已有保存记录，请重新领取；未继续下载');
              check(); return receipt;
            } });
            const downloaded = await download(req, { task, ...locator }, { ...options, signal,
              ledger: { authorizeStaging: async () => { await networkGrant.verify(); return networkGrant; } } });
            await networkGrant.verify();
            if (downloaded.status !== 'integrity_checked') {
              if (!['queued', 'running', 'canceling', 'canceled', 'failed', 'expired'].includes(downloaded.status) || downloaded.result !== null) throw fail('download', '原任务收图状态不完整，未交付');
              const usage=task.provider==='runninghub'&&downloaded.status==='failed'?readRunningHubUsage(downloaded.usage):null;
              return Object.freeze({ status: downloaded.status, task, result: null, ...(usage?{usage}:{}) });
            }
            if (downloaded.grant !== networkGrant || JSON.stringify(downloaded.task) !== JSON.stringify(task)) throw fail('download', '原图未沿用原任务授权，未暂存');
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
        const latest = await grant.readDelivery(); check();
        if (latest?.state === 'archived') return Object.freeze({ status: 'archived', task, result: null });
        if (result.status === 'staged' && latest?.cacheReceipt !== result.result.receipt) throw fail('readback', '原图保存凭证已变化，未交付');
        return result;
      } catch (cause) {
        if (signal?.aborted) throw fail('cancelled', '已停止领取，原任务和暂存仍保留');
        if (String(cause?.code).startsWith('comfy_cloud_receive_')) throw cause;
        throw fail(stage, stage === 'download' && ['comfy_cloud_asset_read_', 'runninghub_download_'].some(prefix => String(cause?.code).startsWith(prefix)) ? cause.message
          : '原图领取尚未确认，请核查原任务；未重新生成或清理暂存');
      } finally {
        if (owned) active.delete(key);
        admitted--;
      }
    },
  });
}
