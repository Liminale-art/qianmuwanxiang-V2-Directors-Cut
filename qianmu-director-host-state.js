// Read-only ST lifecycle signals. This is an admission check, not a native-save
// lock or persistence receipt. The caller binds queued work to its chat source.
const unavailable = () => Object.assign(new Error('暂无法确认正文状态，请稍后重试。'), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
const busy = () => Object.assign(new Error('正文正在生成或保存，请稍后推演。'), { code: 'DIRECTOR_HOST_BUSY' });
const unknown = () => Object.freeze({ known: false, generating: false, saving: false, streaming: false, streamingStopped: false, idle: false });

export function createDirectorHostState({ loadHost } = {}) {
  if (typeof loadHost !== 'function') throw unavailable();
  let host = null, loading = null;

  function readHost(module) {
    try {
      if (!module || typeof module.isGenerating !== 'function' || typeof module.closeCurrentChat !== 'function'
        || typeof module.isChatSaving !== 'boolean' || !('streamingProcessor' in module)) return unknown();
      const generating = module.isGenerating(), saving = module.isChatSaving, processor = module.streamingProcessor;
      if (typeof generating !== 'boolean' || typeof saving !== 'boolean') return unknown();
      if (processor !== null && (typeof processor !== 'object' || !processor
        || typeof processor.isStopped !== 'boolean' || typeof processor.isFinished !== 'boolean')) return unknown();
      // ST clears a successful/explicitly stopped stream only after its native
      // save tail. isFinished alone must not admit Q in that interval. A failed
      // stream can remain in ST with isStopped=true after UI cleanup instead.
      const streamingStopped = processor !== null && processor.isStopped === true;
      const streaming = processor !== null && !streamingStopped;
      return Object.freeze({ known: true, generating, saving, streaming, streamingStopped,
        idle: !generating && !saving && !streaming });
    } catch (_) { return unknown(); }
  }

  const read = () => readHost(host);
  function assertIdle({ allowSaving = false } = {}) {
    const state = read();
    if (!state.known) throw unavailable();
    if (state.generating || state.streaming || state.saving && allowSaving !== true) throw busy();
    return state;
  }

  return Object.freeze({
    read,
    assertIdle,
    async ready() {
      if (host) {
        const state = read();
        if (!state.known) throw unavailable();
        return state;
      }
      if (!loading) {
        loading = Promise.resolve().then(loadHost).then(module => {
          if (!readHost(module).known) throw unavailable();
          host = module;
        }).catch(() => { throw unavailable(); }).finally(() => { loading = null; });
      }
      await loading;
      const state = read();
      if (!state.known) throw unavailable();
      return state;
    },
    closeChat() {
      // No import or timer here: the caller's synchronous source check must be
      // immediately followed by the native close, while its guard stays held.
      assertIdle();
      return host.closeCurrentChat();
    },
  });
}
