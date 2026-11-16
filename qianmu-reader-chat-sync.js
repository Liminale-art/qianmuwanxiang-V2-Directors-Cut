// 伴读对话（陪读会话：消息、总结、游标）跟随 ST 账户走。
//
// The companion conversations live in this browser's IndexedDB, keyed `scope::bookId`. The bookshelf itself
// (book ids, progress) is in ST settings and already follows the account, so on a second device the books
// were listed but their conversations were missing. Each conversation is mirrored to one ST account file by
// the shared engine in qianmu-account-mirror.js (rules there: nothing is ever deleted remotely, the side
// that changed wins, and when both changed the later write wins while the other is kept locally).
// IndexedDB stays the working copy; nothing else in the reader changes.
import { createAccountMirror, accountMirrorSlot, portableJson } from './qianmu-account-mirror.js';

export const READER_CHAT_INDEX_SLOT = 'reader-chats';
const SLOT_PREFIX = 'reader-chat-';
export const readerChatSlot = key => accountMirrorSlot(SLOT_PREFIX, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = record => (Number.isFinite(Number(record?.updatedAt)) ? Number(record.updatedAt) : 0);

export function createReaderChatSync({ store, ...options } = {}) {
  const mirror = createAccountMirror({
    ...options, store, name: 'reader-chat', label: '伴读对话', indexSlot: READER_CHAT_INDEX_SLOT, slotPrefix: SLOT_PREFIX,
    token: stamp, order: stamp,
    encode: async record => portableJson(record),
    decode: async text => { try { const record = JSON.parse(text); return plain(record) ? record : null; } catch { return null; } },
  });
  // The two calls the reader makes go through here, so it needs no knowledge of the mirror.
  const get = async key => { await mirror.refresh(key); return store.get(key); };
  const put = async (key, record) => { const result = await store.put(key, record); mirror.request(key); return result; };
  return Object.freeze({ ...mirror, get, put });
}
