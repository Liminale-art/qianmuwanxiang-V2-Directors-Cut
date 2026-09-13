// Comfy delivery and single cloud acceptance; no scheduler or reference upload.
import { trackClientActivity } from './qianmu-client-activity.js';
import { prepareComfySubmission, assertComfyAccount, acknowledgeComfyImage } from './qianmu-comfy-submission.js';
import { requireComfyCloudImageSubmission, canSubmitComfyCloudImages } from './qianmu-comfy-cloud-protocol.js';
import { resolveImageAccountNamespace } from './qianmu-image-admission.js';
import { imageChannelKey } from './qianmu-image-channel.js';
import { createComfyDeliveryStore, normalizeComfyDelivery, assertComfyDeliveryUpdate } from './qianmu-comfy-delivery-store.js';
import { bindComfyCloudTask, bindComfyCloudProtocol } from './qianmu-comfy-cloud-protocol.js';
import { buildComfyCloudRequest } from './qianmu-comfy-cloud-request.js';
import { executeComfyCloudJob } from './qianmu-comfy-cloud-execution.js';
import { runningHubUsageFields } from './qianmu-runninghub-usage.js';

const fail = (code, message) => Object.assign(new Error(message), { code: `comfy_delivery_${code}`, submissionState: 'accepted', retryable: false });
const BASE = '/api/plugins/qianmu-tts/image/comfy/tasks';
const CLOUD_BASE = '/api/plugins/qianmu-tts/image/comfy/cloud/tasks';
const supportedCloudOriginal = task => ['comfy-cloud', 'runninghub'].includes(task?.provider);
function assertCloudPacket(row, data) {
  let task; try { task = bindComfyCloudTask(data?.task, data?.task?.taskId, data?.task?.links); } catch (_) { /* Report only the original-task mismatch. */ }
  if (data?.version !== 1 || !task || JSON.stringify(task) !== JSON.stringify(row.cloudTask)) throw fail('identity', '云结果不属于原任务，未归档或清理');
}
const identity = job => ({ id: job?.id, source: job?.source, logId: job?.logId, chatKey: job?.chatKey, automatic: job?.automatic,
  originalOnly: job?.originalOnly === true, comfyTaskLocator: job?.comfyTaskLocator ? { version: job.comfyTaskLocator.version, channelKey: job.comfyTaskLocator.channelKey } : undefined,
  imageAdmission: { version: job?.imageAdmission?.version, namespace: job?.imageAdmission?.namespace, attemptId: job?.imageAdmission?.attemptId },
  connection: { baseUrl: job?.connection?.baseUrl, credentialId: job?.connection?.credentialId, allowPrivateNetwork: job?.connection?.allowPrivateNetwork } });
export function createComfyRecoveryClient({ account = resolveImageAccountNamespace, store = createComfyDeliveryStore(),
  locks = globalThis.navigator?.locks, origin = globalThis.location?.origin, fetchImpl = globalThis.fetch,
  headers = () => ({}), confirm = async () => false, timeoutMs = 45000 } = {}) {
  let closed = false;
  const controllers = new Set();
  const submissionTickets = new WeakMap();
  const cancelling = new Set();
  async function guard(job) {
    if (closed) throw fail('closed', 'Comfy 领取会话已结束，请在原账户重新领取');
    await assertComfyAccount(job, { account });
    if (closed) throw fail('closed', 'Comfy 领取会话已结束，请在原账户重新领取');
  }
  async function locked(job, work, { wait = false } = {}) {
    await guard(job);
    if (typeof locks?.request !== 'function') throw fail('lock', '当前浏览器无法保护跨页归档，请使用支持页面锁的 HTTPS 浏览器');
    // All Comfy deliveries for this account serialize their metadata writes.
    // Different accounts do not share either a lock or a journal namespace.
    const key = await imageChannelKey(job.imageAdmission.namespace);
    const controller = wait ? new AbortController() : null;
    if (controller) controllers.add(controller);
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
    try {
      return await locks.request(`qianmu-comfy-delivery:${key}`, { mode: 'exclusive', ...(controller ? { signal: controller.signal } : { ifAvailable: true }) }, async lock => {
        if (!lock) throw fail('busy', '另一个 Comfy 任务正在归档，请稍后领取');
        if (timer) clearTimeout(timer); if (controller) controllers.delete(controller);
        await guard(job); return work();
      });
    } catch (error) {
      if (controller?.signal.aborted && error?.name === 'AbortError') throw fail('busy', 'Comfy 归档等待已停止，原图保留，可稍后领取');
      throw error;
    } finally { if (timer) clearTimeout(timer); if (controller) controllers.delete(controller); }
  }
  const fresh = job => normalizeComfyDelivery({ version: job.originalOnly ? 2 : 1, ...(job.originalOnly ? { originalOnly: true, taskLocator: job.comfyTaskLocator } : {}), namespace: job.imageAdmission.namespace, attemptId: job.id,
    baseUrl: job.connection?.baseUrl, credentialId: job.connection?.credentialId || '', allowPrivateNetwork: job.connection?.allowPrivateNetwork === true,
    chatKey: job.chatKey || '', logId: job.logId || '', automatic: Boolean(job.automatic), createdAt: Date.now(), status: 'prepared', receipt: '', imageCount: 0, files: [] }, origin);
  async function remember(job) {
    const expected = fresh(job), existing = await store.get(expected.namespace, expected.attemptId); await guard(job);
    if (existing) {
      const row = normalizeComfyDelivery(existing, origin);
      if (['namespace','attemptId','baseUrl','credentialId','allowPrivateNetwork','chatKey'].some(key => row[key] !== expected[key])) throw fail('identity', '原 Comfy 连接或任务已变化，请使用原日志领取');
      if (row.version !== expected.version || (row.version === 2 && row.taskLocator.channelKey !== expected.taskLocator.channelKey)) throw fail('identity', '原 Comfy 配方模式或任务定位已变化');
      return row;
    }
    await store.put(expected); await guard(job); return expected;
  }
  async function save(job, row) { await guard(job); const clean = normalizeComfyDelivery(row, origin); await store.put(clean); await guard(job); return clean; }
  async function request(job, action, body, maxBytes, base = BASE, isCurrent = () => true) {
    const submitting = action === 'submit' && base === CLOUD_BASE;
    let dispatched = false, reportedState;
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.min(60000, Math.max(1000, Number(timeoutMs) || 45000)));
    try {
      await guard(job);
      if (!isCurrent()) throw fail('page', '收片页面已变化，未发送请求');
      const init = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { ...headers(), 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(body) };
      dispatched = true;
      const response = await fetchImpl(`${base}/${action}`, init);
      if (response.status === 404 && action === 'capabilities') { await response.body?.cancel().catch(() => {}); throw fail('capabilities', '后端尚未支持云任务，请同步更新后端并重启 ST'); }
      if (response.status === 404 && action === 'catalog') { await response.body?.cancel().catch(() => {}); throw fail('catalog', 'Comfy 目录尚未就绪，请同步更新后端并重启 ST'); }
      const reader = response.body?.getReader(); if (!reader) throw fail('response', 'Comfy 服务未返回领取结果');
      const chunks = []; let size = 0;
      try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maxBytes) throw fail('size', 'Comfy 领取结果超限，服务器原图未清理'); chunks.push(item.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      let result;
      try { result = JSON.parse(new TextDecoder().decode(buffer)); } catch (_) { throw fail('response', 'Comfy 服务返回格式异常，未重新生成'); }
      if (submitting && result?.ok === false && ['not_submitted','unknown','accepted'].includes(result.submissionState)) reportedState = result.submissionState;
      await guard(job);
      if (!response.ok || result?.ok !== true) throw fail('response', typeof result?.message === 'string' ? result.message.slice(0, 300) : `Comfy 领取暂不可用（${response.status}）`);
      return result;
    } catch (error) {
      if (submitting) {
        const safe = /^(?:comfy_|image_)/.test(error?.code || '') ? error : fail('network', '云任务提交连接中断，请核查原任务，未重新提交');
        safe.submissionState = reportedState || (dispatched ? 'unknown' : 'not_submitted');
        throw safe;
      }
      if (/^(?:comfy_|image_)/.test(error?.code || '')) throw error;
      throw fail('network', 'Comfy 领取连接中断，原任务未重投，请稍后再试');
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  async function acknowledge(job, row) {
    if (row.status === 'confirmed') return { archived: true, alreadyArchived: true, warning: '' };
    await guard(job);
    if (!row.receipt) return { archived: true, warning: '原图已归档；服务器暂存状态尚待核查' };
    if (row.version === 3) {
      try {
        const current = await scope(row.namespace);
        const data = await request(job, 'acknowledge', { ...current.body, attemptId: row.attemptId, channelKey: row.taskLocator.channelKey,
          task: row.cloudTask, receipt: row.receipt, archived: true }, 16384, CLOUD_BASE);
        assertCloudPacket(row, data);
        if (data.status !== 'archived' || data.delivery?.state !== 'archived' || data.delivery.cacheReceipt !== row.receipt
          || data.delivery.imageCount !== row.imageCount || !['complete','pending'].includes(data.cleanup)) throw fail('confirmation', '云归档确认尚不完整');
        if (data.cleanup === 'pending') return { archived: true, warning: '原图已归档；临时文件尚未清理完，可稍后继续' };
        await save(job, { ...row, status: 'confirmed' });
        return { archived: true, warning: '' };
      } catch (_) {
        await guard(job);
        return { archived: true, warning: '原图已归档；服务器确认尚未完成，可稍后继续' };
      }
    }
    const warning = await acknowledgeComfyImage(job, { comfyTask: { resultStored: true, receipt: row.receipt, attemptId: row.attemptId } },
      { account: async () => { await guard(job); return job.imageAdmission.namespace; }, fetchImpl, headers });
    await guard(job);
    if (!warning) await save(job, { ...row, status: 'confirmed' });
    return { archived: true, warning };
  }
  async function scope(expectedNamespace) {
    const namespace = await account();
    if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || (expectedNamespace && expectedNamespace !== namespace)) throw fail('account', 'ST 账户已变化，请重新读取目录');
    const job = { imageAdmission: { namespace } }, expectedAccount = `st-user:${await imageChannelKey(namespace.slice(8))}`;
    await guard(job); return { namespace, job, body: { version: 1, expectedAccount } };
  }
  const locator = value => {
    if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.channelKey || '')) throw fail('locator', '原 Comfy 任务定位无效，请刷新目录');
    return { version: 1, channelKey: value.channelKey };
  };
  const jobForRow = row => ({ id: row.attemptId, source: 'comfy', chatKey: row.chatKey, automatic: row.automatic,
    originalOnly: row.originalOnly === true, comfyTaskLocator: row.taskLocator, target: 'gallery', inlineByDefault: false, recoveringOriginal: true,
    imageAdmission: { version: 1, namespace: row.namespace, attemptId: row.attemptId },
    connection: { baseUrl: row.baseUrl, credentialId: row.credentialId, allowPrivateNetwork: row.allowPrivateNetwork }, profile: { model: '' }, prompt: '', negative: '', payload: {} });
  async function archive(job, row, data, deliver) {
    if (['archived','confirmed'].includes(row.status)) return acknowledge(job, row);
    const count = data.images?.length, task = row.version === 3
      ? { version: 1, attemptId: row.attemptId, resultStored: true, receipt: data.receipt } : data.comfyTask;
    if (!Number.isInteger(count) || count < 1 || count > 8 || task?.version !== 1 || task.attemptId !== row.attemptId
      || (task.resultStored && !/^[a-f0-9]{64}$/.test(task.receipt || ''))
      || (row.imageCount && row.imageCount !== count) || (row.receipt && row.receipt !== task.receipt)) throw fail('identity', 'Comfy 原结果与领取记录不符，未清理暂存');
    row = await save(job, { ...row, status: 'available', imageCount: count, receipt: task.resultStored ? task.receipt : row.receipt });
    const archived = await deliver(data, row.files, async records => {
      if (!Array.isArray(records) || records.length < row.files.length || records.length > count) throw fail('checkpoint', 'Comfy 原图检查点不完整');
      const files = records.map((record, imageIndex) => ({ imageIndex, url: record.url }));
      if (row.files.some((file, index) => file.url !== files[index].url)) throw fail('checkpoint', 'Comfy 已归档文件不可改写');
      row = await save(job, { ...row, files });
    }, () => guard(job));
    await guard(job);
    if (archived !== true) return { archived: false, warning: '原图已保留，请回原聊天完成归档' };
    row = await save(job, { ...row, status: 'archived' });
    return acknowledge(job, row);
  }
  async function receiveCloud(item, { chatKey = '', apiKey = '', deliver } = {}, recipe) {
    // Recovery without a recipe and delivery with the original shot share IO,
    // but only the latter may attach a complete configuration or prose anchor.
    if (item?.version !== 3) throw fail('engine', '请选择原云任务记录');
    const selected = normalizeComfyDelivery(item, origin);
    if (!supportedCloudOriginal(selected.cloudTask)) throw fail('engine', '此任务的云原图领取尚未就绪');
    const checkRecipe = row => {
      if (!recipe) return;
      const expected = identity(recipe);
      if (row.originalOnly || expected.originalOnly || expected.source !== 'comfy' || expected.id !== row.attemptId
        || !recipe.payload?.parameters?.workflow || typeof recipe.payload?.prompt !== 'string' || !recipe.payload.prompt.trim()
        || !recipe.profile || typeof recipe.profile !== 'object'
        || expected.imageAdmission?.version !== 1 || expected.imageAdmission.attemptId !== row.attemptId || expected.imageAdmission.namespace !== row.namespace
        || (expected.chatKey || '') !== row.chatKey || (expected.logId || '') !== row.logId || Boolean(expected.automatic) !== row.automatic
        || (expected.connection.credentialId || '') !== row.credentialId
        || bindComfyCloudProtocol(expected.connection.baseUrl,row.cloudConnection.protocol).origin !== row.baseUrl)
        throw fail('identity','画面配置不完整或不属于原云任务，未替换原图的配置或插入位置');
    };
    checkRecipe(selected);
    const current = await scope(selected.namespace), originalJob = jobForRow(selected);
    return locked(originalJob, async () => {
      let row = await store.get(current.namespace, selected.attemptId); await guard(originalJob);
      if (row) {
        row = normalizeComfyDelivery(row, origin);
        if (row.version !== 3 || ['cloudTask','taskLocator','cloudConnection'].some(key => JSON.stringify(row[key]) !== JSON.stringify(selected[key]))) throw fail('identity', '本机与原云任务不匹配');
      } else {
        if (recipe) throw fail('identity','原云任务准备记录已缺失，请从收片管理找回原图');
        if (!await confirm('仅领取此云任务的原图到当前阅片室，不补造配方，也不会重新生成。继续领取？')) return { cancelled: true };
        await guard(originalJob);
        row = await save(originalJob, { ...selected, originalOnly: true, chatKey, status: 'prepared', receipt: '', imageCount: 0, files: [] });
      }
      checkRecipe(row);
      const job = recipe || { ...jobForRow(row), originalOnly: true };
      if (['archived','confirmed'].includes(row.status)) return acknowledge(job, row);
      if (!recipe && row.chatKey && row.chatKey !== chatKey) throw fail('chat', '请回原聊天继续保存图片，不覆盖已有归档位置');
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 2048) throw fail('credential', '请核对原云连接的 Key；不会重新生成');
      const data = await request(job, 'result', { ...current.body, attemptId: row.attemptId, channelKey: row.taskLocator.channelKey,
        task: row.cloudTask, apiKey }, 68 * 1024 * 1024, CLOUD_BASE);
      assertCloudPacket(row, data);
      if (data.status !== 'ready') return { archived: false, status: data.status,
        ...(data.status==='failed'?runningHubUsageFields({provider:row.cloudTask.provider,upstreamId:row.cloudTask.taskId,delivery:{usage:data.usage}}):{}),
        warning: ({ queued: '原任务仍在排队', running: '原任务仍在生成', collecting: '原图正在保存，请稍后领取',
        archived: '服务器已有归档记录，请先核查阅片室；未重复领取', failed: '原任务生成失败，未重新生成', canceled: '原任务已取消', expired: '原任务已过期，请核查平台记录' })[data.status] || '原图暂不可领取，未重新生成' };
      if (data.locator?.version !== 1 || data.locator.attemptId !== row.attemptId || data.locator.channelKey !== row.taskLocator.channelKey
        || data.delivery?.state !== 'stored' || data.delivery.cacheReceipt !== data.receipt || data.delivery.imageCount !== data.images?.length
        || data.provider !== row.cloudTask.provider || data.upstreamId !== row.cloudTask.taskId) throw fail('identity', '云原图与保存凭证不一致，未清理暂存');
      return archive(job, row, data, (...args) => deliver(job, ...args));
    });
  }
  const client = {
    runCloudJob(job,gateway,connection,options) { return executeComfyCloudJob(this,job,gateway,connection,options); },
    async cloudRecordFor(job) {
      job=identity(job);await prepareComfySubmission(job,{account});await guard(job);
      const raw=await store.get(job.imageAdmission.namespace,job.id);await guard(job);
      if(!raw)return null;
      const row=normalizeComfyDelivery(raw,origin);
      if(row.version!==3)throw fail('engine','此原记录不属于云任务，未切换请求渠道');
      return row;
    },
    async prepareCloudSubmission(job, gateway, connection) {
      // Freeze the graph and declared values before the first storage/account await.
      const request = buildComfyCloudRequest(job,gateway,connection);
      const prepared = await this.prepareCloud(job,request.connection);
      const result = { ...prepared, request };
      if (prepared.created) submissionTickets.set(result,{ record: normalizeComfyDelivery(prepared.record,origin), request, binding: { ...prepared.binding } });
      return result;
    },
    async submitCloudPrepared(prepared, apiKey, { beforeSubmit = async () => {}, valid = () => true } = {}) {
      // Consume before the first await. Reopening an existing journal row, copying
      // the object or overlapping clicks cannot mint a second submission ticket.
      const ticket = submissionTickets.get(prepared);
      submissionTickets.delete(prepared);
      let submissionState = 'not_submitted';
      try {
        if (!ticket) throw fail('ticket','此准备凭证已使用或无效，请核查原任务，未重新提交');
        if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096) throw fail('key','请填写原连接的 API Key');
        const { record, request: frozenRequest } = ticket, job = jobForRow(record);
        requireComfyCloudImageSubmission(record.cloudConnection,{automatic:record.automatic||ticket.request.execution?.automatic});
        const capabilities = await this.cloudCapabilities({namespace:record.namespace});
        if (!canSubmitComfyCloudImages(capabilities,record.cloudConnection.provider,record.cloudConnection) || !capabilities.resultRetrieval || !capabilities.resultProviders.includes(record.cloudConnection.provider))
          throw fail('capabilities','当前后端尚未开放此平台完整生图，请同步更新后再使用');
        await locked(job,async () => {
          const raw = await store.get(record.namespace,record.attemptId); await guard(job);
          if (!raw || JSON.stringify(normalizeComfyDelivery(raw,origin)) !== JSON.stringify(record))
            throw fail('identity','原云任务准备记录已变化，未提交新任务');
        });
        const current = await scope(record.namespace);
        if (!valid()) throw fail('cancelled','画面任务已停止，未提交云任务');
        await beforeSubmit();
        if (!valid()) throw fail('cancelled','画面任务已停止，未提交云任务');
        submissionState = 'unknown';
        const packet = await request(job,'submit',{...current.body,attemptId:record.attemptId,apiKey,request:frozenRequest},16384,CLOUD_BASE);
        const accepted = await this.bindCloudAcceptance(record,packet);
        return { binding: ticket.binding, record: accepted, task: accepted.cloudTask, taskLocator: accepted.taskLocator, submissionState:'accepted' };
      } catch (cause) {
        const error = /^(?:comfy_|image_)/.test(cause?.code || '') ? cause : fail('submission','云任务准备未完成，请核查原任务记录');
        error.submissionState = submissionState === 'not_submitted' ? submissionState : (cause?.submissionState || submissionState);
        throw error;
      }
    },
    async prepareCloud(job, cloudConnection) {
      job = identity(job);
      try {
        if (job.originalOnly) throw fail('identity', '领取原图不能转为新提交');
        const expected = normalizeComfyDelivery({ ...fresh(job), version: 3, cloudConnection, originalOnly: false, allowPrivateNetwork: false }, origin);
        const binding = await prepareComfySubmission(job, { account });
        return await locked(job, async () => {
          const raw = await store.get(expected.namespace,expected.attemptId); await guard(job);
          if (raw) {
            const row = normalizeComfyDelivery(raw,origin);
            if (row.version !== 3 || row.originalOnly || ['namespace','attemptId','baseUrl','credentialId','chatKey','automatic','logId'].some(key => row[key] !== expected[key])
              || JSON.stringify(row.cloudConnection) !== JSON.stringify(expected.cloudConnection)) throw fail('identity', '原准备记录与当前云任务不匹配');
            // An existing prepared row may already have been dispatched. It is
            // not permission to POST again merely because its reply was lost.
            return { binding, record: row, created: false };
          }
          const record = await save(job,expected); return { binding, record, created: true };
        });
      } catch (error) { error.submissionState = 'not_submitted'; throw error; }
    },
    async bindCloudAcceptance(prepared, packet) {
      const captured = normalizeComfyDelivery(prepared,origin);
      let task, target;
      try {
        if (captured.version !== 3 || captured.originalOnly || packet?.ok !== true || packet.version !== 1 || packet.status !== 'accepted'
          || packet.locator?.attemptId !== captured.attemptId) throw Error('invalid acceptance');
        task = bindComfyCloudTask(packet.task,packet.task?.taskId,packet.task?.links); target = locator(packet.locator);
        normalizeComfyDelivery({ ...captured, cloudTask: task, taskLocator: target },origin);
      } catch (_) { throw Object.assign(fail('acceptance','云任务受理记录尚未确认，请核查原任务，勿重复提交'),{submissionState:'unknown'}); }
      const job = jobForRow(captured);
      try { return await locked(job,async () => {
        const raw = await store.get(captured.namespace,captured.attemptId); await guard(job);
        if (!raw) throw fail('acceptance','本机准备记录已缺失，请从原任务目录核查；未重新提交');
        const row = normalizeComfyDelivery(raw,origin);
        if (row.version !== 3 || ['namespace','attemptId','baseUrl','credentialId','chatKey','automatic','logId','createdAt'].some(key => row[key] !== captured[key])
          || JSON.stringify(row.cloudConnection) !== JSON.stringify(captured.cloudConnection)) throw fail('identity','云任务准备身份已变化，未改写原记录');
        const next = normalizeComfyDelivery({ ...row, cloudTask: task, taskLocator: target },origin);
        assertComfyDeliveryUpdate(row,next);
        if (row.cloudTask) return row;
        return save(job,next);
      },{wait:true}); } catch (cause) {
        const error = /^(?:comfy_|image_)/.test(cause?.code || '') ? cause : fail('acceptance','平台已受理，本机记录未保存；请从原任务目录核查，勿重复提交');
        error.submissionState = 'accepted'; throw error;
      }
    },
    async cloudCapabilities({ namespace } = {}) {
      const current = await scope(namespace);
      const data = await request(current.job, 'capabilities', undefined, 16384, CLOUD_BASE.replace(/\/tasks$/, ''));
      if (data.expectedAccount !== current.body.expectedAccount) throw fail('account', '后端账户与当前 ST 不一致，请重新连接');
      const flags = ['submission','cancellation','referenceUpload','resultRetrieval','archiveConfirmation','automaticReplay'];
      const providers = value => Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length && value.every(item => ['comfy-cloud','runninghub'].includes(item));
      if (data.version !== 1 || data.accountBindingVersion !== 1 || data.catalogVersion !== 1 || flags.some(key => typeof data[key] !== 'boolean')
        || (Object.hasOwn(data,'deploymentSubmission') && typeof data.deploymentSubmission!=='boolean')
        || !providers(data.queryProviders) || !providers(data.resultProviders)
        || (Object.hasOwn(data,'submissionProviders') && !providers(data.submissionProviders))) throw fail('capabilities', '后端版本与当前千幕不匹配，请同步更新并重启 ST');
      return { version: 1, namespace: current.namespace, deploymentSubmission:data.deploymentSubmission===true, ...Object.fromEntries(flags.map(key => [key,data[key]])),
        queryProviders: [...data.queryProviders], resultProviders: [...data.resultProviders],
        submissionProviders: [...(data.submissionProviders ?? (data.submission ? ['comfy-cloud'] : []))] };
    },
    async cloudCatalog({ cursor = null, namespace } = {}) {
      const current = await scope(namespace);
      const data = await request(current.job, 'catalog', { ...current.body, cursor, limit: 40 }, 1024 * 1024, CLOUD_BASE);
      if (data.catalogVersion !== 1 || typeof data.storageReadable !== 'boolean' || !Array.isArray(data.originals) || data.originals.length > 128
        || !Array.isArray(data.tasks) || data.tasks.length > 50) throw fail('catalog', '云任务目录尚未就绪，请核对后端版本');
      const clean = row => {
        if (!/^[a-zA-Z0-9_-]{1,240}$/.test(row?.attemptId || '')) throw fail('catalog', '云任务目录编号无效');
        const task = row.task ? bindComfyCloudTask(row.task, row.task.taskId, row.task.links) : null;
        const cloudRecord = task ? normalizeComfyDelivery({ version: 3, namespace: current.namespace, attemptId: row.attemptId, originalOnly: true,
          cloudConnection: bindComfyCloudProtocol(task.origin, task.protocol), cloudTask: task, taskLocator: locator(row.taskLocator),
          createdAt: row.createdAt, status: 'prepared', imageCount: 0, files: [] }, origin) : null;
        return { ...row, namespace: current.namespace, engine: 'cloud', taskLocator: locator(row.taskLocator), task,
          cloudRecord,
          resultAvailable: row.resultAvailable === true && supportedCloudOriginal(task),
          canReceiveOriginal: supportedCloudOriginal(task) && !row.live && row.archiveState !== 'archived',
          canRetryCleanup: row.canRetryCleanup === true && row.archiveState === 'archived' && supportedCloudOriginal(task), canDiscard: false };
      };
      return { ...data, namespace: current.namespace, originals: data.originals.map(clean), tasks: data.tasks.map(clean) };
    },
    async catalogAll({ cloudCursor = null, namespace } = {}) {
      const current = await scope(namespace);
      const readCloud = async () => {
        const capabilities = await this.cloudCapabilities({ namespace: current.namespace });
        const data = await this.cloudCatalog({ cursor: cloudCursor, namespace: current.namespace });
        const available = row => capabilities.resultRetrieval && capabilities.resultProviders.includes(row.task?.provider);
        const adapt = row => ({ ...row, resultAvailable: row.resultAvailable && available(row), canReceiveOriginal: row.canReceiveOriginal && available(row),
          canRetryCleanup: row.canRetryCleanup && capabilities.archiveConfirmation });
        return { ...data, originals: data.originals.map(adapt), tasks: data.tasks.map(adapt), capabilities };
      };
      const results = await Promise.allSettled([this.catalog({ namespace: current.namespace }), readCloud()]);
      await guard(current.job);
      if (results.every(item => item.status === 'rejected')) throw fail('catalog', '暂存目录暂不可读取，请核对后端连接');
      const native = results[0].status === 'fulfilled' ? results[0].value : null, cloud = results[1].status === 'fulfilled' ? results[1].value : null;
      const warnings = results.map((item,index) => item.status === 'rejected' ? item.reason?.code === 'comfy_delivery_capabilities' ? item.reason.message
        : `${index ? '云端' : '本地 Comfy'}暂存目录暂不可读取` : item.value.warning || '').filter(Boolean);
      const originals = [...(native?.originals || []), ...(cloud?.originals || [])];
      // Accepted originals must be discoverable before the first result is
      // cached. This exposes a read/collect action, not another paid submission.
      // Unreadable storage can still offer archive-only cleanup from ledger proof.
      const cloudKeys = new Set((cloud?.originals || []).map(row => JSON.stringify([row.taskLocator.channelKey,row.attemptId])));
      for (const row of cloud?.tasks || []) {
        const key = JSON.stringify([row.taskLocator.channelKey,row.attemptId]);
        if (!cloudKeys.has(key) && (row.canReceiveOriginal || row.usage || cloud.storageReadable === false && row.canRetryCleanup)) { originals.push(row); cloudKeys.add(key); }
      }
      const storageReadable = Boolean(native && cloud && cloud.storageReadable);
      const total = name => storageReadable && [native,cloud].every(item => Number.isSafeInteger(item.totals?.[name]) && item.totals[name] >= 0)
        ? native.totals[name] + cloud.totals[name] : null;
      return { catalogVersion: 1, namespace: current.namespace, storageReadable, originals, tasks: [...(native?.tasks || []), ...(cloud?.tasks || [])],
        cloudNextCursor: cloud ? cloud.nextCursor || null : cloudCursor,
        cloudCapabilities: cloud?.capabilities || null,
        totals: Object.fromEntries(['count','imageBytes','metadataBytes','temporaryBytes','reservedBytes','tasks'].map(name => [name,total(name)])), warning: warnings.join('；') };
    },
    async retryCloudCleanup(item) {
      if (item?.engine !== 'cloud' || item.canRetryCleanup !== true || item.archiveState !== 'archived'
        || !/^[a-f0-9]{64}$/.test(item.cacheReceipt || '') || !/^[a-zA-Z0-9_-]{1,240}$/.test(item.attemptId || '')) throw fail('confirmation', '请刷新已归档任务后再清理');
      const selected = { attemptId: item.attemptId, task: bindComfyCloudTask(item.task, item.task?.taskId, item.task?.links),
        channelKey: locator(item.taskLocator).channelKey, receipt: item.cacheReceipt, namespace: item.namespace };
      if (!supportedCloudOriginal(selected.task)) throw fail('engine', '此云平台的临时文件清理尚未就绪');
      const current = await scope(selected.namespace);
      return locked(current.job, async () => {
        const { namespace: _namespace, ...body } = selected;
        const data = await request(current.job, 'acknowledge', { ...current.body, ...body, archived: true }, 16384, CLOUD_BASE);
        assertCloudPacket({ cloudTask: selected.task }, data);
        if (data.status !== 'archived' || data.delivery?.state !== 'archived' || data.delivery.cacheReceipt !== selected.receipt
          || !['complete','pending'].includes(data.cleanup)) throw fail('confirmation', '服务器归档凭证尚未确认，未清理本机记录');
        return { archived: true, warning: data.cleanup === 'pending' ? '原图已归档；临时文件尚未清理完，可稍后继续' : '' };
      });
    },
    retrieveCloudOriginal(item, options) { return receiveCloud(item,options); },
    retrieveCloudJob(job, item, options) {
      if (!job || typeof job !== 'object') throw fail('identity','缺少原画面配置，请使用收片管理找回原图');
      return receiveCloud(item,options,structuredClone(job));
    },
    async usage() {
      const current = await scope(), usage = await store.usage(current.namespace); await guard(current.job);
      return { ...usage, namespace: current.namespace };
    },
    async list() {
      const current = await scope(), rows = await store.list(current.namespace); await guard(current.job);
      const clean = rows.map(row => normalizeComfyDelivery(row, origin));
      return { namespace: current.namespace, rows: clean, bytes: new TextEncoder().encode(clean.map(row => JSON.stringify(row)).join('')).length, limit: 2048, byteLimit: 16 * 1024 * 1024 };
    },
    async catalog({ cursor = null, namespace } = {}) {
      const current = await scope(namespace);
      const data = await request(current.job, 'catalog', { ...current.body, cursor, limit: 40 }, 1024 * 1024);
      if (data.catalogVersion !== 1 || !Array.isArray(data.originals) || data.originals.length > 128 || !Array.isArray(data.tasks) || data.tasks.length > 50) throw fail('catalog', 'Comfy 目录尚未就绪，请同步更新后端并重启 ST');
      const rows = items => items.map(row => {
        if (!/^[a-zA-Z0-9_-]{1,240}$/.test(row?.attemptId || '')) throw fail('catalog', 'Comfy 目录任务编号无效');
        return { ...row, namespace: current.namespace, taskLocator: locator(row.taskLocator) };
      });
      return { ...data, namespace: current.namespace, originals: rows(data.originals), tasks: rows(data.tasks) };
    },
    async removeLocal(items) {
      if (!Array.isArray(items) || !items.length || items.length > 20) throw fail('selection', '每次请选择 1～20 条本机记录');
      const selected = items.map(row => normalizeComfyDelivery(row, origin)), current = await scope(selected[0].namespace);
      if (selected.some(row => row.namespace !== current.namespace) || new Set(selected.map(row => row.attemptId)).size !== selected.length) throw fail('selection', '本机记录选择无效');
      if (!await confirm(`删除选中的 ${selected.length} 条本机领取记录？不会删除阅片室图片、服务器原图或防重复账本。未完成的领取进度会丢失，进行中的任务不会停止，记录可能再次出现。`)) return { cancelled: true };
      return locked(current.job, async () => {
        let removed = 0; const errors = [];
        for (const row of selected) { await guard(current.job); try { if (await store.remove(row)) removed++; } catch (error) { errors.push(error.message); } }
        await guard(current.job); return { removed, errors };
      });
    },
    async discard(items) {
      if (!Array.isArray(items) || !items.length || items.length > 20) throw fail('selection', '每次请选择 1～20 项服务器暂存');
      const selected = items.map(row => ({ namespace: row.namespace, attemptId: row.attemptId, taskLocator: locator(row.taskLocator), receipt: row.cacheReceipt }));
      const current = await scope(selected[0].namespace);
      if (selected.some(row => row.namespace !== current.namespace || !/^[a-zA-Z0-9_-]{1,240}$/.test(row.attemptId || '') || !/^[a-f0-9]{64}$/.test(row.receipt || ''))
        || new Set(selected.map(row => JSON.stringify([row.taskLocator.channelKey,row.attemptId]))).size !== selected.length) throw fail('selection', '服务器暂存选择无效');
      if (!await confirm(`删除选中的 ${selected.length} 项 Comfy 服务器暂存？尚未领取的原图可能无法恢复。阅片室图片不删除，任务不会取消，防重复账本不会解除。`)) return { cancelled: true };
      return locked(current.job, async () => {
        let removed = 0, bytes = 0; const errors = [];
        for (const row of selected) { await guard(current.job); try {
          const data = await request(current.job, 'discard', { ...current.body, attemptId: row.attemptId, taskLocator: row.taskLocator, receipt: row.receipt, confirmed: true }, 16384);
          removed++; bytes += Math.max(0, Number(data.bytes) || 0);
        } catch (error) { errors.push(error.message); } }
        await guard(current.job); return { removed, bytes, errors };
      });
    },
    async cancelCloudOriginal(item, { apiKey = '', valid = () => true } = {}) {
      const current = await scope(item?.namespace);
      const row = normalizeComfyDelivery(item?.cloudRecord || item, origin);
      if (row.version !== 3 || !row.cloudTask || row.namespace !== current.namespace || item?.attemptId !== row.attemptId)
        throw fail('identity', '请选择原云任务，未发送取消请求');
      const key = JSON.stringify([row.namespace,row.taskLocator.channelKey,row.attemptId]);
      if (cancelling.has(key)) throw fail('busy', '原任务正在处理取消，请稍后核查');
      const check = async () => { await guard(current.job); if (!valid()) throw fail('page', '收片页面已变化，请重新打开'); };
      cancelling.add(key);
      try {
        await check();
        if (['archived','confirmed'].includes(row.status)) return { warning: '原图已归档并保留，无需取消' };
        if (!await confirm('取消此原任务？已产生的消耗以平台账单为准，已生成的图片保留；不会重新生成。')) return { cancelled: true };
        await check();
        const capability = await this.cloudCapabilities({ namespace: row.namespace }); await check();
        if (!capability.cancellation) throw fail('capabilities', '后端尚未支持取消，请同步更新并重启 ST');
        if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(apiKey)) throw fail('key', '请核对原连接的 Key');
        const data = await request(current.job, 'cancel', { ...current.body, attemptId: row.attemptId,
          channelKey: row.taskLocator.channelKey, task: row.cloudTask, apiKey, confirmed: true }, 65536, CLOUD_BASE, valid);
        await check(); assertCloudPacket(row, data);
        const terminal = ['succeeded','failed','canceled','expired','stored','archived'].includes(data.status);
        const pending = ['queued','running','canceling','cancel_requested'].includes(data.status);
        if ((!terminal && !pending) || data.terminal !== terminal || typeof data.requestAccepted !== 'boolean'
          || (['stored','archived'].includes(data.status) ? data.requestAccepted : !data.requestAccepted)
          || (data.status === 'cancel_requested' && row.cloudTask.provider !== 'runninghub')) throw fail('response', '取消状态尚未确认，请核查原任务');
        return { status: data.status, terminal, requestAccepted: data.requestAccepted, warning:
          ['succeeded','stored','archived'].includes(data.status) ? '任务已完成，原图保留，可继续领取' : data.status === 'canceled' ? '原任务已取消，已有图片和记录保留'
            : terminal ? '原任务已结束，已有图片和记录保留' : '已请求取消，是否停止请核查原任务；未重新生成' };
      } finally { cancelling.delete(key); }
    },
    async retrieveOriginal(item, { chatKey = '', apiKey = '', deliver } = {}) {
      if (item?.version === 3 || item?.engine === 'cloud') return this.retrieveCloudOriginal(item.cloudRecord || item, { chatKey, apiKey, deliver });
      const current = await scope(item?.namespace), attemptId = item?.attemptId;
      if (!/^[a-zA-Z0-9_-]{1,240}$/.test(attemptId || '')) throw fail('identity', '请选择原 Comfy 任务');
      let row = await store.get(current.namespace, attemptId); await guard(current.job);
      if (item?.version === 3 || row?.version === 3) throw fail('engine', '请使用原云任务领取入口，未切换至原生 Comfy');
      const body = { ...current.body, attemptId, ...(item.taskLocator ? { taskLocator: locator(item.taskLocator) } : {}), ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}) };
      const query = await request(current.job, 'query', body, 65536);
      if (!query.task || query.task.live) return { archived: false, warning: query.task ? '原 Comfy 任务仍在执行，请稍后领取' : '未找到原 Comfy 任务，未重新生成' };
      const target = locator(query.task.taskLocator);
      if (row) {
        row = normalizeComfyDelivery(row, origin);
        if (row.chatKey && row.chatKey !== chatKey) throw fail('chat', '本机记录属于另一聊天，请回原聊天领取；不要覆盖已有归档位置');
        // Verify any old root against the server locator, not a guessed hash.
        if (row.baseUrl) await request(current.job, 'query', { ...current.body, attemptId, taskLocator: target, baseUrl: row.baseUrl }, 65536);
        if (row.version === 2 && row.taskLocator.channelKey !== target.channelKey) throw fail('identity', '本机与服务器任务不匹配');
      }
      if (!row?.originalOnly && !await confirm('原配方未保留。仅将原图存入当前阅片室，不补造提示词、角色或工作流，也不会重新生成。继续领取？')) return { cancelled: true };
      row = normalizeComfyDelivery({ ...(row || { namespace: current.namespace, attemptId, baseUrl: '', credentialId: '', chatKey, automatic: false,
        createdAt: Date.now(), status: 'prepared', receipt: '', imageCount: 0, files: [] }), version: 2, originalOnly: true, taskLocator: target }, origin);
      const originalJob = jobForRow(row);
      await locked(originalJob, async () => { await save(originalJob, row); });
      return this.retrieve(originalJob, { apiKey, deliver: (...args) => deliver(originalJob, ...args) });
    },
    async prepare(job) {
      // Called before provider submission. If local safety prerequisites fail,
      // no paid upstream request may have been made by this method.
      job = identity(job);
      try {
        const binding = await prepareComfySubmission(job, { account });
        if (typeof locks?.request !== 'function') throw fail('lock', '当前浏览器无法保护跨页归档，请使用支持页面锁的 HTTPS 浏览器');
        // IDB already serializes bounded journal writes; preparation must not
        // fail merely because a different completed image is being archived.
        await remember(job); return binding;
      }
      catch (error) { error.submissionState = 'not_submitted'; throw error; }
    },
    deliver(job, data, callback) { job = identity(job); return locked(job, async () => archive(job, await remember(job), data, callback), { wait: true }); },
    retrieve(job, { apiKey = '', deliver } = {}) {
      job = identity(job);
      return locked(job, async () => {
        const binding = await prepareComfySubmission(job, { account });
        const row = await remember(job);
        if (['archived','confirmed'].includes(row.status)) return acknowledge(job, row);
        const taskLocator = row.taskLocator || job.comfyTaskLocator;
        const body = { ...binding, baseUrl: row.baseUrl, ...(taskLocator ? { taskLocator: locator(taskLocator) } : {}) };
        const query = await request(job, 'query', body, 64 * 1024);
        if (!query.task) return { archived: false, warning: '未找到原账户的 Comfy 任务记录，未重新生成' };
        if (query.task.live) return { archived: false, warning: '原 Comfy 任务仍在收片，请稍后领取' };
        if (!query.task.resultStored && (typeof apiKey !== 'string' || apiKey.length > 2048)) throw fail('credential', 'Comfy 原连接凭据无效，请核对原连接');
        // Cached ST results do not need the upstream credential or its network.
        const data = await request(job, 'result', { ...body, allowPrivateNetwork: row.allowPrivateNetwork,
          ...(!query.task.resultStored && apiKey ? { apiKey } : {}) }, 68 * 1024 * 1024);
        if (data.status !== 'ready') return { archived: false, warning: ({ queued: '原 Comfy 任务仍在排队', running: '原 Comfy 任务仍在生成', collecting: '原 Comfy 任务仍在收片', unavailable: '原任务历史暂不可读，请核查 Comfy；未重新生成' })[data.status] || '原图暂不可领取，未重新生成' };
        return archive(job, row, data, deliver);
      });
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); store.close(); },
  };
  return trackClientActivity(client);
}
