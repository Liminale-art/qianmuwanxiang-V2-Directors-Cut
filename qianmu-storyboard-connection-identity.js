import { getStoryboardProvider, normalizeStoryboardConnectionProfile, resolveStoryboardConnectionBinding } from './qianmu-storyboard.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_connection_identity', submissionState: 'not_submitted' }); };
const folded = value => String(value).replace(/[^a-z0-9]/gi,'').toLowerCase();
const sensitive = name => /(?:apikey|apitoken|accesskey|authorization|cookie|accesstoken|refreshtoken|clientsecret|password|credentialid|grantid|sharedsecret|bearertoken)/.test(folded(name)) || /^(?:token|auth|secret|secretkey)$/.test(folded(name));
const canonical = value => JSON.stringify(value, (_, row) => object(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key,row[key]])) : row);

export function assertPortableConnectionUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) fail('连接地址格式不支持安全备份');
  if (!value) return;
  let parsed; try { parsed = new URL(value); } catch (_) { fail('连接地址须为完整 HTTP(S) 地址，请先核对'); }
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) fail('连接地址含内嵌身份或片段，未写入无凭据备份，请使用独立 Key 输入框');
  for (const key of parsed.searchParams.keys()) if (sensitive(key) || /^(?:key|token|auth|signature|sig|code|secret)$/.test(folded(key)) || /(?:signature|credential)$/.test(folded(key))) fail('连接地址含授权查询参数，未写入无凭据备份，请使用独立 Key 输入框');
}

export function assertPortableConnection(value) {
  if (!object(value)) fail('连接资料格式无效'); let nodes = 0;
  function scan(item, depth = 0, headers = false) {
    if (++nodes > 20000 || depth > 20) fail('连接资料结构过大');
    if (!item || typeof item !== 'object') return;
    for (const [key, next] of Object.entries(item)) {
      if ((sensitive(key) || headers && /(?:token|secret|auth)$/.test(folded(key))) && next !== '' && next !== null && next !== undefined) fail('连接包含结构化连接凭据或授权，未写入备份；请先在原设置中单独保全授权');
      if (['baseurl','apiurl','comfyurl'].includes(folded(key)) && next != null) assertPortableConnectionUrl(next);
      if (['headers','customheaders'].includes(folded(key)) && next != null && !object(next)) fail('自定义请求头格式不透明，未写入无凭据备份');
      scan(next, depth + 1, ['headers','customheaders'].includes(folded(key)));
    }
  }
  scan(value); return true;
}

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
