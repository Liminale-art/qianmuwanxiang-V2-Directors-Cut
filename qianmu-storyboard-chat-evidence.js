import { vibeDigest } from './qianmu-vibe-file.js';
import { hashText } from './qianmu-storyboard-utils.js';
import { createStoryboardMessageReference } from './qianmu-storyboard.js';

export const STORYBOARD_CHAT_EVIDENCE_SCHEMA = 'qianmu.storyboard.chat-evidence.v1';
const MAX_MESSAGES = 100000, MAX_TEXT_BYTES = 128 * 1048576;
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_chat_evidence', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, fields) => object(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
const chat = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const hash = (value, length = 64) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const scalar = (value, fallback = '') => { if (value == null) return fallback; if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return String(value); fail('正文来源字段格式不支持，未省略后继续'); };

// Project only narrative identity fields before crossing into a worker. No extensions, credentials, hidden swipes or full ST objects.
export function projectStoryboardChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) fail('正文来源列表无效或超过十万层，请保留原聊天');
  return Array.from(messages, message => {
    if (!object(message) || message.mes != null && typeof message.mes !== 'string') fail('正文来源条目不完整');
    const swipeId = message.swipe_id ?? 0;
    if (!Number.isSafeInteger(swipeId) || swipeId < 0) fail('正文候选版本无效');
    return { mes: message.mes ?? '', name: scalar(message.name), is_user: message.is_user === true, is_system: message.is_system === true,
      swipe_id: swipeId, original_avatar: scalar(message.original_avatar), send_date: scalar(message.send_date) };
  });
}
export function storyboardChatProjectionMatches(projected, messages) {
  const current = projectStoryboardChatMessages(messages);
  return projected.length === current.length && projected.every((row, index) => Object.keys(row).every(key => row[key] === current[index][key]));
}
export async function captureStoryboardChatEvidence(messages, chatKey, { guard = async () => {} } = {}) {
  if (!chat(chatKey)) fail('正文来源聊天标识无效');
  const projected = projectStoryboardChatMessages(messages), rows = []; let bytes = 0; await guard();
  for (const [floor, message] of projected.entries()) {
    const serialized = new TextEncoder().encode(JSON.stringify(message)); bytes += serialized.byteLength;
    if (bytes > MAX_TEXT_BYTES) fail('正文来源核对超过 128 MiB，未截断聊天或生成不完整证据');
    rows.push({ floor, sha256: await vibeDigest(serialized), messageHash: hashText(message.mes),
      revisionHash: createStoryboardMessageReference({ message, floor, chatKey, now: 1 }).revisionHash, swipeId: message.swipe_id });
  }
  const core = { schema: STORYBOARD_CHAT_EVIDENCE_SCHEMA, chatKey, messages: rows };
  const digest = await vibeDigest(JSON.stringify(core)); await guard(); return { ...core, digest };
}
export async function inspectStoryboardChatEvidence(value, chatKey = value?.chatKey) {
  if (!keys(value, ['schema', 'chatKey', 'messages', 'digest']) || value.schema !== STORYBOARD_CHAT_EVIDENCE_SCHEMA || !chat(value.chatKey) || value.chatKey !== chatKey
    || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES || !hash(value.digest)) fail('正文来源证据版本、范围或摘要无效');
  const rows = Array.from(value.messages, (row, floor) => {
    if (!keys(row, ['floor', 'sha256', 'messageHash', 'revisionHash', 'swipeId']) || row.floor !== floor || !hash(row.sha256) || !hash(row.messageHash, 8)
      || !hash(row.revisionHash, 8) || !Number.isSafeInteger(row.swipeId) || row.swipeId < 0) fail('正文来源证据包含重复、缺失或无效楼层');
    return { ...row };
  });
  const core = { schema: STORYBOARD_CHAT_EVIDENCE_SCHEMA, chatKey: value.chatKey, messages: rows };
  if (await vibeDigest(JSON.stringify(core)) !== value.digest) fail('正文来源证据内容摘要不符');
  return { ...core, digest: value.digest };
}

// The evidence is a capture-time baseline, not proof that an old image was originally generated from that paragraph.
// Missing historical anchors remain unverified; duplicate content is never resolved by the old floor number.
export function createStoryboardEvidenceLinkResolver(source, target) {
  const positions = new Map();
  for (const row of target.messages) { const list = positions.get(row.sha256) || []; list.push(row.floor); positions.set(row.sha256, list); }
  return record => {
    if (record.restoreLinkReview) return null;
    const floor = Number.isInteger(record.floor) ? record.floor : record.messageRef?.lastKnownFloor;
    const row = source.messages[floor]; if (!row) return null;
    const referenceHash = record.messageRef?.revisionHash, legacyHash = record.messageHash;
    if (!referenceHash && !legacyHash || referenceHash && referenceHash !== row.revisionHash || legacyHash && legacyHash !== row.messageHash) return null;
    if (Number(record.swipeId ?? record.messageRef?.swipeId ?? 0) !== row.swipeId) return null;
    const candidates = positions.get(row.sha256) || []; return candidates.length === 1 ? candidates[0] : null;
  };
}
