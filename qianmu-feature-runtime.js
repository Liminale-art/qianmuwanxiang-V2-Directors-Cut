function normalizeDefinition(key, definition) {
  if (typeof definition === 'function') {
    return { key, label: key, load: definition };
  }
  if (!definition || typeof definition.load !== 'function') {
    throw new TypeError(`Feature "${key}" must provide a load function.`);
  }
  return {
    key,
    label: String(definition.label || key),
    load: definition.load,
  };
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
  };
}

/**
 * Small session-only boundary for feature chunks. A rejected import is never
 * cached as a permanent failure: the next explicit user action may retry it.
 */
export function createFeatureRuntime(definitions = {}) {
  const entries = new Map(Object.entries(definitions).map(([key, definition]) => {
    const normalized = normalizeDefinition(key, definition);
    return [key, {
      ...normalized,
      status: 'idle',
      attempts: 0,
      loadedAt: 0,
      value: undefined,
      promise: null,
      error: null,
    }];
  }));

  function entryFor(key) {
    const entry = entries.get(key);
    if (!entry) throw new RangeError(`Unknown feature "${key}".`);
    return entry;
  }

  function load(key) {
    const entry = entryFor(key);
    if (entry.status === 'ready') return Promise.resolve(entry.value);
    if (entry.status === 'loading' && entry.promise) return entry.promise;

    entry.status = 'loading';
    entry.attempts += 1;
    entry.error = null;
    entry.promise = Promise.resolve()
      .then(() => entry.load())
      .then((value) => {
        entry.status = 'ready';
        entry.loadedAt = Date.now();
        entry.value = value;
        entry.promise = null;
        return value;
      })
      .catch((error) => {
        entry.status = 'error';
        entry.error = serializeError(error);
        entry.promise = null;
        throw error;
      });
    return entry.promise;
  }

  function snapshot() {
    return [...entries.values()].map((entry) => ({
      key: entry.key,
      label: entry.label,
      status: entry.status,
      attempts: entry.attempts,
      loadedAt: entry.loadedAt,
      error: entry.error ? { ...entry.error } : null,
    }));
  }

  return Object.freeze({ load, snapshot });
}
