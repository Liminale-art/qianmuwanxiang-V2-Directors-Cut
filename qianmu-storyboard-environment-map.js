import { sourceIdentityResponse, sourceIdentityForNamespace, sourceIdentityLabelsMatch } from './qianmu-source-identity-contract.js';
import { comfyLibraryBackupDigest as digest } from './qianmu-comfy-library-backup.js';

// An explicit installation-label mapping, NOT account/subject rebinding or identity authentication.
export const STORYBOARD_ENVIRONMENT_MAP_SCHEMA = 'qianmu.storyboard.environment-map.v1';
export const STORYBOARD_ENVIRONMENT_MAP_LIMIT = 256;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw Object.assign(new Error('环境映射凭据不完整，请保留原包重新核对'), { code: 'storyboard_environment_map' }); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
export function validStoryboardEnvironmentReview(value) {
  try {
    if (!exact(value, ['schema','namespace','chatHash','sourceDigest','source','target','state','digest']) || value.schema !== STORYBOARD_ENVIRONMENT_MAP_SCHEMA
      || typeof value.namespace !== 'string' || !/^st-user:.+/.test(value.namespace) || value.namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(value.namespace)
      || !hash(value.chatHash) || !hash(value.sourceDigest) || !hash(value.digest)) return false;
    const source = sourceIdentityResponse(value.source), target = sourceIdentityResponse(value.target);
    return source.state === 'ready' && target.state === 'ready' && source.expectedAccount === target.expectedAccount
      && value.state === (sourceIdentityLabelsMatch(source, target) ? 'matched' : 'mapping-required');
  } catch (_) { return false; }
}
export async function createStoryboardEnvironmentReview({ namespace, chatHash, sourceDigest, source, target }) {
  const value = { schema: STORYBOARD_ENVIRONMENT_MAP_SCHEMA, namespace, chatHash, sourceDigest,
    source: await sourceIdentityForNamespace(source, namespace), target: await sourceIdentityForNamespace(target, namespace) };
  value.state = sourceIdentityLabelsMatch(value.source, value.target) ? 'matched' : 'mapping-required';
  value.digest = await digest(value);
  if (!validStoryboardEnvironmentReview(value)) fail();
  return value;
}
export function storyboardEnvironmentReviewsEqual(a, b) {
  return validStoryboardEnvironmentReview(a) && validStoryboardEnvironmentReview(b)
    && ['namespace','chatHash','sourceDigest','state','digest'].every(key => a[key] === b[key])
    && sourceIdentityLabelsMatch(a.source, b.source) && sourceIdentityLabelsMatch(a.target, b.target);
}
export async function inspectStoryboardEnvironmentReview(value) {
  if (!validStoryboardEnvironmentReview(value)) fail();
  const expected = await createStoryboardEnvironmentReview(value);
  if (expected.digest !== value.digest) fail();
  return expected;
}
export function validateStoryboardEnvironmentReceipt(row) {
  if (!exact(row, ['key','namespace','review','createdAt']) || !validStoryboardEnvironmentReview(row.review) || row.review.state !== 'mapping-required'
    || row.namespace !== row.review.namespace || row.key !== row.review.digest || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) fail();
  return row;
}
