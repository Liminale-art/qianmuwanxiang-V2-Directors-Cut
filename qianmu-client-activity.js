// Shared by the two media clients. Their public operations return promises;
// close stays synchronous and does not pretend pending operations have settled.
export function trackClientActivity(client) {
  let pending = 0;
  for (const [name, action] of Object.entries(client)) {
    if (name === 'close' || typeof action !== 'function') continue;
    client[name] = async function (...args) {
      pending++;
      try { return await action.apply(this, args); }
      finally { pending--; }
    };
  }
  Object.defineProperty(client, 'busy', { get: () => pending > 0 });
  return client;
}
