// A prepared batch owns its jobs and takes only one queue permit at a time.
// The caller still owns admission, task records, and what an upstream result means.
export function startStoryboardQueueWindowBatch(window, {
  jobs, isCurrent = () => true, prepare = () => {}, enqueue,
  onAccepted = () => {}, onRefused = () => {}, onStop = () => {}, onFinish = () => {},
} = {}) {
  if (!window || typeof window.acquire !== 'function' || typeof window.has !== 'function'
    || typeof window.cancel !== 'function') throw new TypeError('分镜队列窗口无效');
  if (!Array.isArray(jobs) || typeof enqueue !== 'function') throw new TypeError('分镜批次或入队函数无效');
  for (const callback of [isCurrent, prepare, onAccepted, onRefused, onStop, onFinish]) {
    if (typeof callback !== 'function') throw new TypeError('分镜批次回调无效');
  }

  const items = jobs.slice();
  const batch = {};
  const controller = new AbortController();
  const stopListeners = new Set();
  const reportingErrors = [];
  let next = 0, acceptedCount = 0, failedCount = 0, stopped = false, finished = false, reason = null;

  const asReason = value => {
    if (value && typeof value === 'object' && typeof value.message === 'string') return value;
    return Object.assign(new Error(String(value || '本批画面已停止，余下镜头未提交')),
      { code: 'storyboard_queue_batch_stopped' });
  };

  function stop(value) {
    if (stopped || finished) return false;
    stopped = true;
    reason = asReason(value);
    controller.abort();
    try { window.cancel(batch); }
    catch (error) { reportingErrors.push(error); }
    for (const wake of stopListeners) wake();
    stopListeners.clear();
    return true;
  }

  function current() {
    if (stopped) return false;
    try { return isCurrent() === true; }
    catch (error) { stop(error); return false; }
  }

  function assertCurrent() {
    if (stopped) throw reason;
    if (!current()) {
      stop(Object.assign(new Error('本批画面状态已变化，余下镜头未提交'),
        { code: 'storyboard_queue_batch_stale' }));
      throw reason;
    }
  }

  async function prepareCurrent(job, index) {
    let wake;
    const stoppedPromise = new Promise(resolve => {
      wake = resolve;
      stopListeners.add(resolve);
    });
    const work = Promise.resolve().then(() => {
      assertCurrent();
      return prepare(job, index, current, controller.signal);
    })
      .then(value => ({ value }), error => ({ error }));
    try {
      const outcome = await Promise.race([work, stoppedPromise.then(() => ({ stopped: true }))]);
      if (outcome.stopped) throw reason;
      if ('error' in outcome) throw outcome.error;
      if (outcome.value === false) throw Object.assign(new Error('本镜准备未通过，余下镜头未提交'),
        { code: 'storyboard_queue_batch_prepare' });
    } finally { stopListeners.delete(wake); }
  }

  async function run() {
    try {
      while (next < items.length) {
        const index = next, job = items[index];
        let permit = null, accepted = false;
        try {
          assertCurrent();
          permit = await window.acquire({ batch, isCurrent: current, signal: controller.signal });
          assertCurrent();
          await prepareCurrent(job, index);
          assertCurrent();
          if (!window.has(permit)) throw Object.assign(new Error('分镜队列窗口已关闭，余下镜头未提交'),
            { code: 'storyboard_queue_batch_closed' });
          let result, enqueueError = null;
          try { result = await enqueue(job, permit, current); }
          catch (error) { enqueueError = error; }
          accepted = result === true || job?.queueAccepted === true;
          if (accepted) {
            acceptedCount++;
            next++;
            let reportError = null;
            try { await onAccepted(job, index); }
            catch (error) { reportError = error; }
            if (enqueueError && reportError) reportingErrors.push(reportError);
            if (enqueueError) throw enqueueError;
            if (reportError) throw reportError;
          } else {
            if (enqueueError) throw enqueueError;
            assertCurrent();
            failedCount++;
            next++;
            await onRefused(job, index);
          }
        } catch (error) {
          stop(error);
          break;
        } finally { permit?.release(); }
      }
    } catch (error) { stop(error); }

    finished = true;
    const outcome = {
      acceptedCount, failedCount, pendingCount: items.length - next,
      stopped, reason, remainingJobs: items.slice(next), reportingErrors,
    };
    if (stopped) {
      try { await onStop(outcome); }
      catch (error) { reportingErrors.push(error); }
    }
    try { await onFinish(outcome); }
    catch (error) { reportingErrors.push(error); }
    return outcome;
  }

  // Register synchronously. No producer work runs before the caller receives
  // the handle and can put it in its owner Set for cancellation or UI status.
  const done = Promise.resolve().then(run);
  return Object.freeze({
    batch, done, stop,
    get pendingCount() { return items.length - next; },
    get acceptedCount() { return acceptedCount; },
    get failedCount() { return failedCount; },
  });
}
