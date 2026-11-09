// Shared only by guarded host-save coordinators. Not a server/CAS lock and not
// protection against unrelated host/extensions. Keep ownership until an issued
// host promise settles, even after a UI timeout or a closed session.
const active = new WeakMap();
export function acquireChatSaveLock(store, token) {
  if (active.has(store) && active.get(store) !== token) return false;
  active.set(store, token); return true;
}
export function releaseChatSaveLock(store, token) { if (active.get(store) === token) active.delete(store); }
