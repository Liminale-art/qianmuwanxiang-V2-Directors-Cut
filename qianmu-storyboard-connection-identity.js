import { getStoryboardProvider, normalizeStoryboardConnectionProfile, resolveStoryboardConnectionBinding } from './qianmu-storyboard.js';
import { assertPortableConnection, assertPortableConnectionUrl } from './qianmu-portable-connection.js';
export { assertPortableConnection, assertPortableConnectionUrl };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_connection_identity', submissionState: 'not_submitted' }); };
const canonical = value => JSON.stringify(value, (_, row) => object(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key,row[key]])) : row);

// Credential ownership depends on the whole transport contract, not merely an endpoint or a reused display ID.
// Model and display name are intentionally excluded: connection presets belong to provider families.
export function storyboardConnectionTarget(value, providerId) {
  const provider = getStoryboardProvider(providerId); if (!provider) fail('连接渠道无法确认');
  if (!object(value) || value.providerId && value.providerId !== providerId) fail('连接声明的渠道不一致');
  const row = normalizeStoryboardConnectionProfile(value, providerId);
  resolveStoryboardConnectionBinding(providerId, row);
  return { providerId, baseUrl: row.baseUrl, protocol: row.protocol ?? provider.protocol,
    imageProtocolVersion: row.imageProtocolVersion ?? null, modelFamily: row.modelFamily ?? providerId,
    // Retain the full declared public transport options for ownership checks, even if today's normalizer ignores some.
    headers: value.headers ?? {}, options: value.options ?? {}, compatibility: row.compatibility ?? null };
}

// A display-only review; never send authorization values, credential IDs or header/option values to the view.
export function storyboardConnectionRestoreReview(previous, incoming, providerId, { retained = false, active = false } = {}) {
  let before = null, after = null;
  try { if (previous) before = storyboardConnectionTarget(previous, providerId); after = storyboardConnectionTarget(incoming, providerId); } catch (_) {}
  const same = storyboardConnectionsShareTarget(previous, incoming, providerId);
  const fields = ['baseUrl','protocol','imageProtocolVersion','modelFamily','headers','options','compatibility'];
  const differences = previous ? before && after ? fields.filter(key => canonical(before[key]) !== canonical(after[key])) : ['unverified'] : [];
  if (previous && !same && !differences.length) differences.push('unverified');
  return { providerId, presetId: incoming.id, name: incoming.name || incoming.id, state: !previous ? 'added' : same ? 'same' : 'changed',
    credential: retained ? 'retained' : 'required', active: Boolean(active), differences };
}

export function validStoryboardConnectionReview(rows) {
  const fields = ['providerId','presetId','name','state','credential','active','differences'], seen = new Set();
  return Array.isArray(rows) && rows.length <= 300 && rows.every(row => {
    if (!object(row) || Object.keys(row).some(key => !fields.includes(key)) || !getStoryboardProvider(row.providerId)
      || typeof row.presetId !== 'string' || !row.presetId || row.presetId.length > 160 || typeof row.name !== 'string' || row.name.length > 160
      || !['added','same','changed'].includes(row.state) || !['retained','required'].includes(row.credential)
      || row.credential === 'retained' && row.state !== 'same' || typeof row.active !== 'boolean'
      || !Array.isArray(row.differences) || row.differences.length > 8 || row.differences.some(key => !['baseUrl','protocol','imageProtocolVersion','modelFamily','headers','options','compatibility','unverified'].includes(key))) return false;
    const key = JSON.stringify([row.providerId,row.presetId]); if (seen.has(key)) return false; seen.add(key); return true;
  });
}
export function storyboardConnectionsShareTarget(left, right, providerId) {
  if (!left || !right) return false;
  // Ignore only the dedicated local credential reference, not additional nested credential fields or signed URLs.
  try {
    assertPortableConnection({ ...left, credentialId: '' }); assertPortableConnection({ ...right, credentialId: '' });
    return canonical(storyboardConnectionTarget(left,providerId)) === canonical(storyboardConnectionTarget(right,providerId));
  } catch (_) { return false; }
}
