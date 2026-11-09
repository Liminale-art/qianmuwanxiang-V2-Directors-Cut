// Internal, ledger-only observation of one sealed NAI shot. This is neither a
// submission decision nor a statement that a missing row was never charged.
// Only server code may supply the four fields from a verified sealed snapshot;
// never pass an HTTP body or a client-computed digest directly to this method.
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { normalizeImageServiceChannel } from './qianmu-image-service-queue.js';

const SCHEMA = 'qianmu.storyboard-novel-shot-evidence.v1';
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^st-user:[a-f0-9]{64}$/;
const ATTEMPT = /^shotjob-[0-9a-z]{1,11}-[0-9a-z]{1,4}-(?:[a-f0-9]{8}|[0-9a-z]{1,7})$/;
const FIELDS = ['expectedAccount', 'channelKey', 'attemptId', 'requestDigest'];
const OBSERVATION = Object.freeze({
  reserved: 'reserved_record',
  submitting: 'acceptance_unknown',
  uncertain: 'acceptance_unknown',
  acknowledged: 'needs_review',
  succeeded: 'callback_completed',
  failed: 'needs_review',
  rejected: 'settled_unverified',
  released: 'settled_unverified',
});
const refusal = (code, message, status = 400) => Object.assign(new Error(message), {
  name: 'StoryboardNovelShotEvidenceError', code: `storyboard_novel_shot_evidence_${code}`,
  status,
});
const observed = (observation, ledgerStatus) => Object.freeze({
  schema: SCHEMA, scope: 'ledger_only', observation,
  ...(ledgerStatus ? { ledgerStatus } : {}),
});
function exactIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== FIELDS.length
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !FIELDS.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
    || !ACCOUNT.test(value.expectedAccount) || !HASH.test(value.channelKey)
    || !HASH.test(value.requestDigest) || !ATTEMPT.test(value.attemptId)) {
    throw refusal('identity', 'NAI 镜头核对身份无效');
  }
  return Object.freeze({ expectedAccount: value.expectedAccount, channelKey: value.channelKey,
    attemptId: value.attemptId, requestDigest: value.requestDigest });
}

export async function inspectStoryboardNovelShotLedger(request, sealedIdentity, { store } = {}) {
  let account;
  try { account = imageServiceAccount(request); }
  catch (_) { throw refusal('authentication_required', '请先登录 ST 账户再核对原镜头', 401); }
  const identity = exactIdentity(sealedIdentity);
  const unchanged = () => {
    try {
      const latest = exactIdentity(sealedIdentity);
      return FIELDS.every(field => latest[field] === identity[field]);
    } catch (_) { return false; }
  };
  if (identity.expectedAccount !== account.namespace) {
    throw refusal('account_changed', 'ST 账户与封存镜头不符', 401);
  }
  if (typeof store?.inspectChannel !== 'function') {
    throw refusal('storage', 'NAI 原任务记录不可用', 503);
  }
  let state;
  try {
    state = normalizeImageServiceChannel(await store.inspectChannel(identity.channelKey), identity.channelKey);
  } catch (_) {
    if (!imageServiceAccountStillMatches(request, account)) {
      throw refusal('account_changed', 'ST 账户在核对期间已变化', 401);
    }
    // A damaged, missing-to-reader, or unavailable ledger never proves a safe replay.
    return observed('needs_review');
  }
  if (!imageServiceAccountStillMatches(request, account)) {
    throw refusal('account_changed', 'ST 账户在核对期间已变化', 401);
  }
  if (!unchanged()) return observed('needs_review');
  const row = state.entries.find(item => item.namespace === account.namespace && item.attemptId === identity.attemptId);
  // Other accounts on the same NAI connection are indistinguishable from an
  // absent owned row. Absence is an observation, not proof of no submission.
  if (!row) return observed('no_owned_record');
  if (row.requestDigest !== identity.requestDigest) return observed('needs_review');
  return observed(OBSERVATION[row.status] || 'needs_review', row.status);
}
