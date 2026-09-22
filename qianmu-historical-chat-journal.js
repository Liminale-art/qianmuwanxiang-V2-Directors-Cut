import { chatCharacterReceiptTarget } from './qianmu-chat-character-receipt.js';
import { chatGalleryReceiptText } from './qianmu-chat-gallery-receipt.js';
import { projectChatGalleryState } from './qianmu-chat-gallery-state.js';
import { inspectStoryboardChatEvidence } from './qianmu-storyboard-chat-evidence.js';
import { assertJsonInputBounds } from './qianmu-json-input.js';
import { vibeDigest } from './qianmu-vibe-file.js';
import { inspectGalleryWriteProposal,GALLERY_WRITE_PROPOSAL_KIND } from './qianmu-gallery-write-proposal.js';

const fields = ['storyboardImages', 'storyboardCollections', 'characterDrafts'];
const phases = ['prepared', 'submitted', 'uncertain', 'verified'];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const account = value => typeof value === 'string' && /^st-user:.+/.test(value) && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const fail = message => { throw Object.assign(new Error(message), { code: 'historical_chat_journal', submissionState: 'not_submitted' }); };
export const HISTORICAL_CHAT_JOURNAL_BYTES = 32 * 1048576;

// Synchronously detach BEFORE async digest/credential validation. Never normalize
// original draft records, serialize a whole host context, or keep narrative text.
export async function inspectHistoricalChatSaveProposal(input) {
  if (input?.kind === GALLERY_WRITE_PROPOSAL_KIND) return inspectGalleryWriteProposal(input);
  if (!exact(input, ['namespace', 'target', 'before', 'after', 'chatEvidence', 'fileHash']) || !account(input.namespace) || !hash(input.fileHash)) fail('原聊天保存记录范围无效');
  const target = chatCharacterReceiptTarget(input.target);
  for (const saved of [input.before, input.after]) {
    if (!object(saved) || !Object.hasOwn(saved, 'storyboardImages') || Object.keys(saved).some(key => !fields.includes(key))) fail('恢复记录只允许画面、相册与人物草稿');
    chatGalleryReceiptText([{ value: saved }]);
  }
  if (Object.keys(input.before).some(key => !Object.hasOwn(input.after, key))) fail('恢复记录不能删除原聊天资料字段');
  // Evidence is digest-only. Its inspector rejects extra fields and holes; clone
  // now prevents changes to the caller's evidence during validation awaits.
  const proposal = structuredClone({ namespace: input.namespace, target, before: input.before, after: input.after,
    chatEvidence: input.chatEvidence, fileHash: input.fileHash });
  assertJsonInputBounds(JSON.stringify(proposal), { maxBytes: HISTORICAL_CHAT_JOURNAL_BYTES, maxDepth: 44, maxNodes: 1200000, label: '原聊天保存记录' });
  const owner = { namespace: proposal.namespace, chatKey: target.chatId };
  for (const saved of [proposal.before, proposal.after]) await projectChatGalleryState(saved, owner);
  proposal.chatEvidence = await inspectStoryboardChatEvidence(proposal.chatEvidence, target.chatId);
  return proposal;
}

export function validateHistoricalChatMutationEnvelope(row) {
  if (!exact(row, ['version', 'namespace', 'proposal', 'proposalDigest', 'phase', 'revision', 'createdAt', 'updatedAt']) || row.version !== 1 || !account(row.namespace)
    || !hash(row.proposalDigest) || !phases.includes(row.phase) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt
    || row.proposal?.namespace !== row.namespace) fail('原聊天待核对记录损坏，请保留原件');
  return row;
}
export async function createHistoricalChatMutation(input, { now = Date.now } = {}) {
  const proposal = await inspectHistoricalChatSaveProposal(input), stamp = now();
  return validateHistoricalChatMutationEnvelope({ version: 1, namespace: proposal.namespace, proposal,
    proposalDigest: await vibeDigest(JSON.stringify(proposal)), phase: 'prepared', revision: 1, createdAt: stamp, updatedAt: stamp });
}
export async function inspectHistoricalChatMutation(input) {
  const row = structuredClone(validateHistoricalChatMutationEnvelope(input));
  const proposal = await inspectHistoricalChatSaveProposal(row.proposal);
  if (await vibeDigest(JSON.stringify(proposal)) !== row.proposalDigest) fail('原聊天待核对内容与保存摘要不符');
  return { ...row, proposal };
}
export function historicalChatMutationNext(row, phase, stamp) {
  validateHistoricalChatMutationEnvelope(row);
  // An explicitly confirmed retry claims a new revision even if the previous
  // attempt was submitted. A stale page must not bypass the journal CAS.
  const allowed = { prepared: ['submitted', 'uncertain', 'verified'], submitted: ['submitted', 'uncertain', 'verified'], uncertain: ['submitted', 'verified'], verified: [] };
  if (!allowed[row.phase].includes(phase)) fail('原聊天核对阶段不能跳过或倒退');
  return validateHistoricalChatMutationEnvelope({ ...row, phase, revision: row.revision + 1, updatedAt: Math.max(stamp, row.updatedAt) });
}
// Journal phases are local observations, NOT a server receipt or retry authority.
// Refresh recovery must recheck exact account/target, live data and saved evidence.
