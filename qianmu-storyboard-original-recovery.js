// Bounded recovery of known original tasks. This coordinator has no submission,
// catalog, or persistent queue dependency; receipts remain the recovery authority.
export function originalRecoveryLogs(logs, { chat, active = new Set(), limit = 8 } = {}) {
  if (!chat) return [];
  return (Array.isArray(logs) ? logs : []).filter(log => {
    const snap = log?.snapshot, admission = snap?.imageAdmission;
    if (!snap || snap.chatKey !== chat || log.status !== 'failed'
      || !['accepted', 'unknown'].includes(log.submissionState)
      || ['failed', 'canceled', 'expired'].includes(log.params?.upstreamStatus)
      || admission?.version !== 1 || !admission.namespace || !admission.attemptId
      || active.has(admission.attemptId)) return false;
    return snap.source === 'comfy' || snap.source === 'novel' && snap.serviceTask?.attemptId === admission.attemptId;
  }).slice(0, limit);
}

export function createOriginalTaskRecovery({ scope, logs, active, receive, schedule = setTimeout, cancel = clearTimeout,
  delays = [0, 20000, 60000] }) {
  let owner = null, timer = null, pending = null, round = 0;
  const same = (a, b) => Boolean(a && b && a.owner === b.owner && a.epoch === b.epoch && a.chat === b.chat);
  const reset = () => { if (timer !== null) cancel(timer); timer = null; owner = null; round = 0; };
  const enqueue = () => {
    if (!owner || timer !== null || pending || round >= delays.length) return;
    const captured = owner;
    timer = schedule(() => { timer = null; void run(captured); }, delays[round]);
  };
  async function run(captured) {
    if (!same(captured, scope())) { reset(); return; }
    round++;
    pending = (async () => {
      const candidates=originalRecoveryLogs(logs(), { chat: captured.chat, active: active() });
      if (!candidates.length) round=delays.length;
      for (const log of candidates) {
        if (!same(captured, owner) || !same(captured, scope())) break;
        if (!logs().includes(log) || !originalRecoveryLogs([log], { chat: captured.chat, active: active() }).length) continue;
        // The concrete receiver rechecks account, original receipt and page scope
        // before each network request and every archive write.
        try { await receive(log); } catch (_) { /* Keep original diagnostics/locks. */ }
      }
    })();
    try { await pending; }
    finally {
      pending = null;
      if (same(captured, scope()) && same(owner, captured)) enqueue();
      else if (owner && same(owner, scope())) enqueue();
      else reset();
    }
  }
  return {
    trigger() {
      const current = scope();
      if (!current?.chat || !current.owner) { reset(); return; }
      if (!same(owner, current)) { reset(); owner = current; }
      else if (pending || timer !== null) return;
      else round = 0;
      enqueue();
    },
    reset,
  };
}
