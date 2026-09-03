// 千幕 · 通用二进制存储层（IndexedDB）
// 服务 TTS 音频缓存 / 收藏夹；伴读电子书模块复用（书正文/封面/会话/检索日志）。
// 与 index.js 完全解耦：不反向依赖、不读 settings，纯键值存取。
// localStorage 存不下二进制大对象，故独立走 IndexedDB；存 Blob，播放时再 createObjectURL。

const DB_NAME = 'qianmu-blobstore';
const DB_VERSION = 13;
const STORE_AUDIO = 'audio';         // key: 缓存键   value: { blob, meta, createdAt }
const STORE_FAVORITES = 'favorites'; // key: 收藏 id  value: { blob, meta, label, createdAt }
// ── 伴读模块（v2 新增）──
const STORE_BOOKS = 'reader_books';        // key: bookId   value: { meta:{title,author,...}, fullText, chapters:[], createdAt }（重正文，懒取）
const STORE_COVERS = 'reader_covers';      // key: bookId   value: Blob（封面图）
const STORE_CHATS = 'reader_chats';        // key: bucketKey value: { messages:[], summaries:[], cursor, names, updatedAt }（陪读会话）
const STORE_RETLOG = 'reader_retlog';      // key: 自增id    value: { bookId, query, candidates:[], injected:[], at }（检索日志·环形）
// ── 伴读模块（v3 新增）──
const STORE_IMAGES = 'reader_images';      // key: `${bookId}::${n}` value: Blob（书内插图·正文占位符 ⟦img:n⟧ 引用）
// ── 伴读模块（v4 新增）──
const STORE_VECTORS = 'reader_vectors';    // key: bucketKey value: { dim, model, vecs:{ sliceId:[...] }, fps:{ sliceId:指纹 } }（切片嵌入向量·独立于会话·仅变化时写）
// ── 配音模块（v5 新增）──
const STORE_TTS_LINES = 'tts_lines';       // key: chatKey value: { lines:{contentKey:[]}, keyByMes:{mesid:contentKey}, updatedAt }
// ── 便笺模块（v6 新增）──
const STORE_NOTES = 'notes';               // key: noteId value: QianmuNote（只存 pinned=true；临时便笺留在本次页面运行态）
// ── 分镜模块（v7 新增）──
const STORE_STORYBOARD_INBOX = 'storyboard_inbox'; // key: taskId value: 跨聊天完成后等待原聊天接收的轻量成片记录
const STORE_STORYBOARD_PIPELINE_LOGS = 'storyboard_pipeline_logs'; // key: pipelineId value: 已结束的完整生成流水；轻摘要仍留设置
const STORE_STORYBOARD_SNAPSHOTS = 'storyboard_snapshots'; // key: chatKey + recordId value: 阅片记录的完整精确重绘快照
const STORE_STORYBOARD_PLAN_ARCHIVES = 'storyboard_plan_archives'; // key: chatKey + planId value: 已结束分镜计划的完整重数据
// ── 动态镜头模块（v11 新增）──
const STORE_VIDEO_TASKS = 'video_tasks'; // key: taskId value: 轻量异步任务合同；不含密钥、提示词、媒体或结果外链
const STORE_VIDEO_BUDGET = 'video_budget'; // key: reservationId value: 视频费用预留/结算流水
const STORE_VIDEO_MEDIA = 'video_media'; // key: assetId value: 本地成片 Blob + 白名单元数据；不保留远端地址、密钥或提示词
const STORE_VIDEO_DRAFTS = 'video_drafts'; // key: draftId value: 动态镜头本地编辑草稿；只含稳定引用与配置

const STORAGE_STORE_INFO = Object.freeze({
  [STORE_AUDIO]: { label: '语音缓存', category: 'audio', recoverable: true },
  [STORE_FAVORITES]: { label: '语音收藏', category: 'audio', recoverable: false },
  [STORE_BOOKS]: { label: '伴读书籍', category: 'reader', recoverable: false },
  [STORE_COVERS]: { label: '书籍封面', category: 'reader', recoverable: false },
  [STORE_CHATS]: { label: '伴读会话', category: 'reader', recoverable: false },
  [STORE_RETLOG]: { label: '伴读检索日志', category: 'logs', recoverable: true },
  [STORE_IMAGES]: { label: '书内插图', category: 'images', recoverable: false },
  [STORE_VECTORS]: { label: '伴读检索向量', category: 'reader', recoverable: false },
  [STORE_TTS_LINES]: { label: '台词提取缓存', category: 'cache', recoverable: true },
  [STORE_NOTES]: { label: '固定便笺', category: 'notes', recoverable: false },
  [STORE_STORYBOARD_INBOX]: { label: '分镜待归档', category: 'images', recoverable: false },
  [STORE_STORYBOARD_PIPELINE_LOGS]: { label: '分镜详细日志', category: 'logs', recoverable: true },
  [STORE_STORYBOARD_SNAPSHOTS]: { label: '阅片重绘快照', category: 'cache', recoverable: false },
  [STORE_STORYBOARD_PLAN_ARCHIVES]: { label: '分镜历史计划', category: 'cache', recoverable: false },
  [STORE_VIDEO_TASKS]: { label: '动态镜头任务', category: 'video', recoverable: false },
  [STORE_VIDEO_BUDGET]: { label: '视频费用流水', category: 'video', recoverable: false },
  [STORE_VIDEO_MEDIA]: { label: '动态镜头成片', category: 'video', recoverable: false },
  [STORE_VIDEO_DRAFTS]: { label: '动态镜头草稿', category: 'video', recoverable: false },
});

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { dbPromise = null; reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO);
      if (!db.objectStoreNames.contains(STORE_FAVORITES)) db.createObjectStore(STORE_FAVORITES);
      if (!db.objectStoreNames.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS);
      if (!db.objectStoreNames.contains(STORE_COVERS)) db.createObjectStore(STORE_COVERS);
      if (!db.objectStoreNames.contains(STORE_CHATS)) db.createObjectStore(STORE_CHATS);
      if (!db.objectStoreNames.contains(STORE_RETLOG)) db.createObjectStore(STORE_RETLOG, { autoIncrement: true });
      if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES);
      if (!db.objectStoreNames.contains(STORE_VECTORS)) db.createObjectStore(STORE_VECTORS);
      if (!db.objectStoreNames.contains(STORE_TTS_LINES)) db.createObjectStore(STORE_TTS_LINES);
      if (!db.objectStoreNames.contains(STORE_NOTES)) db.createObjectStore(STORE_NOTES);
      if (!db.objectStoreNames.contains(STORE_STORYBOARD_INBOX)) db.createObjectStore(STORE_STORYBOARD_INBOX);
      if (!db.objectStoreNames.contains(STORE_STORYBOARD_PIPELINE_LOGS)) db.createObjectStore(STORE_STORYBOARD_PIPELINE_LOGS);
      if (!db.objectStoreNames.contains(STORE_STORYBOARD_SNAPSHOTS)) db.createObjectStore(STORE_STORYBOARD_SNAPSHOTS);
      if (!db.objectStoreNames.contains(STORE_STORYBOARD_PLAN_ARCHIVES)) db.createObjectStore(STORE_STORYBOARD_PLAN_ARCHIVES);
      if (!db.objectStoreNames.contains(STORE_VIDEO_TASKS)) db.createObjectStore(STORE_VIDEO_TASKS);
      if (!db.objectStoreNames.contains(STORE_VIDEO_BUDGET)) db.createObjectStore(STORE_VIDEO_BUDGET);
      if (!db.objectStoreNames.contains(STORE_VIDEO_MEDIA)) db.createObjectStore(STORE_VIDEO_MEDIA);
      if (!db.objectStoreNames.contains(STORE_VIDEO_DRAFTS)) db.createObjectStore(STORE_VIDEO_DRAFTS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

// 把单个 IDBRequest 包成 Promise
function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name, mode) {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ── 音频缓存 ──────────────────────────────────────────────

export async function putAudio(key, blob, meta) {
  const s = await store(STORE_AUDIO, 'readwrite');
  await reqP(s.put({ blob, meta: meta || {}, createdAt: Date.now() }, key));
  return key;
}

export async function getAudio(key) {
  const s = await store(STORE_AUDIO, 'readonly');
  return reqP(s.get(key));
}

export async function hasAudio(key) {
  const s = await store(STORE_AUDIO, 'readonly');
  const k = await reqP(s.getKey ? s.getKey(key) : s.get(key));
  return k !== undefined && k !== null;
}

export async function deleteAudio(key) {
  const s = await store(STORE_AUDIO, 'readwrite');
  await reqP(s.delete(key));
}

export async function clearAudioCache() {
  const s = await store(STORE_AUDIO, 'readwrite');
  await reqP(s.clear());
}

// ── 配音：台词提取缓存 ──────────────────────────────────────
// 台词文本不再全量塞进聊天 metadata；按聊天分桶存在本机 IndexedDB，避免长聊天每次保存都重复序列化。
export async function putTtsLineCache(chatKey, record) {
  const s = await store(STORE_TTS_LINES, 'readwrite');
  await reqP(s.put({ ...record, updatedAt: Date.now() }, String(chatKey || 'default')));
  return chatKey;
}

export async function getTtsLineCache(chatKey) {
  const s = await store(STORE_TTS_LINES, 'readonly');
  return reqP(s.get(String(chatKey || 'default')));
}

export async function deleteTtsLineCache(chatKey) {
  const s = await store(STORE_TTS_LINES, 'readwrite');
  await reqP(s.delete(String(chatKey || 'default')));
}

// 缓存上限裁剪：按 createdAt 保留最新 maxEntries 条，其余删除（近似 LRU）
// 裁剪音频缓存到 maxEntries 条。source 传入时只统计/裁剪该来源的条目
// （meta.source==='coread' 为伴读语音·其余/无标记视作配音 tts）——两套缓存各计各的、互不吃对方额度。
export async function pruneAudio(maxEntries, source = null) {
  if (!maxEntries || maxEntries < 1) return;
  const s = await store(STORE_AUDIO, 'readwrite');
  const match = (v) => {
    const src = (v && v.meta && v.meta.source) || 'tts';
    if (source == null) return true;              // 不分来源：全量（旧行为·向后兼容）
    if (source === 'tts') return src !== 'coread'; // 配音额度：非 coread 都算
    return src === source;                          // 指定来源：精确匹配
  };
  const entries = [];
  await new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      if (match(c.value)) entries.push({ key: c.key, createdAt: (c.value && c.value.createdAt) || 0 });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  if (entries.length <= maxEntries) return;
  entries.sort((a, b) => b.createdAt - a.createdAt); // 新→旧
  const doomed = entries.slice(maxEntries);
  for (const e of doomed) await reqP(s.delete(e.key));
}

// 列出全部音频缓存（含 blob）：用于导出。返回 [{ key, blob, meta, createdAt }]
export async function listAudio() {
  const s = await store(STORE_AUDIO, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      const v = c.value || {};
      out.push({ key: c.key, blob: v.blob, meta: v.meta || {}, createdAt: v.createdAt || 0 });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return out;
}

// 批量写入音频缓存（用于导入）：entries=[{ key, blob, meta, createdAt }]，已存在的 key 跳过（不覆盖本地新生成的）。
// 返回 { added, skipped }
export async function bulkPutAudio(entries) {
  let added = 0, skipped = 0;
  if (!Array.isArray(entries) || !entries.length) return { added, skipped };
  const s = await store(STORE_AUDIO, 'readwrite');
  for (const e of entries) {
    if (!e || !e.key || !e.blob) { skipped++; continue; }
    const existing = await reqP(s.getKey ? s.getKey(e.key) : s.get(e.key));
    if (existing !== undefined && existing !== null) { skipped++; continue; }
    await reqP(s.put({ blob: e.blob, meta: e.meta || {}, createdAt: e.createdAt || Date.now() }, e.key));
    added++;
  }
  return { added, skipped };
}

// ── 收藏夹 ────────────────────────────────────────────────

export async function addFavorite(favId, blob, meta, label) {
  const s = await store(STORE_FAVORITES, 'readwrite');
  await reqP(s.put({ blob, meta: meta || {}, label: label || '', createdAt: Date.now() }, favId));
  return favId;
}

export async function getFavorite(favId) {
  const s = await store(STORE_FAVORITES, 'readonly');
  return reqP(s.get(favId));
}

export async function hasFavorite(favId) {
  const s = await store(STORE_FAVORITES, 'readonly');
  const k = await reqP(s.getKey ? s.getKey(favId) : s.get(favId));
  return k !== undefined && k !== null;
}

// 只修改收藏标题/分类等轻元数据，保留原 Blob 与收藏时间。
export async function updateFavorite(favId, patch = {}) {
  const s = await store(STORE_FAVORITES, 'readwrite');
  const current = await reqP(s.get(favId));
  if (!current) return false;
  const next = {
    ...current,
    meta: patch.meta === undefined ? (current.meta || {}) : (patch.meta || {}),
    label: patch.label === undefined ? (current.label || '') : (patch.label || ''),
    createdAt: current.createdAt || Date.now(),
  };
  await reqP(s.put(next, favId));
  return true;
}

export async function removeFavorite(favId) {
  const s = await store(STORE_FAVORITES, 'readwrite');
  await reqP(s.delete(favId));
}

// 列出收藏（含 blob，便于直接播放）。返回 [{ id, blob, meta, label, createdAt }]
export async function listFavorites() {
  const s = await store(STORE_FAVORITES, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      const v = c.value || {};
      out.push({ id: c.key, blob: v.blob, meta: v.meta || {}, label: v.label || '', createdAt: v.createdAt || 0 });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// 探活：环境是否支持 IndexedDB（个别隐私模式/旧内核可能没有）
export function blobStoreAvailable() {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB; }
  catch (_) { return false; }
}

// ── 伴读：书籍正文（重，懒取）────────────────────────────────
// 轻重分离：书架列表只读 settings 里的轻元数据（标量长度/标题等），正文仅在打开阅读器时按 id 取。

export async function putBook(bookId, record) {
  const s = await store(STORE_BOOKS, 'readwrite');
  await reqP(s.put({ ...record, savedAt: Date.now() }, bookId));
  return bookId;
}

export async function getBook(bookId) {
  const s = await store(STORE_BOOKS, 'readonly');
  return reqP(s.get(bookId));
}

export async function deleteBook(bookId) {
  const s = await store(STORE_BOOKS, 'readwrite');
  await reqP(s.delete(bookId));
  try { const c = await store(STORE_COVERS, 'readwrite'); await reqP(c.delete(bookId)); } catch (_) {}
}

export async function listBookIds() {
  const s = await store(STORE_BOOKS, 'readonly');
  const keys = await reqP(s.getAllKeys ? s.getAllKeys() : s.getAll());
  return Array.isArray(keys) ? keys : [];
}

// ── 伴读：封面图 ─────────────────────────────────────────────

export async function putCover(bookId, blob) {
  const s = await store(STORE_COVERS, 'readwrite');
  await reqP(s.put(blob, bookId));
  return bookId;
}

export async function getCover(bookId) {
  const s = await store(STORE_COVERS, 'readonly');
  return reqP(s.get(bookId));
}

// ── 伴读：书内插图 ───────────────────────────────────────────
// 正文里以占位符 ⟦img:n⟧ 引用；每张图按 `${bookId}::${n}` 存 Blob，阅读器渲染时懒取 objectURL。

function imageKey(bookId, n) {
  return `${bookId}::${Number(n) || 0}`;
}

export async function putReaderImage(bookId, n, blob) {
  const s = await store(STORE_IMAGES, 'readwrite');
  await reqP(s.put(blob, imageKey(bookId, n)));
  return n;
}

export async function getReaderImage(bookId, n) {
  const s = await store(STORE_IMAGES, 'readonly');
  return reqP(s.get(imageKey(bookId, n)));
}

export async function deleteReaderImage(bookId, n) {
  const s = await store(STORE_IMAGES, 'readwrite');
  await reqP(s.delete(imageKey(bookId, n)));
}

// 全量列出书内插图（伴读整包导出用）。返回 [{ key, blob }]。
export async function listReaderImages() {
  const s = await store(STORE_IMAGES, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      out.push({ key: String(c.key), blob: c.value });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return out;
}

export async function putReaderImageByKey(key, blob) {
  const s = await store(STORE_IMAGES, 'readwrite');
  await reqP(s.put(blob, String(key)));
  return key;
}

// 删除某本书的全部插图（按 `${bookId}::` 前缀清理）。
export async function deleteReaderImages(bookId) {
  const prefix = `${bookId}::`;
  const s = await store(STORE_IMAGES, 'readwrite');
  await new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      if (typeof c.key === 'string' && c.key.startsWith(prefix)) c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
}

// ── 伴读：陪读会话 bucket（消息/总结/游标）──────────────────

export async function putReaderChat(bucketKey, record) {
  const s = await store(STORE_CHATS, 'readwrite');
  await reqP(s.put({ ...record, updatedAt: Date.now() }, bucketKey));
  return bucketKey;
}

export async function getReaderChat(bucketKey) {
  const s = await store(STORE_CHATS, 'readonly');
  return reqP(s.get(bucketKey));
}

export async function deleteReaderChat(bucketKey) {
  const s = await store(STORE_CHATS, 'readwrite');
  await reqP(s.delete(bucketKey));
}

export async function listReaderChatKeys() {
  const s = await store(STORE_CHATS, 'readonly');
  const keys = await reqP(s.getAllKeys ? s.getAllKeys() : s.getAll());
  return Array.isArray(keys) ? keys : [];
}

// ── 伴读：切片嵌入向量 bucket（独立于会话·避免每轮对话都写大数组）──

export async function getReaderVectors(bucketKey) {
  const s = await store(STORE_VECTORS, 'readonly');
  return reqP(s.get(bucketKey));
}

export async function putReaderVectors(bucketKey, record) {
  const s = await store(STORE_VECTORS, 'readwrite');
  await reqP(s.put({ ...record, updatedAt: Date.now() }, bucketKey));
  return bucketKey;
}

export async function deleteReaderVectors(bucketKey) {
  const s = await store(STORE_VECTORS, 'readwrite');
  await reqP(s.delete(bucketKey));
}

export async function listReaderVectorKeys() {
  const s = await store(STORE_VECTORS, 'readonly');
  const keys = await reqP(s.getAllKeys ? s.getAllKeys() : s.getAll());
  return Array.isArray(keys) ? keys : [];
}

// ── 伴读：检索日志（环形，保留最近 maxEntries 条）──────────

export async function pushRetLog(record, maxEntries = 50) {
  const s = await store(STORE_RETLOG, 'readwrite');
  await reqP(s.add({ ...record, at: record?.at || Date.now() }));
  // 裁剪：autoIncrement key 递增，删除最小的若干个
  const keys = await reqP(s.getAllKeys ? s.getAllKeys() : s.getAll());
  if (Array.isArray(keys) && keys.length > maxEntries) {
    const doomed = keys.slice(0, keys.length - maxEntries);
    for (const k of doomed) await reqP(s.delete(k));
  }
}

export async function listRetLog() {
  const s = await store(STORE_RETLOG, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { resolve(); return; }
      out.push({ id: c.key, ...(c.value || {}) });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  out.sort((a, b) => (b.at || 0) - (a.at || 0));   // 新→旧
  return out;
}

export async function clearRetLog() {
  const s = await store(STORE_RETLOG, 'readwrite');
  await reqP(s.clear());
}

// ── 便笺：仅固定条目跨 ST 重启持久保存 ───────────────────────

export async function putNote(noteId, record) {
  const s = await store(STORE_NOTES, 'readwrite');
  await reqP(s.put({ ...record, id: String(noteId), pinned: true, updatedAt: Date.now() }, String(noteId)));
  return noteId;
}

export async function deleteNote(noteId) {
  const s = await store(STORE_NOTES, 'readwrite');
  await reqP(s.delete(String(noteId)));
}

export async function listNotes() {
  const s = await store(STORE_NOTES, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const cursor = s.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      out.push({ ...(current.value || {}), id: String(current.key), pinned: true });
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

// ── 分镜：跨聊天完成后的待归档收片箱 ───────────────────────
// ST 只允许扩展安全保存“当前聊天”的 metadata。用户在生图期间切走时，先把已经落盘的
// 成片记录按原 chatKey 放进本地收片箱；返回原聊天后再校验 messageRef 并写回该聊天。
export async function putStoryboardDelivery(taskId, record) {
  const id = String(taskId || '').trim();
  if (!id) throw new Error('storyboard delivery task id is required');
  const s = await store(STORE_STORYBOARD_INBOX, 'readwrite');
  await reqP(s.put({ ...(record || {}), taskId: id, createdAt: Number(record?.createdAt) || Date.now(), updatedAt: Date.now() }, id));
  return id;
}

export async function listStoryboardDeliveries(chatKey = '') {
  const expected = String(chatKey || '');
  const s = await store(STORE_STORYBOARD_INBOX, 'readonly');
  const out = [];
  await new Promise((resolve, reject) => {
    const cursor = s.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      const value = current.value || {};
      if (!expected || String(value.chatKey || '') === expected) out.push({ ...value, taskId: String(current.key) });
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return out.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
}

export async function deleteStoryboardDelivery(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return;
  const s = await store(STORE_STORYBOARD_INBOX, 'readwrite');
  await reqP(s.delete(id));
}

// ── 分镜：已结束的详细流水日志 ──────────────────────────────
// 生成中的流水仍由内存/settings 运行态持有；只有终态日志成功写入这里后，调用方才会
// 收缩 settings 中的完整 stages。该顺序保证 IndexedDB 不可用时仍保留旧数据。
export async function putStoryboardPipelineLogs(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .filter((item) => item && String(item.id || '').trim())
    .map((item) => ({ ...item, id: String(item.id), archivedAt: Date.now() }));
  if (!normalized.length) return { stored: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_STORYBOARD_PIPELINE_LOGS, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('storyboard pipeline archive failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storyboard pipeline archive aborted'));
  });
  const target = transaction.objectStore(STORE_STORYBOARD_PIPELINE_LOGS);
  try {
    for (const record of normalized) target.put(record, record.id);
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await done.catch(() => {});
    throw error;
  }
  await done;
  return { stored: normalized.map((item) => item.id) };
}

export async function getStoryboardPipelineLogs(ids = []) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 200);
  if (!unique.length) return [];
  const target = await store(STORE_STORYBOARD_PIPELINE_LOGS, 'readonly');
  const values = await Promise.all(unique.map((id) => reqP(target.get(id))));
  return values.filter(Boolean);
}

export async function deleteStoryboardPipelineLogs(ids = []) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 200);
  if (!unique.length) return { deleted: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_STORYBOARD_PIPELINE_LOGS, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('storyboard pipeline delete failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storyboard pipeline delete aborted'));
  });
  const target = transaction.objectStore(STORE_STORYBOARD_PIPELINE_LOGS);
  for (const id of unique) target.delete(id);
  await done;
  return { deleted: unique };
}

export async function clearStoryboardPipelineLogs() {
  const target = await store(STORE_STORYBOARD_PIPELINE_LOGS, 'readwrite');
  await reqP(target.clear());
}

// ── 分镜：阅片记录的完整精确重绘快照 ────────────────────────
// 图片 URL、正文锚点与可视参数继续留在聊天 metadata；这里只承接 profile、connection、
// payload 等体积较大的可重放请求。调用方必须在事务成功后才移除旧内联 snapshot。
export async function putStoryboardSnapshots(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .filter((item) => item && String(item.key || '').trim() && item.snapshot && typeof item.snapshot === 'object')
    .map((item) => ({
      key: String(item.key), chatKey: String(item.chatKey || ''), recordId: String(item.recordId || ''),
      snapshot: item.snapshot, updatedAt: Number(item.updatedAt) || Date.now(),
    }));
  if (!normalized.length) return { stored: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_STORYBOARD_SNAPSHOTS, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('storyboard snapshot archive failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storyboard snapshot archive aborted'));
  });
  const target = transaction.objectStore(STORE_STORYBOARD_SNAPSHOTS);
  try {
    for (const record of normalized) target.put(record, record.key);
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await done.catch(() => {});
    throw error;
  }
  await done;
  return { stored: normalized.map((item) => item.key) };
}

export async function getStoryboardSnapshots(keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 500);
  if (!unique.length) return [];
  const target = await store(STORE_STORYBOARD_SNAPSHOTS, 'readonly');
  const values = await Promise.all(unique.map((key) => reqP(target.get(key))));
  return values.filter(Boolean);
}

export async function deleteStoryboardSnapshots(keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 500);
  if (!unique.length) return { deleted: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_STORYBOARD_SNAPSHOTS, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('storyboard snapshot delete failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storyboard snapshot delete aborted'));
  });
  const target = transaction.objectStore(STORE_STORYBOARD_SNAPSHOTS);
  for (const key of unique) target.delete(key);
  await done;
  return { deleted: unique };
}

// ── 分镜：结束态计划重数据 ───────────────────────────────
export async function putStoryboardPlanArchives(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .filter((item) => item && String(item.key || '').trim() && item.plan && typeof item.plan === 'object')
    .map((item) => ({
      key: String(item.key), chatKey: String(item.chatKey || ''), planId: String(item.planId || ''),
      plan: item.plan, updatedAt: Number(item.updatedAt) || Date.now(),
    }));
  if (!normalized.length) return { stored: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_STORYBOARD_PLAN_ARCHIVES, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('storyboard plan archive failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storyboard plan archive aborted'));
  });
  const target = transaction.objectStore(STORE_STORYBOARD_PLAN_ARCHIVES);
  try {
    for (const record of normalized) target.put(record, record.key);
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await done.catch(() => {});
    throw error;
  }
  await done;
  return { stored: normalized.map((item) => item.key) };
}

export async function getStoryboardPlanArchives(keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 300);
  if (!unique.length) return [];
  const target = await store(STORE_STORYBOARD_PLAN_ARCHIVES, 'readonly');
  const values = await Promise.all(unique.map((key) => reqP(target.get(key))));
  return values.filter(Boolean);
}

export async function deleteStoryboardPlanArchives(keys = []) {
  const unique = [...new Set((Array.isArray(keys) ? keys : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 300);
  if (!unique.length) return { deleted: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_STORYBOARD_PLAN_ARCHIVES, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('storyboard plan archive delete failed'));
    transaction.onabort = () => reject(transaction.error || new Error('storyboard plan archive delete aborted'));
  });
  const target = transaction.objectStore(STORE_STORYBOARD_PLAN_ARCHIVES);
  for (const key of unique) target.delete(key);
  await done;
  return { deleted: unique };
}

export async function clearStoryboardPlanArchives() {
  const target = await store(STORE_STORYBOARD_PLAN_ARCHIVES, 'readwrite');
  await reqP(target.clear());
}

// ── 动态镜头：任务与费用检查点 ─────────────────────────────
// 调用方先把任务和费用记录规整为白名单合同；本层只负责让两类数据在一个事务内共同落盘。
export async function putVideoRuntimeCheckpoint(taskValue, reservationsValue = []) {
  const task = taskValue && typeof taskValue === 'object' ? taskValue : {};
  const taskId = String(task.taskId || '').trim().slice(0, 200);
  const chatKey = String(task.owner?.chatKey || '').trim().slice(0, 512);
  if (!taskId || !chatKey) throw new Error('video task checkpoint requires taskId and chatKey');
  const reservations = (Array.isArray(reservationsValue) ? reservationsValue : [])
    .filter((item) => item && String(item.taskId || '').trim() === taskId && String(item.reservationId || '').trim())
    .slice(0, 100);
  const db = await openDB();
  const transaction = db.transaction([STORE_VIDEO_TASKS, STORE_VIDEO_BUDGET], 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('video runtime checkpoint failed'));
    transaction.onabort = () => reject(transaction.error || new Error('video runtime checkpoint aborted'));
  });
  const taskStore = transaction.objectStore(STORE_VIDEO_TASKS);
  const budgetStore = transaction.objectStore(STORE_VIDEO_BUDGET);
  const updatedAt = Math.max(0, Number(task.timing?.updatedAt) || Date.now());
  try {
    taskStore.put({
      schema: 'qianmu.video-task-record.v1', taskId, chatKey,
      state: String(task.state || ''), attempt: Math.max(1, Number(task.attempt) || 1), updatedAt, task,
    }, taskId);
    for (const reservation of reservations) {
      const reservationId = String(reservation.reservationId).trim().slice(0, 200);
      budgetStore.put({
        schema: 'qianmu.video-budget-record.v1', reservationId, taskId,
        chatKey: String(reservation.chatKey || chatKey).trim().slice(0, 512),
        dayKey: String(reservation.dayKey || '').trim().slice(0, 20),
        settlement: String(reservation.settlement || ''), updatedAt, reservation,
      }, reservationId);
    }
  } catch (error) {
    try { transaction.abort(); } catch (_) {}
    await done.catch(() => {});
    throw error;
  }
  await done;
  return { taskId, reservations: reservations.map((item) => String(item.reservationId)) };
}

export async function getVideoRuntimeTask(taskId) {
  const id = String(taskId || '').trim().slice(0, 200);
  if (!id) return null;
  const target = await store(STORE_VIDEO_TASKS, 'readonly');
  return (await reqP(target.get(id))) || null;
}

export async function listVideoRuntimeTasks(chatKey = '', options = {}) {
  const expected = String(chatKey || '').trim().slice(0, 512);
  const limit = Math.min(1000, Math.max(1, Math.round(Number(options.limit) || 300)));
  const target = await store(STORE_VIDEO_TASKS, 'readonly');
  const records = [];
  await new Promise((resolve, reject) => {
    const cursor = target.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      const value = current.value || {};
      if (!expected || String(value.chatKey || '') === expected) records.push(value);
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return records.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)).slice(0, limit);
}

export async function listVideoBudgetRecords(filters = {}, options = {}) {
  const expectedTask = String(filters?.taskId || '').trim().slice(0, 200);
  const expectedChat = String(filters?.chatKey || '').trim().slice(0, 512);
  const expectedDay = String(filters?.dayKey || '').trim().slice(0, 20);
  const limit = Math.min(5000, Math.max(1, Math.round(Number(options.limit) || 2000)));
  const target = await store(STORE_VIDEO_BUDGET, 'readonly');
  const records = [];
  let overflow = false;
  await new Promise((resolve, reject) => {
    const cursor = target.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      const value = current.value || {};
      if ((!expectedTask || String(value.taskId || '') === expectedTask)
        && (!expectedChat || String(value.chatKey || '') === expectedChat)
        && (!expectedDay || String(value.dayKey || '') === expectedDay)) {
        if (records.length >= limit) { overflow = true; resolve(); return; }
        records.push(value);
      }
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  if (overflow) throw new Error('video budget ledger exceeds the safe scan limit');
  return records.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

export async function deleteVideoRuntimeTasks(taskIds = []) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((value) => String(value || '').trim().slice(0, 200)).filter(Boolean))].slice(0, 500);
  if (!ids.length) return { deleted: [], budgetDeleted: 0 };
  const idSet = new Set(ids);
  const db = await openDB();
  const transaction = db.transaction([STORE_VIDEO_TASKS, STORE_VIDEO_BUDGET], 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('video runtime delete failed'));
    transaction.onabort = () => reject(transaction.error || new Error('video runtime delete aborted'));
  });
  const taskStore = transaction.objectStore(STORE_VIDEO_TASKS);
  const budgetStore = transaction.objectStore(STORE_VIDEO_BUDGET);
  let budgetDeleted = 0;
  for (const id of ids) taskStore.delete(id);
  const cursor = budgetStore.openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    if (idSet.has(String(current.value?.taskId || ''))) {
      current.delete();
      budgetDeleted++;
    }
    current.continue();
  };
  cursor.onerror = () => {
    try { transaction.abort(); } catch (_) {}
  };
  await done;
  return { deleted: ids, budgetDeleted };
}

// ── 动态镜头：本地编辑草稿 ───────────────────────────────
// 即使调用方误传额外字段，本层也只允许草稿合同的白名单字段落盘。
function boundedVideoDraftText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function videoDraftStorageId(value) {
  const result = boundedVideoDraftText(value, 200);
  return /^[A-Za-z0-9._:-]+$/.test(result) ? result : '';
}

function normalizeStoredVideoDraft(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const owner = raw.owner && typeof raw.owner === 'object' ? raw.owner : {};
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const selection = raw.selection && typeof raw.selection === 'object' ? raw.selection : {};
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const timing = raw.timing && typeof raw.timing === 'object' ? raw.timing : {};
  const roles = selection.referenceRoles && typeof selection.referenceRoles === 'object' ? selection.referenceRoles : {};
  const labels = selection.subjectLabels && typeof selection.subjectLabels === 'object' ? selection.subjectLabels : {};
  const rawFloor = owner.floor;
  const floor = Number(rawFloor);
  const draftId = videoDraftStorageId(raw.draftId || raw.draft_id || raw.id);
  return {
    schema: 'qianmu.video-draft.v1',
    draftId,
    revision: Math.min(9999, Math.max(1, Math.round(Number(raw.revision) || 1))),
    owner: {
      chatKey: boundedVideoDraftText(owner.chatKey || owner.chat_key, 512),
      floor: rawFloor !== '' && rawFloor !== null && rawFloor !== undefined && Number.isInteger(floor) && floor >= 0 ? Math.min(1_000_000, floor) : null,
      messageId: videoDraftStorageId(owner.messageId || owner.message_id),
      paragraphAnchorId: videoDraftStorageId(owner.paragraphAnchorId || owner.paragraph_anchor_id),
    },
    source: {
      kind: ['storyboard_frame', 'inline_frame', 'director_frame', 'blank'].includes(source.kind) ? source.kind : 'blank',
      track: ['main_camera', 'second_camera'].includes(source.track) ? source.track : 'main_camera',
      recordId: videoDraftStorageId(source.recordId || source.record_id),
      sourceShotId: videoDraftStorageId(source.sourceShotId || source.source_shot_id),
    },
    selection: {
      firstRecordId: videoDraftStorageId(selection.firstRecordId || selection.first_record_id),
      lastRecordId: videoDraftStorageId(selection.lastRecordId || selection.last_record_id),
      referenceRecordIds: [...new Set((Array.isArray(selection.referenceRecordIds || selection.reference_record_ids)
        ? (selection.referenceRecordIds || selection.reference_record_ids) : []).map(videoDraftStorageId).filter(Boolean))].slice(0, 32),
      referenceRoles: Object.fromEntries(Object.entries(roles).slice(0, 32).flatMap(([key, value]) => {
        const id = videoDraftStorageId(key);
        const allowed = [...new Set((Array.isArray(value) ? value : []).map((item) => boundedVideoDraftText(item, 80))
          .filter((role) => ['subject_reference', 'style_reference', 'motion_reference'].includes(role)))].slice(0, 3);
        return id && allowed.length ? [[id, allowed]] : [];
      })),
      subjectLabels: Object.fromEntries(Object.entries(labels).slice(0, 16).flatMap(([key, value]) => {
        const id = videoDraftStorageId(key);
        const label = boundedVideoDraftText(value, 80);
        return id && /^<Subject [1-9]\d*>$/.test(label) ? [[id, label]] : [];
      })),
    },
    settings: {
      requestedMode: ['auto', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va'].includes(settings.requestedMode || settings.requested_mode)
        ? (settings.requestedMode || settings.requested_mode) : 'auto',
      durationSeconds: Math.min(15, Math.max(4, Math.round(Number(settings.durationSeconds ?? settings.duration_seconds) || 6))),
      resolution: ['768p', '2k'].includes(String(settings.resolution || '').toLowerCase()) ? String(settings.resolution).toLowerCase() : '768p',
      aspectRatio: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(String(settings.aspectRatio || settings.aspect_ratio || '').toLowerCase())
        ? String(settings.aspectRatio || settings.aspect_ratio).toLowerCase() : '16:9',
      fps: Math.min(60, Math.max(1, Math.round(Number(settings.fps) || 24))),
    },
    direction: boundedVideoDraftText(raw.direction || raw.userDirection || raw.user_direction, 1600),
    timing: {
      createdAt: Math.max(0, Math.round(Number(timing.createdAt || timing.created_at || raw.createdAt || raw.created_at) || 0)),
      updatedAt: Math.max(0, Math.round(Number(timing.updatedAt || timing.updated_at || raw.updatedAt || raw.updated_at) || 0)),
    },
  };
}

export async function putVideoDraft(value = {}) {
  const draft = normalizeStoredVideoDraft(value);
  if (!draft.draftId || !draft.owner.chatKey) throw new Error('video draft requires draftId and chatKey');
  const now = Date.now();
  const createdAt = draft.timing.createdAt || now;
  const updatedAt = Math.max(createdAt, draft.timing.updatedAt || now);
  draft.timing = { createdAt, updatedAt };
  const target = await store(STORE_VIDEO_DRAFTS, 'readwrite');
  await reqP(target.put({
    schema: 'qianmu.video-draft-record.v1', draftId: draft.draftId,
    chatKey: draft.owner.chatKey, updatedAt, draft,
  }, draft.draftId));
  return { draftId: draft.draftId, chatKey: draft.owner.chatKey, updatedAt };
}

export async function getVideoDraft(draftIdValue) {
  const draftId = videoDraftStorageId(draftIdValue);
  if (!draftId) return null;
  const target = await store(STORE_VIDEO_DRAFTS, 'readonly');
  return (await reqP(target.get(draftId))) || null;
}

export async function listVideoDrafts(chatKey = '', options = {}) {
  const expectedChat = boundedVideoDraftText(chatKey, 512);
  const limit = Math.min(500, Math.max(1, Math.round(Number(options.limit) || 100)));
  const target = await store(STORE_VIDEO_DRAFTS, 'readonly');
  const records = [];
  await new Promise((resolve, reject) => {
    const cursor = target.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      const value = current.value || {};
      if (!expectedChat || String(value.chatKey || '') === expectedChat) records.push(value);
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return records.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0)).slice(0, limit);
}

export async function deleteVideoDrafts(draftIds = []) {
  const ids = [...new Set((Array.isArray(draftIds) ? draftIds : []).map(videoDraftStorageId).filter(Boolean))].slice(0, 500);
  if (!ids.length) return { deleted: [] };
  const db = await openDB();
  const transaction = db.transaction(STORE_VIDEO_DRAFTS, 'readwrite');
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('video draft delete failed'));
    transaction.onabort = () => reject(transaction.error || new Error('video draft delete aborted'));
  });
  const target = transaction.objectStore(STORE_VIDEO_DRAFTS);
  for (const draftId of ids) target.delete(draftId);
  await done;
  return { deleted: ids };
}

// ── 动态镜头：本地成片仓 ─────────────────────────────────
// 成片只保存在浏览器 IndexedDB；远端下载地址、API Key、提示词和供应商原始响应均不落盘。
export const VIDEO_MEDIA_MAX_BYTES = 768 * 1024 * 1024;
const VIDEO_MEDIA_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'application/octet-stream',
]);

function videoMediaId(value, field = 'assetId') {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new Error(`video media ${field} is invalid`);
  return id;
}

function boundedVideoMediaNumber(value, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(0, number)) : 0;
}

export function normalizeVideoMediaMeta(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const floorValue = raw.floor;
  const floorNumber = Number(floorValue);
  const remoteTaskId = String(raw.remoteTaskId || raw.remote_task_id || '').trim().slice(0, 400);
  const aiGenerated = raw.aiGenerated === true || raw.ai_generated === true || Boolean(remoteTaskId);
  const generator = String(raw.generator || (remoteTaskId ? 'MiniMax H3' : '')).trim().slice(0, 120);
  return {
    schema: 'qianmu.video-media.v1',
    recordId: String(raw.recordId || raw.record_id || '').trim().slice(0, 200),
    taskId: String(raw.taskId || raw.task_id || '').trim().slice(0, 200),
    draftId: String(raw.draftId || raw.draft_id || '').trim().slice(0, 200),
    sourceRecordId: String(raw.sourceRecordId || raw.source_record_id || '').trim().slice(0, 200),
    shotId: String(raw.shotId || raw.shot_id || '').trim().slice(0, 200),
    versionRootId: String(raw.versionRootId || raw.version_root_id || '').trim().slice(0, 200),
    parentRecordId: String(raw.parentRecordId || raw.parent_record_id || '').trim().slice(0, 200),
    manifestId: String(raw.manifestId || raw.manifest_id || '').trim().slice(0, 200),
    budgetReservationId: String(raw.budgetReservationId || raw.budget_reservation_id || '').trim().slice(0, 200),
    attempt: Math.round(Math.min(99, Math.max(1, Number(raw.attempt) || 1))),
    chatKey: String(raw.chatKey || raw.chat_key || '').trim().slice(0, 512),
    floor: floorValue !== '' && floorValue !== null && floorValue !== undefined && Number.isInteger(floorNumber) && floorNumber >= 0
      ? Math.min(1_000_000, floorNumber) : null,
    messageId: String(raw.messageId || raw.message_id || '').trim().slice(0, 200),
    remoteTaskId,
    durationSeconds: boundedVideoMediaNumber(raw.durationSeconds || raw.duration_seconds, 3600),
    resolution: String(raw.resolution || '').trim().slice(0, 40),
    ratio: String(raw.ratio || '').trim().slice(0, 40),
    audioMode: String(raw.audioMode || raw.audio_mode || '').trim().slice(0, 80),
    aiGenerated,
    generator,
    referenceAssetIds: [...new Set((Array.isArray(raw.referenceAssetIds || raw.reference_asset_ids)
      ? (raw.referenceAssetIds || raw.reference_asset_ids) : [])
      .map((item) => String(item || '').trim().slice(0, 200)).filter(Boolean))].slice(0, 12),
    mimeType: String(raw.mimeType || raw.mime_type || '').trim().toLowerCase().slice(0, 100),
    size: Math.round(boundedVideoMediaNumber(raw.size, VIDEO_MEDIA_MAX_BYTES)),
    createdAt: Math.round(boundedVideoMediaNumber(raw.createdAt || raw.created_at, Number.MAX_SAFE_INTEGER)),
    updatedAt: Math.round(boundedVideoMediaNumber(raw.updatedAt || raw.updated_at, Number.MAX_SAFE_INTEGER)),
  };
}

export async function putVideoMedia(assetIdValue, blob, metaValue = {}) {
  const assetId = videoMediaId(assetIdValue);
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) throw new Error('video media must be a Blob');
  if (!blob.size || blob.size > VIDEO_MEDIA_MAX_BYTES) throw new Error('video media size is invalid');
  const mimeType = String(blob.type || metaValue?.mimeType || '').trim().toLowerCase().split(';')[0];
  if (!VIDEO_MEDIA_MIME_TYPES.has(mimeType)) throw new Error('video media type is invalid');
  const now = Date.now();
  const meta = normalizeVideoMediaMeta({ ...metaValue, mimeType, size: blob.size });
  const createdAt = meta.createdAt || now;
  const updatedAt = now;
  const target = await store(STORE_VIDEO_MEDIA, 'readwrite');
  await reqP(target.put({
    schema: 'qianmu.video-media-record.v1', assetId, blob,
    meta: { ...meta, createdAt, updatedAt }, createdAt, updatedAt,
  }, assetId));
  return { assetId, recordId: meta.recordId, size: blob.size, mimeType };
}

export async function hasVideoMedia(assetIdValue) {
  const assetId = videoMediaId(assetIdValue);
  const target = await store(STORE_VIDEO_MEDIA, 'readonly');
  const key = await reqP(target.getKey ? target.getKey(assetId) : target.get(assetId));
  return key !== undefined && key !== null;
}

export async function getVideoMedia(assetIdValue) {
  const assetId = videoMediaId(assetIdValue);
  const target = await store(STORE_VIDEO_MEDIA, 'readonly');
  return (await reqP(target.get(assetId))) || null;
}

export async function listVideoMedia(chatKey = '', options = {}) {
  const expectedChat = String(chatKey || '').trim().slice(0, 512);
  const limit = Math.min(1000, Math.max(1, Math.round(Number(options.limit) || 300)));
  const target = await store(STORE_VIDEO_MEDIA, 'readonly');
  const records = [];
  await new Promise((resolve, reject) => {
    const cursor = target.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      const value = current.value || {};
      const meta = normalizeVideoMediaMeta(value.meta);
      if (!expectedChat || meta.chatKey === expectedChat) {
        records.push({
          assetId: String(current.key), recordId: meta.recordId, meta,
          size: Math.max(0, Number(value.blob?.size) || meta.size),
          mimeType: String(value.blob?.type || meta.mimeType || ''),
          createdAt: Math.max(0, Number(value.createdAt) || meta.createdAt),
          updatedAt: Math.max(0, Number(value.updatedAt) || meta.updatedAt),
        });
      }
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return records.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

export async function deleteVideoMedia(assetIdValue) {
  const assetId = videoMediaId(assetIdValue);
  const target = await store(STORE_VIDEO_MEDIA, 'readwrite');
  await reqP(target.delete(assetId));
  return { deleted: assetId };
}

// ── 存储治理：只读盘点与严格白名单清理 ──────────────────────

function readerImageBookId(key) {
  const value = String(key ?? '');
  const separator = value.lastIndexOf('::');
  return separator > 0 ? value.slice(0, separator) : '';
}

async function auditOrphanedStore(name, kind, bookIdForKey, books) {
  const s = await store(name, 'readonly');
  const records = [];
  await new Promise((resolve, reject) => {
    const cursor = s.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      const bookId = bookIdForKey(current.key);
      if (!bookId || !books.has(bookId)) {
        records.push({
          store: name,
          key: current.key,
          bookId,
          kind,
          bytes: estimateStoredValueBytes(current.key) + estimateStoredValueBytes(current.value),
          reason: bookId ? '对应书籍主体已不存在' : '无法识别书籍引用',
        });
      }
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return records;
}

// 仅将“已无 reader_books 主体”的封面和书内插图判为孤儿。
// 伴读会话/向量可以在删书后作为用户保留的记忆继续存在，故绝不自动判孤。
export async function auditOrphanedReaderBlobs() {
  if (!blobStoreAvailable()) return { available: false, records: [], count: 0, bytes: 0, scannedAt: Date.now() };
  const bookIds = await listBookIds();
  const books = new Set(bookIds.map((value) => String(value)));
  const [covers, images] = await Promise.all([
    auditOrphanedStore(STORE_COVERS, 'cover', (key) => String(key ?? ''), books),
    auditOrphanedStore(STORE_IMAGES, 'image', readerImageBookId, books),
  ]);
  const records = [...covers, ...images];
  return {
    available: true,
    records,
    count: records.length,
    bytes: records.reduce((sum, item) => sum + Math.max(0, Number(item.bytes) || 0), 0),
    scannedAt: Date.now(),
  };
}

// 删除前逐项重查书籍主体；若盘点后书籍被重新导入，该资源会被跳过。
export async function clearOrphanedReaderBlobs() {
  if (!blobStoreAvailable()) return { cleared: [], skipped: [], failed: [], beforeBytes: 0, remaining: 0 };
  const audit = await auditOrphanedReaderBlobs();
  const cleared = [];
  const skipped = [];
  const failed = [];
  for (const item of audit.records) {
    try {
      if (item.bookId && await getBook(item.bookId)) {
        skipped.push({ ...item, reason: '书籍已恢复，保留资源' });
        continue;
      }
      const target = await store(item.store, 'readwrite');
      await reqP(target.delete(item.key));
      cleared.push(item);
    } catch (error) {
      failed.push({ ...item, error: error?.message || String(error) });
    }
  }
  const remainingAudit = await auditOrphanedReaderBlobs();
  return {
    cleared,
    skipped,
    failed,
    beforeBytes: audit.bytes,
    remaining: remainingAudit.count,
  };
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const char of String(value || '')) {
    const code = char.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// 浏览器配额是“当前 ST 站点来源”的动态预算，不是 VPS/磁盘容量。
// 这里只给出高水位信号，绝不自动删除、降级或申请持久化权限。
export function classifyStoragePressure(estimate = {}) {
  const usage = Math.max(0, Number(estimate?.usage) || 0);
  const quota = Math.max(0, Number(estimate?.quota) || 0);
  if (!quota) return { available: false, level: 'unknown', usage, quota, ratio: 0, freeBytes: 0 };
  const ratio = usage / quota;
  const level = ratio >= 0.9 ? 'critical' : ratio >= 0.8 ? 'warning' : 'normal';
  return {
    available: true,
    level,
    usage,
    quota,
    ratio,
    freeBytes: Math.max(0, quota - usage),
  };
}

function readerBucketScope(key, value = {}) {
  const rawKey = String(key ?? '');
  const bookId = String(value?.bookId || '').trim();
  const suffix = bookId ? `::${bookId}` : '';
  if (suffix && rawKey.endsWith(suffix)) return rawKey.slice(0, -suffix.length);
  const separator = rawKey.lastIndexOf('::');
  return separator > 0 ? rawKey.slice(0, separator) : '';
}

function storageRecordChatKey(name, key, value) {
  if (name === STORE_TTS_LINES) return String(key ?? '').trim().slice(0, 512);
  if (name === STORE_CHATS || name === STORE_VECTORS) return readerBucketScope(key, value).slice(0, 512);
  if (name === STORE_STORYBOARD_INBOX) return String(value?.chatKey || '').trim().slice(0, 512);
  if (name === STORE_STORYBOARD_SNAPSHOTS) return String(value?.chatKey || '').trim().slice(0, 512);
  if (name === STORE_STORYBOARD_PLAN_ARCHIVES) return String(value?.chatKey || '').trim().slice(0, 512);
  if (name === STORE_VIDEO_TASKS || name === STORE_VIDEO_BUDGET || name === STORE_VIDEO_DRAFTS) return String(value?.chatKey || '').trim().slice(0, 512);
  if (name === STORE_VIDEO_MEDIA) return String(value?.meta?.chatKey || '').trim().slice(0, 512);
  if (name === STORE_AUDIO) return String(value?.meta?.chatKey || '').trim().slice(0, 512);
  return '';
}

// 估算 structured-clone 值的有效载荷大小。Blob/ArrayBuffer 使用真实字节数，
// 普通对象逐字段累加，不把二进制 stringify 成巨型字符串。仅用于容量可视化，
// 浏览器最终占用仍以 navigator.storage.estimate() 的整个 ST 来源统计为准。
export function estimateStoredValueBytes(value, seen = new WeakSet()) {
  if (value == null) return 0;
  if (typeof value === 'string') return utf8ByteLength(value);
  if (typeof value === 'number' || typeof value === 'bigint' || value instanceof Date) return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return Number(value.size) || 0;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateStoredValueBytes(item, seen), 0);
  if (value instanceof Map) {
    let bytes = 0;
    for (const [key, item] of value) bytes += estimateStoredValueBytes(key, seen) + estimateStoredValueBytes(item, seen);
    return bytes;
  }
  if (value instanceof Set) {
    let bytes = 0;
    for (const item of value) bytes += estimateStoredValueBytes(item, seen);
    return bytes;
  }
  return Object.entries(value).reduce((sum, [key, item]) => (
    sum + utf8ByteLength(key) + estimateStoredValueBytes(item, seen)
  ), 0);
}

async function estimateStoreUsage(name) {
  const info = STORAGE_STORE_INFO[name] || { label: name, category: 'other', recoverable: false };
  const s = await store(name, 'readonly');
  let count = 0;
  let bytes = 0;
  const scopeMap = new Map();
  await new Promise((resolve, reject) => {
    const cursor = s.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      count++;
      const recordBytes = estimateStoredValueBytes(current.key) + estimateStoredValueBytes(current.value);
      bytes += recordBytes;
      const chatKey = storageRecordChatKey(name, current.key, current.value);
      if (chatKey) {
        const scope = scopeMap.get(chatKey) || { chatKey, count: 0, bytes: 0 };
        scope.count++;
        scope.bytes += recordBytes;
        scopeMap.set(chatKey, scope);
      }
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
  return { name, ...info, count, bytes, scopes: [...scopeMap.values()].sort((left, right) => right.bytes - left.bytes) };
}

export async function estimateBlobStoreUsage() {
  if (!blobStoreAvailable()) return { available: false, stores: [], categories: [], totalBytes: 0, recoverableBytes: 0 };
  const stores = [];
  for (const name of Object.keys(STORAGE_STORE_INFO)) stores.push(await estimateStoreUsage(name));
  const categoryMap = new Map();
  const chatScopeMap = new Map();
  for (const item of stores) {
    const current = categoryMap.get(item.category) || { category: item.category, count: 0, bytes: 0, recoverableBytes: 0 };
    current.count += item.count;
    current.bytes += item.bytes;
    if (item.recoverable) current.recoverableBytes += item.bytes;
    categoryMap.set(item.category, current);
    for (const scope of item.scopes || []) {
      const currentScope = chatScopeMap.get(scope.chatKey) || { chatKey: scope.chatKey, count: 0, bytes: 0, stores: [] };
      currentScope.count += scope.count;
      currentScope.bytes += scope.bytes;
      currentScope.stores.push({ name: item.name, label: item.label, count: scope.count, bytes: scope.bytes, recoverable: item.recoverable });
      chatScopeMap.set(scope.chatKey, currentScope);
    }
  }
  return {
    available: true,
    stores,
    categories: [...categoryMap.values()],
    chatScopes: [...chatScopeMap.values()].sort((left, right) => right.bytes - left.bytes),
    totalBytes: stores.reduce((sum, item) => sum + item.bytes, 0),
    recoverableBytes: stores.reduce((sum, item) => sum + (item.recoverable ? item.bytes : 0), 0),
  };
}

// “安全清理”只允许进入此处写死的可再生数据；调用者不能传 store 名扩大范围。
export async function clearRecoverableStorage() {
  if (!blobStoreAvailable()) return { cleared: [], beforeBytes: 0 };
  const before = await estimateBlobStoreUsage();
  const recoverableNames = Object.entries(STORAGE_STORE_INFO)
    .filter(([, info]) => info.recoverable)
    .map(([name]) => name);
  const cleared = [];
  for (const name of recoverableNames) {
    const s = await store(name, 'readwrite');
    await reqP(s.clear());
    cleared.push(name);
  }
  return { cleared, beforeBytes: before.recoverableBytes };
}

// 按用户明确勾选的模块清理可再生数据。类别与 recoverable 双重白名单，
// 调用方无法借此触及收藏、书籍、图片、便笺等不可恢复内容。
export async function clearRecoverableCategories(categories = []) {
  if (!blobStoreAvailable()) return { cleared: [], beforeBytes: 0 };
  const allowedCategories = new Set(['audio', 'logs', 'cache']);
  const selected = new Set((Array.isArray(categories) ? categories : [])
    .map((value) => String(value || ''))
    .filter((value) => allowedCategories.has(value)));
  if (!selected.size) return { cleared: [], beforeBytes: 0 };
  const before = await estimateBlobStoreUsage();
  const targets = before.stores.filter((item) => item.recoverable && selected.has(item.category));
  const cleared = [];
  for (const item of targets) {
    const targetStore = await store(item.name, 'readwrite');
    await reqP(targetStore.clear());
    cleared.push(item.name);
  }
  return {
    cleared,
    beforeBytes: targets.reduce((sum, item) => sum + Math.max(0, Number(item.bytes) || 0), 0),
  };
}

// 储存管理页按 IndexedDB 项目逐项清理。目标仍只能来自本模块登记过的 store，
// 但不再替用户隐去不可恢复项目；是否删除由界面上的风险说明与用户勾选决定。
export async function clearStorageItems(storeNames = []) {
  if (!blobStoreAvailable()) return { cleared: [], failed: [], beforeBytes: 0, clearedBytes: 0 };
  const allowedNames = new Set(Object.keys(STORAGE_STORE_INFO));
  const selected = new Set((Array.isArray(storeNames) ? storeNames : [])
    .map((value) => String(value || ''))
    .filter((value) => allowedNames.has(value)));
  if (!selected.size) return { cleared: [], failed: [], beforeBytes: 0, clearedBytes: 0 };
  const before = await estimateBlobStoreUsage();
  const targets = before.stores.filter((item) => selected.has(item.name));
  const cleared = [];
  const failed = [];
  let clearedBytes = 0;
  for (const item of targets) {
    try {
      const targetStore = await store(item.name, 'readwrite');
      await reqP(targetStore.clear());
      cleared.push(item.name);
      clearedBytes += Math.max(0, Number(item.bytes) || 0);
    } catch (error) {
      failed.push({ name: item.name, error: error?.message || String(error) });
    }
  }
  return {
    cleared,
    failed,
    beforeBytes: targets.reduce((sum, item) => sum + Math.max(0, Number(item.bytes) || 0), 0),
    clearedBytes,
  };
}

const CHAT_SCOPED_CLEARABLE_STORES = Object.freeze([
  STORE_AUDIO,
  STORE_TTS_LINES,
  STORE_CHATS,
  STORE_VECTORS,
  STORE_STORYBOARD_SNAPSHOTS,
  STORE_STORYBOARD_PLAN_ARCHIVES,
  STORE_VIDEO_TASKS,
  STORE_VIDEO_BUDGET,
  STORE_VIDEO_MEDIA,
  STORE_VIDEO_DRAFTS,
]);

async function clearStoreChatScope(name, chatKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, 'readwrite');
    const target = transaction.objectStore(name);
    let count = 0;
    let bytes = 0;
    const cursor = target.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      if (storageRecordChatKey(name, current.key, current.value) === chatKey) {
        count++;
        bytes += estimateStoredValueBytes(current.key) + estimateStoredValueBytes(current.value);
        current.delete();
      }
      current.continue();
    };
    cursor.onerror = () => reject(cursor.error);
    transaction.oncomplete = () => resolve({ name, chatKey, count, bytes });
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error(`${name} cleanup aborted`));
  });
}

// 按聊天删除只接受已盘点且有明确 chatKey 的可安全分桶记录。
// 分镜收片箱即使能识别 chatKey 也不进白名单，避免删掉未归档成片。
export function normalizeChatScopedStorageSelections(selections = []) {
  const allowed = new Set(CHAT_SCOPED_CLEARABLE_STORES);
  const unique = new Map();
  for (const selection of Array.isArray(selections) ? selections : []) {
    const chatKey = String(selection?.chatKey || '').trim().slice(0, 512);
    const name = String(selection?.name || selection?.store || '');
    if (!chatKey || !allowed.has(name)) continue;
    unique.set(`${name}\n${chatKey}`, { name, chatKey });
  }
  return [...unique.values()];
}

export async function clearChatScopedStorage(selections = []) {
  if (!blobStoreAvailable()) return { cleared: [], failed: [], count: 0, bytes: 0 };
  const normalized = normalizeChatScopedStorageSelections(selections);
  const cleared = [];
  const failed = [];
  for (const selection of normalized) {
    try { cleared.push(await clearStoreChatScope(selection.name, selection.chatKey)); }
    catch (error) { failed.push({ ...selection, error: error?.message || String(error) }); }
  }
  return {
    cleared,
    failed,
    count: cleared.reduce((sum, item) => sum + item.count, 0),
    bytes: cleared.reduce((sum, item) => sum + item.bytes, 0),
  };
}
