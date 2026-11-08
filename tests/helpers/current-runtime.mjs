import {readdirSync,readFileSync} from 'node:fs';
import manifest from '../../manifest.json' with {type: 'json'};

// Match release-qualified production imports so private receipts, frames and
// pending writes are observed through the same ESM instance as their consumers.
// Unchanged modules keep the stamp of the release that last touched them, so the
// address is read from the production importers rather than the manifest version.
// Unversioned and intentionally pinned production imports stay explicit in tests.
const root = new URL('../../', import.meta.url);
const sources = readdirSync(root).filter(file => /^qianmu-.*\.js$/.test(file) || file === 'index.js')
    .map(file => readFileSync(new URL(file, root), 'utf8'));
const stamps = new Map();
const productionStamp = file => {
    if (stamps.has(file)) return stamps.get(file);
    const found = new Set();
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?:from\\s+|import\\(\\s*)['"]\\./${escaped}\\?v=([^'"]+)['"]`, 'g');
    for (const source of sources) for (const [, stamp] of source.matchAll(pattern)) found.add(stamp);
    // A split (more than one stamp) is reported by current-runtime-identity.
    const stamp = found.size === 1 ? [...found][0] : manifest.version;
    stamps.set(file, stamp);
    return stamp;
};
export const currentRuntimeUrl = file => new URL(`../../${file}?v=${productionStamp(file)}`, import.meta.url);
export const importCurrentRuntime = file => import(currentRuntimeUrl(file));
