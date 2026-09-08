import { validStoryboardConnectionReview } from './qianmu-storyboard-connection-identity.js';
import { validStoryboardResourceOriginsPage, validStoryboardResourceOriginsSummary } from './qianmu-storyboard-resource-origins.js';
import { validStoryboardEnvironmentReview } from './qianmu-storyboard-environment-map.js';
let active = null;
const fail = message => Object.assign(new Error(message), { code: 'storyboard_bundle_restore_runtime', submissionState: 'not_submitted' });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
function validView(value, namespace) {
  return value?.namespace === namespace && hash(value.chatHash) && typeof value.ready === 'boolean' && (value.ready ? hash(value.planDigest) : value.planDigest === '' || hash(value.planDigest))
    && Array.isArray(value.conflicts) && value.conflicts.length <= 2560 && value.conflicts.every(row => typeof row.key === 'string' && ['archive','binding'].includes(row.kind) && (row.kind === 'archive' || typeof row.category === 'string'))
    && Array.isArray(value.bindingReview) && value.bindingReview.length <= 2048 && value.bindingReview.every(row => typeof row.category === 'string' && typeof row.subjectKey === 'string')
    && (value.subjectReview === undefined || Array.isArray(value.subjectReview) && value.subjectReview.length <= 2080 && value.subjectReview.every(row => ['char','user','other'].includes(row.category) && typeof row.subjectKey === 'string' && row.subjectKey.length <= 1024 && typeof row.required === 'boolean' && ['matched','changed','missing','unverified'].includes(row.state)))
    && (value.configuration?.connections === undefined || validStoryboardConnectionReview(value.configuration.connections))
    && (value.summary?.resourceOrigins === undefined || validStoryboardResourceOriginsSummary(value.summary.resourceOrigins))
    && (value.environmentReview == null || validStoryboardEnvironmentReview(value.environmentReview) && value.environmentReview.namespace === namespace && value.environmentReview.sourceDigest === value.sourceDigest && value.environmentReview.chatHash === value.chatHash && value.sourceLabelsMatched === (value.environmentReview.state === 'matched'))
    && Array.isArray(value.images) && value.images.length <= 30400 && value.images.every(row => typeof row.url === 'string' && ['missing','present','conflict'].includes(row.state))
    && ['added','replaced','kept'].every(key => count(value.characterSummary?.[key])) && count(value.summary?.images) && count(value.summary?.vibeFiles)
    && ['workflows','pools','characters'].every(key => count(value.summary?.[key]?.count)) && count(value.summary?.workflows?.versions);
}
const interrupted = () => fail('恢复会话已中断；部分原件或配置可能已保存。请先核对导入记录，再选择原包重新确认，不会自动重传。');
export function closeStoryboardBundleRestoreRuntime() { active?.close(); }

// A single live worker owns the immutable source and all heavy library operations. No synchronous fallback.
// Every RPC is bound to the session, operation and source; only an explicit restore can reach configuration.apply.
export async function openStoryboardBundleRestoreRuntime(file, { namespace, chatKey, guard, configuration, headers = () => ({}), signal,
  WorkerClass = globalThis.Worker, timeoutMs = 180000 } = {}) {
  if (!(file instanceof Blob) || typeof guard !== 'function' || !configuration?.preview || !configuration?.apply) throw fail('恢复文件或页面核对无效');
  await guard(); if (active) throw fail('已有整包恢复会话，请先关闭原页面'); if (signal?.aborted) throw interrupted();
  const id = crypto.randomUUID(); let worker, current = null, counter = 0, sourceDigest = '', closed = false;
  const check = async () => { if (closed) throw interrupted(); await guard(); if (closed) throw interrupted(); };
  function finish(error, result) {
    const pending = current; if (!pending) return; current = null; clearTimeout(pending.timer);
    error ? pending.reject(error) : pending.resolve(result);
  }
  function close(reason = interrupted()) {
    if (closed) return; closed = true; signal?.removeEventListener('abort', abort); worker?.terminate(); finish(reason); if (active === entry) active = null;
  }
  const abort = () => close(), entry = { close }; active = entry;
  async function command(action, payload) {
    try { await check(); } catch (error) { close(error); throw error; } if (current) throw fail('已有恢复操作正在执行');
    const captured = structuredClone(payload);
    if (action === 'restore' && captured.prepared?.environmentReview?.state === 'mapping-required' && captured.consent?.environmentMapped !== true) throw fail('请单独确认来源与目标环境映射');
    return new Promise((resolve, reject) => {
      const operation = ++counter, pending = { operation, action, resolve, reject, lastRequest: 0, payload: captured }; current = pending;
      pending.timer = setTimeout(() => close(fail('恢复等待超时，部分可能已保存；请核对记录，不会自动重传')), Math.max(100, Math.min(300000, timeoutMs)));
      try { worker.postMessage({ id, operation, type: 'command', action, sourceDigest, payload: captured }); } catch (_) { close(fail('恢复后台连接失败，请核对可能保存的部分')); }
    });
  }
  try {
    worker = new WorkerClass(new URL('./qianmu-storyboard-bundle-restore-worker.js', import.meta.url), { type: 'module', name: 'qianmu-bundle-restore' });
    worker.addEventListener('error', () => close(fail('恢复后台异常，部分可能已保存；请核对原包与恢复记录')));
    worker.addEventListener('message', event => {
      const message = event.data, pending = current;
      if (closed || !pending || message?.id !== id || message.operation !== pending.operation) return;
      if (message.request) {
        if (!Number.isSafeInteger(message.request) || message.request <= pending.lastRequest || !['guard','configuration-preview','configuration-apply','configuration-subjects'].includes(message.kind)) { close(fail('恢复后台核对消息不符')); return; }
        pending.lastRequest = message.request;
        void (async () => {
          try {
            await check(); let result;
            if (message.kind !== 'guard') {
              const input = message.payload, apply = message.kind === 'configuration-apply', subjects = message.kind === 'configuration-subjects';
              const fields = subjects ? ['fingerprint','subjectEvidence','subjectBindings'] : ['settings','chat','imageUrls','fingerprint','chatEvidence',...(apply?['expectedDigest']:[])];
              if (!hash(sourceDigest) || input?.fingerprint !== sourceDigest || Object.keys(input).some(key => !fields.includes(key))
                || (apply ? pending.action !== 'restore' || pending.payload.consent?.confirmed !== true || pending.payload.consent?.environmentReviewed !== true : !['preview','restore'].includes(pending.action))) throw fail('未经本次确认的配置请求，未应用');
              result = await configuration[subjects ? 'subjects' : apply ? 'apply' : 'preview'](input); await check();
            }
            if (current === pending) worker.postMessage({ id, operation: pending.operation, type: 'rpc', request: message.request, result });
          } catch (error) {
            if (closed || current !== pending) return;
            if (message.kind === 'guard') { close(error); return; }
            try { worker.postMessage({ id, operation: pending.operation, type: 'rpc', request: message.request, error: { code: error?.code || 'storyboard_bundle_configuration', message: String(error?.message || '配置未确认').slice(0, 240) } }); }
            catch (_) { close(interrupted()); }
          }
        })(); return;
      }
      if (message.action !== pending.action || !['result','error'].includes(message.type)) { close(fail('恢复后台返回不符')); return; }
      if (message.type === 'error') { finish(Object.assign(fail(String(message.error?.message || '恢复未确认')), { causeCode: message.error?.code })); return; }
      if (pending.action === 'open') {
        if (!hash(message.result?.sourceDigest) || message.sourceDigest !== message.result.sourceDigest) { close(fail('恢复文件摘要缺失')); return; }
        sourceDigest = message.sourceDigest;
      } else if (message.sourceDigest !== sourceDigest || (pending.action === 'resources' && (message.result?.sourceDigest !== sourceDigest || !validStoryboardResourceOriginsPage(message.result)
        ||message.result.offset!==(pending.payload.offset??0)||message.result.filter!==(pending.payload.filter??'all')))
        || (!['restore','resources'].includes(pending.action) && (message.result?.sourceDigest !== sourceDigest || !validView(message.result, namespace)))
        || (pending.action === 'restore' && (message.result?.resourcesVerified !== true || message.result?.settingsVerified !== false))) { close(fail('恢复结果与当前原包不符')); return; }
      void check().then(() => { if (current === pending) finish(null, message.result); }, error => close(error));
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) throw interrupted();
    const supplied = new Headers(headers()), csrf = supplied.get('x-csrf-token') || '';
    await command('open', { namespace, chatKey, file, csrf });
    return Object.freeze({ sourceDigest, get isOpen() { return !closed; }, preview: decisions => command('preview', { decisions: decisions || {} }),
      resources: options => command('resources', options || {}),
      choose: decisions => command('choose', { decisions: decisions || {} }), restore: (prepared, consent) => command('restore', { prepared, consent }), close });
  } catch (error) { close(error); throw error; }
}
