let active = null;
const failure = message => Object.assign(new Error(message), { code: 'storyboard_bundle_runtime', submissionState: 'not_submitted' });
export function closeStoryboardBundleRuntime() { active?.finish(failure('资源包处理已取消，原库未修改')); }

// The worker owns heavy validation and short-lived, read-only library connections. No synchronous fallback on mobile.
export async function runStoryboardBundle(action, file, { namespace, chatKey, source = null, guard, signal, WorkerClass = globalThis.Worker, timeoutMs = 180000 } = {}) {
  if (!['capture', 'inspect'].includes(action) || !(file instanceof Blob) || typeof guard !== 'function') throw failure('资源包操作或环境核对无效');
  const capturedSource = source === null ? null : structuredClone(source);
  await guard();
  if (active) throw failure('已有资源包正在处理');
  if (signal?.aborted) throw failure('资源包处理已取消');
  return new Promise((resolve, reject) => {
    let worker, ended = false, timer;
    const abort = () => finish(failure('资源包处理已取消，原库未修改'));
    const finish = (error, result) => {
      if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker?.terminate();
      if (active === entry) active = null;
      if (error) { reject(error); return; } Promise.resolve().then(guard).then(() => { if (signal?.aborted) reject(failure('资源包处理已取消')); else resolve(result); }, reject);
    };
    const entry = { finish }; active = entry;
    try {
      worker = new WorkerClass(new URL('./qianmu-storyboard-bundle-worker.js', import.meta.url), { type: 'module', name: 'qianmu-storyboard-bundle' });
      worker.addEventListener('error', () => finish(failure('资源包处理失败，原库未修改')));
      worker.addEventListener('message', event => {
        if (ended) return;
        if (Number.isSafeInteger(event.data?.guard) && event.data.guard > 0) {
          const id = event.data.guard;
          Promise.resolve().then(guard).then(() => { if (!ended) worker.postMessage({ guard: id }); }).catch(error => finish(error)); return;
        }
        if (event.data?.error) { finish(Object.assign(failure(event.data.error.message || '资源包处理失败'), { causeCode: event.data.error.code })); return; }
        const result = event.data?.result;
        if (!result?.summary || !result.manifest || typeof result.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.fingerprint)
          || (action === 'capture' ? !(result.file instanceof Blob) : !Number.isSafeInteger(result.fileBytes))) finish(failure('资源包处理返回不完整'));
        else finish(null, result);
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(failure('资源包处理超时，请保留原文件后重试')), Math.max(100, Math.min(300000, Number(timeoutMs) || 180000)));
      if (signal?.aborted) { abort(); return; }
      worker.postMessage({ action, file, ...(action === 'capture' ? { namespace, chatKey, source: capturedSource } : {}) });
    } catch (_) { finish(failure('无法启动资源包后台处理，请检查浏览器权限')); }
  });
}
