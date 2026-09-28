import manifest from '../../manifest.json' with {type: 'json'};

// Match release-qualified production imports so private receipts, frames and
// pending writes are observed through the same ESM instance as their consumers.
// Unversioned and intentionally pinned production imports stay explicit in tests.
export const currentRuntimeUrl = file => new URL(`../../${file}?v=${manifest.version}`, import.meta.url);
export const importCurrentRuntime = file => import(currentRuntimeUrl(file));
