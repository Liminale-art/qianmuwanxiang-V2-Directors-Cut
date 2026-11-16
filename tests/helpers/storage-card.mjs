import { renderStorageCard } from '../../qianmu-storage-card.js';

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Renders the data-management card from loose inputs: a partial inventory is
// completed with neutral totals so a test only spells out the part it checks.
export function renderStorageBackupSection(_notes, format = value => `${value} B`, { data, ready = false, scanning = false } = {}) {
  const full = data ? { sampledAt: 1, origin: { available: false }, trackedBytes: 0, categories: [], ...data } : null;
  return renderStorageCard({ state: { status: scanning ? 'loading' : ready ? 'ready' : full ? 'stale' : 'idle', data: full }, format, escape });
}
