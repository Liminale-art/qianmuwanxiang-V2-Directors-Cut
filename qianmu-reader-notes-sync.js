// 伴读笔记（划线、批注、书签）跟随 ST 账户走。
//
// 笔记原来放在 settings.coread.books[].notes，随整份 ST 设置上传：每划一次线就上传一次整份设置，书多了设置
// 文件越来越大。现在一本书一条记录存在本机 IndexedDB（reader_notes，键是书的编号），由 qianmu-account-mirror.js
// 镜像到一份 ST 账户文件，跨设备照旧能看到。规则沿用那里：哪边改过听哪边；两边都改过，较晚写入（updatedAt）
// 的一份生效，另一份留在本机「冲突」仓里。删书时阅读器调 remove([bookId])，其他设备一并删掉。
// 时延：开书时取回较新的一份，写入后排一轮上传。
import { createAccountMirror, accountMirrorSlot, portableJson } from './qianmu-account-mirror.js';

export const READER_NOTES_INDEX_SLOT = 'reader-notes';
const SLOT_PREFIX = 'reader-notes-';
export const readerNotesSlot = bookId => accountMirrorSlot(SLOT_PREFIX, bookId);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = record => (Number.isFinite(Number(record?.updatedAt)) ? Number(record.updatedAt) : 0);

/** `store`：{ listKeys(), get(bookId), put(bookId, record), delete(bookId) }，即本机的 reader_notes。 */
export function createReaderNotesSync({ store, ...options } = {}) {
  const mirror = createAccountMirror({
    ...options, store, name: 'reader-notes', label: '伴读笔记', indexSlot: READER_NOTES_INDEX_SLOT, slotPrefix: SLOT_PREFIX,
    token: stamp, order: stamp,
    encode: async record => portableJson(record),
    decode: async text => { try { const record = JSON.parse(text); return plain(record) && Array.isArray(record.notes) ? record : null; } catch { return null; } },
  });
  const put = async (bookId, record) => { const result = await store.put(bookId, record); mirror.request(bookId); return result; };
  /** 立刻同步这一本，返回账户里是否已经是本机这一份（迁移只在它为真之后才算完成）。 */
  const confirm = async bookId => {
    if (!bookId) return false;
    try {
      for (let round = 0; round < 2; round++) {
        await mirror.run([String(bookId)]);
        if (await mirror.synced(bookId)) return true;
      }
    } catch (error) { console.warn('[千幕] 伴读笔记未能确认已上传，下次开书再试', error?.message || error); }
    return false;
  };
  return Object.freeze({ ...mirror, put, confirm });
}
