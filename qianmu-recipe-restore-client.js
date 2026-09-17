import { inspectRecipeRestoreRequest, recipeRestoreRequest, recipeRestoreResponse } from './qianmu-recipe-restore-contract.js';
import { recipeArchiveEnvelope } from './qianmu-recipe-archive-contract.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const error = (message, started = false) => Object.assign(new Error(message), {
  code: 'recipe_restore_client', recipeWriteState: started ? 'unconfirmed' : 'not_started', submissionState: 'not_submitted',
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Explicit one-recipe import, NOT an ordinary saved-chat borrower. Returning a
// durable file reference does not apply it to the chat or prove its dependencies.
export function createRecipeRestoreClient({ namespace, guard, headers = () => ({}), fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)
    || ![guard, headers, fetchImpl].every(fn => typeof fn === 'function') || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw error('缺少配方恢复账户或来源保护');
  let closed = false, busy = false, abortPending = null;
  const account = vibeDigest(namespace.slice(8)).then(value => 'st-user:' + value);
  return Object.freeze({
    close() { closed = true; abortPending?.(); },
    async restore(input, { confirmed = false, signal } = {}) {
      if (closed || busy || confirmed !== true) throw error('请明确确认配方恢复，并等待上一项完成');
      // Validate/detach all caller fields synchronously; use a temporary valid
      // account only for shape checking, replaced by the captured account below.
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
        || !['source', 'snapshot', 'originalReference'].every(key => Object.hasOwn(input, key))) throw error('配方恢复只接受原始来源、完整内容与旧引用，不接受账户覆盖或额外路径');
      const captured = recipeRestoreRequest({ ...input, version: 1, expectedAccount: 'st-user:' + '0'.repeat(64), confirmed: true });
      busy = true; let started = false, reject;
      const controller = new AbortController(), cancelled = new Promise((_, no) => reject = no);
      const abort = () => { controller.abort(); reject(error('配方恢复已取消或超时，请保留原包核对；不自动重传', started)); };
      const alive = () => { if (closed || controller.signal.aborted) throw error('配方恢复已结束，请保留原件核对', started); };
      const check = async () => { alive(); if (await guard() === false) throw error('配方恢复来源保护未通过', started); alive(); };
      abortPending = abort; signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.min(120000, timeoutMs));
      try {
        if (signal?.aborted) abort();
        return await Promise.race([(async () => {
          await check();
          const { request } = await inspectRecipeRestoreRequest({ ...captured, expectedAccount: await account }); await check();
          const supplied = new Headers(await headers()), requestHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
          if (supplied.has('x-csrf-token')) requestHeaders['X-CSRF-Token'] = supplied.get('x-csrf-token');
          await check(); started = true;
          const response = await fetchImpl('/api/plugins/qianmu-tts/chat-gallery/recipe/restore', {
            method: 'POST', body: JSON.stringify(request), headers: requestHeaders, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          });
          const discard = () => { void response.body?.cancel?.().catch(() => {}); };
          if (closed || controller.signal.aborted) { discard(); alive(); }
          if (response.status === 404 || response.status === 405) { discard(); throw error('配方恢复需要新版配套后端；原包保留，未改聊天引用', true); }
          if (!/^application\/json\b/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > 8192) { discard(); throw error('配方恢复回执不兼容或过大，请核对原件', true); }
          const reader = response.body?.getReader?.(); if (!reader) throw error('配方恢复回执缺失', true);
          const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
          let text = '', bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
          try {
            while (true) { alive(); const part = await reader.read(); alive(); if (part.done) break;
              bytes += part.value.byteLength; if (bytes > 8192) throw error('配方恢复回执超限，未使用不完整引用', true); text += decoder.decode(part.value, { stream: true }); }
            text += decoder.decode();
          } finally { controller.signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
          let value; try { value = JSON.parse(text); } catch { throw error('配方恢复回执损坏', true); }
          if (!response.ok || value?.ok !== true) throw error('配方恢复尚未确认，请保留原包重新核对；未自动重传', true);
          const result = recipeRestoreResponse(value);
          const expected = recipeArchiveEnvelope({ version: 1, expectedAccount: request.expectedAccount, source: request.source, snapshot: request.snapshot });
          if (result.expectedAccount !== request.expectedAccount || !same(result.source, expected.value.source) || !same(result.originalReference, request.originalReference)) throw error('配方恢复回执不属于此次账户、画面或原引用', true);
          await check(); return result;
        })(), cancelled]);
      } catch (cause) {
        if (started) closed = true;
        if (cause?.code === 'recipe_restore_client') throw cause;
        throw error(started ? '配方写入未确认，请保留原包核对；不自动重传' : cause.message, started);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); abortPending = null; busy = false; }
    },
  });
}
