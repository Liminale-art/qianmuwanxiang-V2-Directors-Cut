import { projectStoryboardChatMessages } from './qianmu-storyboard-chat-evidence.js';
import { projectStoryboardSubjects, inspectStoryboardSubjectEvidence } from './qianmu-storyboard-subject-evidence.js';
import { validateBundleMappingTransportSummary } from './qianmu-bundle-mapping-contract.js';
import {validateBundleCarriersTransportSummary} from './qianmu-bundle-carriers-contract.js';
import {captureCharacterWorkerStorage} from './qianmu-character-worker-storage.js';
import {createVerifiedProgressWatch} from './qianmu-verified-progress-watch.js';
let active = null;
const failure = message => Object.assign(new Error(message), { code: 'storyboard_bundle_runtime', submissionState: 'not_submitted' });
export function closeStoryboardBundleRuntime() { active?.finish(failure('资源包处理已取消，可能已保全部分来源；请保留原文件重新核对')); }

// The worker owns heavy validation and may preserve old sources in ST. No synchronous fallback on mobile.
export async function runStoryboardBundle(action, file, { namespace, chatKey, source = null, chatEvidence = null, subjectEvidence = null, subjects, messages, guard, signal, WorkerClass = globalThis.Worker, timeoutMs = 180000, totalTimeoutMs = 1800000 } = {}) {
  if (!['capture', 'inspect', 'chat-evidence', 'subject-evidence'].includes(action) || (!['chat-evidence','subject-evidence'].includes(action) && !(file instanceof Blob)) || typeof guard !== 'function') throw failure('资源包操作或环境核对无效');
  const capturedSource = source === null ? null : structuredClone(source);
  const capturedChat = chatEvidence === null ? null : structuredClone(chatEvidence), projected = action === 'chat-evidence' ? projectStoryboardChatMessages(messages) : null;
  const capturedSubjects = subjectEvidence === null ? null : structuredClone(subjectEvidence), subjectProjection = action === 'subject-evidence' ? projectStoryboardSubjects(subjects) : null;
  await guard();
  const nativeCharacters = action === 'capture' ? await captureCharacterWorkerStorage(namespace, guard) : null;
  if (active) throw failure('已有资源包正在处理');
  if (signal?.aborted) throw failure('资源包处理已取消');
  return new Promise((resolve, reject) => {
    let worker, ended = false, watch, lastProgress=0;
    const abort = () => finish(failure('资源包处理已取消，可能已保全部分来源；请保留原文件重新核对'));
    const finish = (error, result) => {
      if (ended) return; ended = true; watch?.stop(); signal?.removeEventListener('abort', abort); worker?.terminate();
      if (active === entry) active = null;
      if (error) { reject(error); return; } Promise.resolve().then(guard).then(() => { if (signal?.aborted) reject(failure('资源包处理已取消')); else resolve(result); }, reject);
    };
    const entry = { finish }; active = entry;
    try {
      worker = new WorkerClass(new URL('./qianmu-storyboard-bundle-worker.js', import.meta.url), { type: 'module', name: 'qianmu-storyboard-bundle' });
      worker.addEventListener('error', () => finish(failure('资源包处理失败，可能已保全部分来源；请保留原文件重新核对')));
      worker.addEventListener('message', event => {
        if (ended) return;
        if(Object.hasOwn(event.data||{},'progress')){
          const value=event.data;if(action!=='capture'||Object.keys(value).length!==1||!Number.isSafeInteger(value.progress)||value.progress!==lastProgress+1){finish(failure('资源包进度消息不符'));return;}
          lastProgress=value.progress;Promise.resolve().then(guard).then(()=>{if(!ended)watch?.progress();}).catch(error=>finish(error));return;
        }
        if (Number.isSafeInteger(event.data?.guard) && event.data.guard > 0) {
          const id = event.data.guard;
          Promise.resolve().then(guard).then(() => { if (!ended) worker.postMessage({ guard: id }); }).catch(error => finish(error)); return;
        }
        if (event.data?.error) { finish(Object.assign(failure(event.data.error.message || '资源包处理失败'), { causeCode: event.data.error.code })); return; }
        const result = event.data?.result;
        if (action === 'subject-evidence') {
          void inspectStoryboardSubjectEvidence(result?.subjectEvidence).then(evidence => {
            if (JSON.stringify(evidence.subjects.map(row => [row.category,row.subjectKey])) !== JSON.stringify(subjectProjection.map(row => [row.category,row.subjectKey]))) throw failure('角色来源核对返回不完整');
            finish(null, { subjectEvidence: evidence });
          }).catch(error => finish(error)); return;
        }
        if (action === 'chat-evidence') {
          if (result?.chatEvidence?.schema !== 'qianmu.storyboard.chat-evidence.v1' || result.chatEvidence.chatKey !== chatKey || !Array.isArray(result.chatEvidence.messages)
            || result.chatEvidence.messages.length !== projected.length || !/^[a-f0-9]{64}$/.test(result.chatEvidence.digest || '')) finish(failure('正文来源核对返回不完整'));
          else finish(null, result); return;
        }
        if (!result?.summary || !result.manifest || typeof result.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.fingerprint)
          || (action === 'capture' ? !(result.file instanceof Blob) : !Number.isSafeInteger(result.fileBytes))) finish(failure('资源包处理返回不完整'));
        else {
          try { validateBundleMappingTransportSummary(result.summary.mappingReceipts,result.manifest);validateBundleCarriersTransportSummary(result.summary.carriers,result.manifest); }
          catch (_) { finish(failure('资源包迁移凭据摘要返回不符'));return; }
          finish(null, result);
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      watch=createVerifiedProgressWatch({idleMs:timeoutMs,totalMs:totalTimeoutMs,onTimeout:kind=>finish(failure(kind==='total'?'资源包已达本次最长等待，可能已保全部分来源；请保留原文件重新核对，不会自动重传':'资源包处理超时，长时间没有确认进展；请保留原文件重新核对，不会自动重传'))});
      if (signal?.aborted) { abort(); return; }
      worker.postMessage({ action, file, ...(action === 'capture' ? { namespace, chatKey, source: capturedSource, chatEvidence: capturedChat, subjectEvidence: capturedSubjects, ...(nativeCharacters ? {nativeCharacters} : {}) } : {}),
        ...(action === 'subject-evidence' ? { subjects: subjectProjection } : {}),
        ...(action === 'chat-evidence' ? { chatKey, messages: projected } : {}) });
    } catch (_) { finish(failure('无法启动资源包后台处理，请检查浏览器权限')); }
  });
}
