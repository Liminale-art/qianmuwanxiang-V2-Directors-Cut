// A chat save that was answered without being written.
//
// Some page scripts answer ST's POST /api/chats/save themselves when they believe the file is already
// current, replying 200 with a JSON body marked `skipped: true`. The request body of that save — which
// carries the live chat metadata and any message fields changed since their copy was taken — never
// reaches disk, and nothing tells the caller. Qianmu keeps per-chat state in chat metadata and writes it
// at the end of a generation, exactly when such a skip is most likely, so a refresh before the next
// ordinary save would silently drop that turn's state.
//
// This layer only watches: when a save comes back marked skipped, it asks ST to save the same chat once
// more shortly afterwards. It never alters a request or a response, never blocks or delays the original
// caller, and does nothing at all when saves are answered natively.
const SAVE_PATH = '/api/chats/save';

export function createChatSaveFollowup({ fetchImpl, getContext, isEnabled = () => true, baseUrl = globalThis.location?.origin,
  schedule = setTimeout, cancel = clearTimeout, delay = 350, onFollowup = () => {} } = {}) {
  if (typeof fetchImpl !== 'function' || typeof getContext !== 'function') throw new TypeError('Chat save follow-up needs fetch and context accessors.');
  let timer = null, pendingChat = null, following = false, disposed = false, written = 0;

  const chatId = () => { try { const id = getContext()?.chatId; return id == null ? '' : String(id); } catch { return ''; } };
  function isChatSave(input, init) {
    try {
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (method !== 'POST') return false;
      const url = new URL(typeof input === 'string' ? input : input?.url || String(input), baseUrl || 'http://localhost');
      return url.pathname === SAVE_PATH && (!baseUrl || url.origin === new URL(baseUrl).origin);
    } catch { return false; }
  }
  async function wasSkipped(response) {
    try {
      if (!response?.ok || typeof response.clone !== 'function') return false;
      if (!/json/i.test(response.headers?.get?.('content-type') || '')) return false;
      const data = await response.clone().json();
      return data?.skipped === true;
    } catch { return false; }
  }
  function plan(chat) {
    if (disposed || !chat) return;
    pendingChat = chat; const seen = written;
    cancel(timer);
    timer = schedule(async () => {
      timer = null;
      const target = pendingChat; pendingChat = null;
      // A real write of this chat landed in the meantime, or the user moved to another chat: nothing owed.
      if (disposed || !isEnabled() || written !== seen || chatId() !== target) return;
      const save = getContext()?.saveChat;
      if (typeof save !== 'function') return;
      following = true;
      try { await save(); onFollowup({ chatId: target }); }
      catch { /* ST reports its own save failures; the next ordinary save still carries the state. */ }
      finally { following = false; }
    }, delay);
  }
  async function fetch(input, init) {
    const response = await Reflect.apply(fetchImpl, this, arguments);
    if (disposed || !isEnabled() || !isChatSave(input, init)) return response;
    const chat = chatId();
    // Our own follow-up is never followed up again, so two layers can never ping-pong.
    const own = following;
    void wasSkipped(response).then(skipped => {
      if (!skipped) { if (response.ok) written += 1; return; }
      if (!own) plan(chat);
    });
    return response;
  }
  return Object.freeze({ fetch, dispose() { disposed = true; cancel(timer); timer = null; pendingChat = null; } });
}
