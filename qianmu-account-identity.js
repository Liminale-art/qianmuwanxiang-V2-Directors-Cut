// Account identity is shared by ordinary tools as well as image generation.
// Keep this entry independent of admission ledgers, narrative/stream contracts
// and other feature graphs. It never caches a user or grants permission itself.
const error = (code, message) => Object.assign(new Error(message), { code: `image_attempt_${code}` });

// Read the actual ST account, never a character/persona name. In account mode
// user.js's default handle is also used while loading, so it is not sufficient.
export async function resolveImageAccountNamespace({ loadUser = () => import('/scripts/user.js'), fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  let handle, expired = false, timer;
  const controller = new AbortController();
  const deadline = new Promise(resolve => { timer = setTimeout(() => { expired = true; controller.abort(); resolve(null); }, Math.max(100, Math.min(15000, Number(timeoutMs) || 6000))); });
  try {
    const userModule = await Promise.race([Promise.resolve().then(loadUser).catch(() => null), deadline]);
    handle = userModule?.currentUser?.handle;
    // accountsEnabled starts as false before ST initializes it. Missing user
    // data therefore always requires a verified authenticated response.
    if (!handle && !expired) {
      const response = await Promise.race([fetchImpl('/api/users/me', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }), deadline]);
      if (response?.ok) handle = (await Promise.race([response.json(), deadline]))?.handle;
    }
  } catch (_) { /* Do not invent a shared identity on auth/network failure. */ }
  finally { clearTimeout(timer); }
  if (typeof handle !== 'string' || !handle.trim() || handle.length > 160 || /[\u0000-\u001f]/.test(handle)) throw error('account', '暂未确认当前 ST 账户，未提交生图，请稍后重试');
  return `st-user:${handle}`;
}
