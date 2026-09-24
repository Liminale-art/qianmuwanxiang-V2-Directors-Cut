// Only the jobs already accepted by the ordinary queue occupy its eight slots.
// A producer may wait for one free slot without retaining an unbounded job queue
// or changing the submission and uncertainty rules owned by storyboardQueueJob.
export function createStoryboardQueueWindow({ limit = 8, occupied, pollMs = 120, maxWaiters = 64 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('队列容量无效');
  if (typeof occupied !== 'function') throw new TypeError('缺少队列占用量读取函数');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new TypeError('队列检查间隔无效');
  if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 1) throw new TypeError('队列等待容量无效');

  const waiting = [];
  const held = new Set();
  let closed = false;
  let draining = false;
  let timer = null;

  const failure = (code, message) => Object.assign(new Error(message), { code });
  const cancelled = () => failure('storyboard_queue_window_cancelled', '本批画面已取消，未提交后续镜头');
  const stale = () => failure('storyboard_queue_window_stale', '本批画面状态已变化，未提交后续镜头');

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const keepTimer = () => {
    if (closed || !waiting.length) stopTimer();
    else if (timer === null) timer = setInterval(notify, pollMs);
  };
  const remove = (waiter) => {
    const index = waiting.indexOf(waiter);
    if (index >= 0) waiting.splice(index, 1);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    waiter.settled = true;
  };
  const reject = (waiter, error) => {
    if (waiter.settled) return;
    remove(waiter);
    waiter.reject(error);
  };
  const current = (waiter) => {
    if (waiter.signal?.aborted) throw cancelled();
    try {
      if (waiter.isCurrent() === true) return;
    } catch (_) { /* A disappearing batch has the same safe outcome. */ }
    throw stale();
  };
  const readOccupancy = () => {
    const count = occupied();
    if (!Number.isSafeInteger(count) || count < 0) {
      throw failure('storyboard_queue_window_occupancy', '无法确认队列占用量，未提交后续镜头');
    }
    return count;
  };

  function notify() {
    if (closed || draining) return;
    draining = true;
    try {
      for (const waiter of [...waiting]) {
        try { current(waiter); }
        catch (error) { reject(waiter, error); }
      }
      if (!waiting.length) return;
      let count;
      try { count = readOccupancy(); }
      catch (error) {
        for (const waiter of [...waiting]) reject(waiter, error);
        return;
      }
      while (waiting.length && count + held.size < limit) {
        const waiter = waiting[0];
        try { current(waiter); }
        catch (error) { reject(waiter, error); continue; }
        remove(waiter);
        const permit = Object.freeze({
          release() {
            if (!held.delete(permit)) return;
            notify();
          },
        });
        held.add(permit);
        waiter.resolve(permit);
      }
    } finally {
      draining = false;
      keepTimer();
    }
  }

  function acquire({ batch = null, isCurrent = () => true, signal } = {}) {
    if (closed) return Promise.reject(cancelled());
    if (typeof isCurrent !== 'function') return Promise.reject(stale());
    if (waiting.length >= maxWaiters) {
      return Promise.reject(failure('storyboard_queue_window_full', '当前等待的批次过多，请稍后再试'));
    }
    return new Promise((resolve, rejectPromise) => {
      const waiter = { batch, isCurrent, signal, resolve, reject: rejectPromise, settled: false, onAbort: null };
      waiter.onAbort = () => {
        reject(waiter, cancelled());
        keepTimer();
        notify();
      };
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      waiting.push(waiter);
      notify();
    });
  }

  function cancel(batch) {
    if (batch == null) return 0;
    let count = 0;
    for (const waiter of [...waiting]) {
      if (waiter.batch !== batch) continue;
      reject(waiter, cancelled());
      count++;
    }
    keepTimer();
    notify();
    return count;
  }

  function close() {
    if (closed) return;
    closed = true;
    stopTimer();
    for (const waiter of [...waiting]) reject(waiter, cancelled());
    held.clear();
  }

  return Object.freeze({
    acquire, notify, cancel, close,
    has: permit => held.has(permit),
    get reservedCount() { return held.size; },
    get waitingCount() { return waiting.length; },
  });
}
