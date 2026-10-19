// A page-local guard for the reproduced ST loading-window empty write only.
// It is not a save lock, backup, receipt, or protection for another tab/device.
// Unknown identities/encodings pass through; no request is changed or replayed.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && value !== '.' && value !== '..' && !/[. ]$/.test(value);
const missingIntegrity = metadata => plain(metadata)
  && (metadata.integrity === undefined || metadata.integrity === null || metadata.integrity === '');
const header = value => plain(value) && plain(value.chat_metadata) && !Object.hasOwn(value, 'mes');
const nonemptyChat = rows => Array.isArray(rows) && rows.length > 1 && header(rows[0])
  && rows.every((row, i) => i === 0 || plain(row) && typeof row.mes === 'string');

export function createChatWriteGuard({
  fetchImpl, getContext, resolveAccount, baseUrl = globalThis.location?.href,
  isEnabled = () => true, onBlock = () => {}, onDiagnostic = () => {},
  platform = globalThis, maxBodyBytes = 1024 * 1024, inspectTimeoutMs = 750,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof getContext !== 'function' || typeof resolveAccount !== 'function') {
    throw new TypeError('Chat write guard requires fetch, context and account dependencies');
  }
  const origin = new URL(baseUrl).origin;
  const baselines = new Map(), windows = new Map(), diagnostics = new Set();
  let disposed = false, epoch = 0, account = null, ownerRevision = 0, ownerSequence = 0, latestOwnerResult = 0;
  const enabled = () => { try { return !disposed && isEnabled() === true; } catch { return false; } };
  function emit(callback, detail) {
    try { const value = callback(Object.freeze(detail)); if (value?.then) void Promise.resolve(value).catch(() => {}); }
    catch { /* Observers cannot change host results. */ }
  }
  function diagnostic(code) {
    if (diagnostics.has(code)) return;
    diagnostics.add(code); emit(onDiagnostic, { code, scope: 'chat-write-guard' });
  }
  function clearEvidence() {
    epoch++; baselines.clear();
    for (const set of windows.values()) for (const record of set) platform.clearTimeout(record.unclaimed);
    windows.clear(); account = null;
  }
  function reset() { ownerRevision++; clearEvidence(); }
  async function owner() {
    const started = ownerRevision, sequence = ++ownerSequence; let value;
    try { value = await resolveAccount(); }
    catch {
      if (started !== ownerRevision || sequence < latestOwnerResult || !enabled()) return null;
      latestOwnerResult = sequence; reset(); diagnostic('account-unavailable'); return null;
    }
    // A late older resolution (including failure) must never replace a newer
    // accepted identity. Explicit reset invalidates every outstanding lookup;
    // accepting an earlier lookup does not invalidate a newer pending one.
    if (started !== ownerRevision || sequence < latestOwnerResult || !enabled()) return null;
    latestOwnerResult = sequence;
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) { reset(); return null; }
    if (account !== value) { clearEvidence(); account = value; }
    return value;
  }
  function target(value, ownerId) {
    if (!ownerId || !name(value?.file_name) || !name(value?.avatar_url) || !value.avatar_url.endsWith('.png')) return null;
    return JSON.stringify([ownerId, value.avatar_url, value.file_name]);
  }
  function current(ownerId) {
    let context;
    try { context = getContext(); } catch { return null; }
    if (!context || context.groupId !== undefined && context.groupId !== null && context.groupId !== '') return null;
    const character = context.characters?.[context.characterId];
    if (!character || context.chatId !== character.chat || !Array.isArray(context.characters)
      || context.characters.filter(value => value?.avatar === character.avatar).length !== 1) return null;
    const key = target({ avatar_url: character?.avatar, file_name: character?.chat }, ownerId);
    if (!key || !Array.isArray(context.chat)) return null;
    return { key, rows: context.chat, metadata: context.chatMetadata };
  }
  function remember(key, count) {
    baselines.delete(key);
    if (count > 0) baselines.set(key, count);
    // Counts/keys only, bounded for a long-lived page. Eviction reduces coverage.
    while (baselines.size > 256) baselines.delete(baselines.keys().next().value);
  }
  async function observeCurrent() {
    if (!enabled()) return false;
    const ownerId = await owner();
    if (!enabled() || account !== ownerId) return false;
    const live = current(ownerId);
    if (!live || !live.rows.length || !live.rows.every(row => plain(row) && typeof row.mes === 'string')) return false;
    remember(live.key, live.rows.length); return true;
  }
  function route(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, baseUrl);
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      if (url.origin !== origin || url.username || url.password || method !== 'POST') return null;
      if (!['/api/chats/get', '/api/chats/save'].includes(url.pathname)) return null;
      return url.pathname.endsWith('/get') ? 'get' : 'save';
    } catch { return null; }
  }
  async function readStream(stream) {
    const reader = stream.getReader(), parts = [];
    let total = 0, timeout;
    try {
      const deadline = new Promise((_, reject) => { timeout = platform.setTimeout(() => reject(new Error('inspection-timeout')), inspectTimeoutMs); });
      while (true) {
        const { value, done } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        total += value.byteLength;
        if (total > maxBodyBytes) throw new Error('inspection-limit');
        parts.push(value);
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      return bytes;
    } finally {
      platform.clearTimeout(timeout);
      // Do not await cancellation of a Request.clone tee: it may wait for the
      // untouched original to be consumed by fetch, which would deadlock here.
      void reader.cancel().catch(() => {});
    }
  }
  async function payload(input, init) {
    try {
      const headers = new platform.Headers(init?.headers ?? input?.headers);
      const encoding = (headers.get('content-encoding') || '').trim().toLowerCase();
      if (encoding && encoding !== 'identity' && encoding !== 'gzip') throw new Error('encoding');
      let body = init?.body;
      if (body === undefined || body === null) {
        if (platform.Request && input instanceof platform.Request) {
          if (input.bodyUsed) throw new Error('used-request');
          const copy = input.clone();
          body = copy.body ? await readStream(copy.body) : null;
        }
      }
      let bytes;
      if (typeof body === 'string') bytes = new platform.TextEncoder().encode(body);
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body.slice(0));
      else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
      else if (platform.Blob && body instanceof platform.Blob && body.size <= maxBodyBytes) bytes = new Uint8Array(await body.arrayBuffer());
      else throw new Error('body-type'); // In particular, never consume an init ReadableStream.
      if (bytes.byteLength > maxBodyBytes) throw new Error('inspection-limit');
      if (encoding === 'gzip') {
        if (!platform.DecompressionStream) throw new Error('gzip-unavailable');
        const stream = new platform.Blob([bytes]).stream().pipeThrough(new platform.DecompressionStream('gzip'));
        bytes = await readStream(stream);
      }
      return JSON.parse(new platform.TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { diagnostic('body-uninspectable'); return null; }
  }
  function finish(record) {
    if (!record) return;
    platform.clearTimeout(record.unclaimed);
    record.response = null;
    const set = windows.get(record.key);
    set?.delete(record);
    if (!set?.size) windows.delete(record.key);
  }
  function observeResponse(response, key, ownerId, requestEpoch, record) {
    if (!response?.ok || typeof response.json !== 'function') { finish(record); return response; }
    const json = response.json;
    let first = true;
    try {
      // Native getChat calls .json() in the receiving microtask. If a different
      // consumer never does so, do not retain a phantom loading window forever.
      // This one-shot cleanup is not polling and never delays the host response.
      if (record) {
        record.response = response;
        record.unclaimed = platform.setTimeout(() => { if (!record.reading) finish(record); }, 0);
        // A clone/text/stream consumer is not the verified native JSON loader.
        // Release rather than pretend that it is an in-progress host load.
        for (const method of ['clone', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes']) {
          const original = response[method];
          if (typeof original !== 'function') continue;
          Object.defineProperty(response, method, { configurable: true, writable: true, value: function (...args) {
            finish(record); return Reflect.apply(original, this, args);
          } });
        }
      }
      // Native ST consumes .json(). Keep only its parsing window, not the data.
      // Other consumers remain readable but deliberately forfeit coverage.
      Object.defineProperty(response, 'json', { configurable: true, writable: true, value: function (...args) {
        if (!first) return Reflect.apply(json, this, args);
        first = false;
        if (record) record.reading = true;
        let reading;
        try { reading = Reflect.apply(json, this, args); } catch (error) { finish(record); throw error; }
        return Promise.resolve(reading).then(data => {
          if (enabled() && requestEpoch === epoch && account === ownerId) {
            if (nonemptyChat(data)) remember(key, data.length - 1);
            else if (Array.isArray(data) && (!data.length || data.length === 1 && header(data[0]))) remember(key, 0);
          }
          return data;
        }).finally(() => finish(record));
      } });
    } catch { finish(record); diagnostic('response-unobservable'); }
    return response;
  }
  async function guardedFetch(input, init) {
    const args = arguments, receiver = this;
    const forward = () => Reflect.apply(fetchImpl, receiver, args);
    if (!enabled()) { if (account !== null) reset(); return forward(); }
    const kind = route(input, init);
    if (!kind) return forward();
    // Ordinary saves do not need any inspection, account lookup or new work.
    if (kind === 'save' && windows.size === 0) return forward();
    if ((init?.signal ?? input?.signal)?.aborted) return forward();
    const ownerId = await owner();
    if (!ownerId || !enabled()) return forward();
    const body = await payload(input, init), key = target(body, ownerId);
    if (!key || !enabled() || account !== ownerId) return forward();
    const requestEpoch = epoch, live = current(ownerId);
    if (kind === 'get') {
      const record = live?.key === key && live.rows.length === 0 && missingIntegrity(live.metadata)
        ? { key, notified: false } : null;
      if (record) {
        const set = windows.get(key) || new Set(); set.add(record); windows.set(key, set);
      }
      try { return observeResponse(await forward(), key, ownerId, requestEpoch, record); }
      catch (error) { finish(record); throw error; }
    }
    let pending = windows.get(key);
    // body.getReader() cannot be observed by a method wrapper. A body consumed
    // outside our JSON parser must not leave a phantom loading record either.
    if (pending) {
      for (const record of [...pending]) if ((record.response?.bodyUsed || record.response?.body?.locked) && !record.reading) finish(record);
      pending = windows.get(key);
    }
    const suspect = Array.isArray(body?.chat) && body.chat.length === 1 && header(body.chat[0])
      && missingIntegrity(body.chat[0].chat_metadata);
    if (suspect && baselines.has(key) && pending?.size && live?.key === key
      && live.rows.length === 0 && missingIntegrity(live.metadata)) {
      // Recheck after asynchronous body decoding; never carry ownership over a
      // login change, disable, disposed instance, or completed GET.
      const verifiedOwner = await owner(), fresh = current(verifiedOwner);
      if (enabled() && epoch === requestEpoch && verifiedOwner === ownerId && baselines.has(key)
        && windows.get(key)?.size && fresh?.key === key && fresh.rows.length === 0 && missingIntegrity(fresh.metadata)
        && !(init?.signal ?? input?.signal)?.aborted) {
        const detail = { code: 'qianmu_chat_empty_write_blocked', scope: 'chat-write-guard', phase: 'loading', messageCount: 0 };
        if ([...pending].some(record => !record.notified)) {
          for (const record of pending) record.notified = true;
          emit(onBlock, detail);
        }
        throw Object.assign(new Error('已拦截加载中的异常空聊天保存；原聊天未被此请求覆盖。'), { code: detail.code });
      }
    }
    const response = await forward();
    if (enabled() && epoch === requestEpoch && account === ownerId && response?.ok
      && Array.isArray(body?.chat) && body.chat.length === 1 && header(body.chat[0])) remember(key, 0);
    return response;
  }
  return Object.freeze({ fetch: guardedFetch, observeCurrent, reset, dispose() { disposed = true; reset(); } });
}
