import { inspectHistoricalStoryboardSource } from './qianmu-historical-storyboard-bundle.js';
import { projectChatGalleryState, CHAT_GALLERY_STATE_LIMITS } from './qianmu-chat-gallery-state.js';
import { chatGalleryReceiptText } from './qianmu-chat-gallery-receipt.js';
import { chatCharacterReceiptTarget, chatCharacterCollectionReceiptText } from './qianmu-chat-character-receipt.js';
import { inspectStoryboardChatEvidence } from './qianmu-storyboard-chat-evidence.js';
import { vibeDigest } from './qianmu-vibe-file.js';

const fields = ['storyboardImages', 'storyboardCollections', 'characterDrafts'];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = value => chatGalleryReceiptText([value]).text;
const equal = (left, right) => text({ value: left }) === text({ value: right });
const fail = message => { throw Object.assign(new Error(message), { code: 'historical_storyboard_merge', submissionState: 'not_submitted' }); };

function indexed(rows, limit, label) {
  if (!Array.isArray(rows) || rows.length > limit) fail(`${label}数量超限，未裁剪合并`);
  const result = new Map();
  for (const row of rows) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 160 || result.has(row.id)) fail(`${label}编号无效或重复，未按名称猜测身份`);
    result.set(row.id, row);
  }
  return result;
}

function mergeRows(local, incoming, { field, limit, conflicts, added }) {
  const result = indexed(local, limit, field), original = indexed(incoming, limit, field);
  for (const [id, row] of original) {
    if (!result.has(id)) { result.set(id, row); added[field]++; }
    else if (!equal(result.get(id), row)) conflicts.push({ field, id, reason: 'different-record' });
  }
  if (result.size > limit) fail(`${field}合并后超限，未丢弃现有或历史资料`);
  return [...result.values()];
}

function mergeDrafts(local, incoming, owner, conflicts, added) {
  if (!local) { added.characterDrafts = incoming.items.length; return incoming; }
  // The validator is only an identity/size check. Never assign its normalized
  // return value: it intentionally omits extension fields from older/future data.
  chatCharacterCollectionReceiptText(local, owner);
  chatCharacterCollectionReceiptText(incoming, owner);
  const before = conflicts.length;
  const items = mergeRows(local.items, incoming.items, { field: 'characterDrafts', limit: 256, conflicts, added });
  const result = { ...local, items };
  let extensionsAdded = false;
  for (const key of Object.keys(incoming)) {
    if (['items', 'revision'].includes(key)) continue;
    if (!Object.hasOwn(local, key)) { Object.defineProperty(result, key, { value: incoming[key], enumerable: true, configurable: true, writable: true }); extensionsAdded = true; }
    else if (!equal(local[key], incoming[key])) conflicts.push({ field: 'characterDrafts', id: null, key, reason: 'different-collection-field' });
  }
  // A higher imported collection counter alone is not an edit or permission to
  // roll back/revive a local rejected character. Changed same-ID drafts conflict.
  if (conflicts.length !== before) return local;
  if (!added.characterDrafts && !extensionsAdded) return local;
  if (local.revision === Number.MAX_SAFE_INTEGER) fail('当前人物列表版本已到上限，未重置版本');
  result.revision = local.revision + 1;
  try { chatCharacterCollectionReceiptText(result, owner); }
  catch { conflicts.push({ field: 'characterDrafts', id: null, reason: 'incompatible-identities-or-size' }); return local; }
  return result;
}

// Detached, all-or-nothing metadata proposal for an eventual SAME CHAT restore.
// No media write, live metadata assignment, library access, host save, or restore
// authorization is performed here. A compatible proposal still requires original
// receipts, full recipe/dependency handling and a durable guarded host transaction.
export async function planHistoricalStoryboardMerge({ source, namespace, target, currentSaved, currentEvidence, guard } = {}) {
  if (typeof guard !== 'function') fail('缺少历史资料合并的账户与页面保护');
  if (!object(currentSaved) || Object.keys(currentSaved).some(key => !fields.includes(key))) fail('仅允许合并当前聊天的分镜原件，不接收全局设置或其他资料');
  // Validate and detach BEFORE the first await; JSON holes/undefined/custom
  // objects must not silently vanish and caller edits cannot redirect this plan.
  text(currentSaved);
  const localInput = structuredClone(currentSaved), evidenceInput = structuredClone(currentEvidence);
  const targetInput = chatCharacterReceiptTarget(target), sourceInput = structuredClone(source);
  if (!equal(targetInput, target)) fail('目标聊天定位包含不支持的字段');
  await guard();
  const original = await inspectHistoricalStoryboardSource(sourceInput, { guard });
  if (original.namespace !== namespace || !equal(original.target, targetInput)) fail('只支持原账户及原角色／群组的同一聊天，未按同名聊天重新归属');
  if (original.selection.ids.length !== original.selection.total) fail('此合并仅接受完整单聊天原件，部分选择不能推定相册与人物恢复范围');
  const evidence = await inspectStoryboardChatEvidence(evidenceInput, targetInput.chatId); await guard();
  if (evidence.digest !== original.chatEvidence.digest) fail('正文或候选版本已变化，未自动重挂历史人物与画面');
  const owner = { namespace, chatKey: targetInput.chatId };
  const before = await projectChatGalleryState({ storyboardImages: [], ...localInput }, owner); await guard();
  if (!Object.hasOwn(localInput, 'storyboardImages')) delete before.storyboardImages;
  const proposed = structuredClone(before), conflicts = [], added = { storyboardImages: 0, storyboardCollections: 0, characterDrafts: 0 };
  for (const [field, limit] of [['storyboardImages', 400], ['storyboardCollections', 120]]) {
    if (Object.hasOwn(original.saved, field)) proposed[field] = mergeRows(before[field] || [], original.saved[field], { field, limit, conflicts, added });
  }
  if (Object.hasOwn(original.saved, 'characterDrafts')) proposed.characterDrafts = mergeDrafts(before.characterDrafts, original.saved.characterDrafts, owner, conflicts, added);
  if (!conflicts.length) {
    // Aggregate limits include UNKNOWN original fields too, not only the
    // normalized collection projection, and no trimming is an acceptable fit.
    await projectChatGalleryState({ storyboardImages: [], ...proposed }, owner); await guard();
    if (new TextEncoder().encode(JSON.stringify(proposed)).byteLength > CHAT_GALLERY_STATE_LIMITS.bytes) fail('合并后原聊天资料超限，未截断');
  }
  const changedFields = conflicts.length ? [] : fields.filter(field => Object.hasOwn(before, field) !== Object.hasOwn(proposed, field)
    || Object.hasOwn(before, field) && !equal(before[field], proposed[field]));
  const plan = {
    schema: 'qianmu.storyboard.historical-merge.v1', namespace, target: targetInput,
    sourceDigest: await vibeDigest(JSON.stringify(original)), evidenceDigest: evidence.digest,
    before, proposedSaved: conflicts.length ? null : proposed, conflicts, changedFields,
    added: conflicts.length ? null : added, compatible: !conflicts.length, restoreSupported: false,
    requiredStages: ['verified-originals', 'recipe-reference-resolution', 'dependency-review', 'durable-host-save'],
  };
  await guard();
  const digest = await vibeDigest(JSON.stringify(plan)); await guard();
  return { ...plan, digest };
}
