// Shared by the two media clients. Their public operations return promises;
// close stays synchronous and does not pretend pending operations have settled.
export function trackClientActivity(client) {
  let pending = 0; const active = new Map();
  for (const [name, action] of Object.entries(client)) {
    if (name === 'close' || typeof action !== 'function') continue;
    client[name] = async function (...args) {
      pending++; active.set(name, (active.get(name) || 0) + 1);
      try { return await action.apply(this, args); }
      finally { pending--; const count = active.get(name) - 1; count ? active.set(name, count) : active.delete(name); }
    };
  }
  Object.defineProperty(client, 'busy', { get: () => pending > 0 });
  // A cleanup may exclude its own maintenance call, never other client work.
  Object.defineProperty(client, 'busyExcept', { value: name => pending > (active.get(name) || 0) });
  return client;
}
