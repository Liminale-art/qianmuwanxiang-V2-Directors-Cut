// Reader packs contain original media, unlike the smaller configuration-only package.
import {parseBoundedJson} from './qianmu-json-input.js';
export const COREAD_PACKAGE_LIMITS = Object.freeze({bytes:256*1048576,depth:40,nodes:500000});

export async function collectCoreadPackageData({bookMetas,blobStore,blobToBase64,warn}) {
  const books = [];
  for (const meta of bookMetas) {
    let rec = null;
    try { rec = await blobStore.getBook(meta.id); } catch (_) {}
    let coverB64 = '', coverMime = '';
    try {
      const cover = await blobStore.getCover(meta.id);
      if (cover) { coverB64 = await blobToBase64(cover); coverMime = cover.type || 'image/jpeg'; }
    } catch (_) {}
    books.push({ meta, fullText: rec?.fullText || '', chapters: rec?.chapters || [], sig: rec?.sig || '', comicDescriptions: rec?.comicDescriptions || {}, coverB64, coverMime });
  }
  // 伴读对话 + 记忆切片：存 IndexedDB reader_chats（bucketKey=chatKey::bookId·含 messages/slices/cursor/names）。
  // 全量导出所有 bucket——换端后对话与蒸馏出的记忆切片可整体复原（语音条文本随 messages 走·音频可重生成）。
  const chats = [];
  try {
    for (const key of await blobStore.listReaderChatKeys()) {
      const rec = await blobStore.getReaderChat(key);
      if (rec) chats.push({ key, rec });
    }
  } catch (e) { warn(`export chats failed`, e); }
  const images = [];
  try {
    for (const item of await blobStore.listReaderImages()) {
      if (!item?.key || !item.blob) continue;
      images.push({ key: item.key, b64: await blobToBase64(item.blob), mime: item.blob.type || 'image/*' });
    }
  } catch (e) { warn(`export reader images failed`, e); }
  const vectors = [];
  try {
    for (const key of await blobStore.listReaderVectorKeys()) {
      const rec = await blobStore.getReaderVectors(key);
      if (rec) vectors.push({ key, rec });
    }
  } catch (e) { warn(`export vectors failed`, e); }
  const audio = [];
  try {
    const allAudio = await blobStore.listAudio();
    for (const item of allAudio.filter((entry) => entry?.meta?.source === 'coread')) {
      if (!item?.key || !item.blob) continue;
      audio.push({ key: item.key, b64: await blobToBase64(item.blob), mime: item.blob.type || 'audio/mpeg', meta: item.meta || {}, createdAt: item.createdAt || 0 });
    }
  } catch (e) { warn(`export coread audio failed`, e); }
  let retrievalLogs = [];
  try { retrievalLogs = await blobStore.listRetLog(); } catch (e) { warn(`export retrieval logs failed`, e); }
  return {books,chats,images,vectors,audio,retrievalLogs};
}
export const coreadPackageSafeKey = key => !['__proto__','prototype','constructor'].includes(key);
// The file input may be hidden; watch its owning page, not the file chooser itself.
export function createCoreadImportViewGuard(origin) {
  const page = origin?.closest('.sd-reader-morepage');
  const modal = page ? null : origin?.closest('#story-director-modal');
  const root = page || modal, view = origin?.ownerDocument?.defaultView;
  let invalid = false, observer;
  const consume = records => {
    if (records.some(r => r.type === 'attributes' && (page ? r.oldValue !== null : !String(r.oldValue || '').split(/\s+/).includes('open')))) invalid = true;
  };
  const check = () => {
    if (observer) consume(observer.takeRecords());
    if (!origin?.isConnected || !root?.isConnected || (page ? page.hidden : !modal?.classList.contains('open'))) invalid = true;
    if (invalid) throw Error('伴读导入页面已关闭或变化，后续已停止；已写入内容保留。');
  };
  check();
  const onPageHide = () => { invalid = true; };
  observer = new view.MutationObserver(records => { consume(records); try { check(); } catch (_) {} });
  observer.observe(origin.ownerDocument.body, {childList:true, subtree:true});
  observer.observe(root, {attributes:true, attributeFilter:[page ? 'hidden' : 'class'], attributeOldValue:true});
  view.addEventListener('pagehide', onPageHide);
  return {check, release(){observer.disconnect();view.removeEventListener('pagehide', onPageHide);}};
}
export async function readCoreadPackageFile(file) {
  if (!file || typeof file.text !== 'function' || (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > COREAD_PACKAGE_LIMITS.bytes))) {
    throw new Error('伴读整包须在256 MiB以内；请保留原包，大包暂不直接恢复。');
  }
  const data = parseBoundedJson(await file.text(), {maxBytes:COREAD_PACKAGE_LIMITS.bytes,maxDepth:COREAD_PACKAGE_LIMITS.depth,maxNodes:COREAD_PACKAGE_LIMITS.nodes,label:'伴读整包'});
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(data) || data.type !== 'qianmu-coread' || !Array.isArray(data.books)) throw new Error('不是有效的千幕阅读数据文件。');
  const version = data.version === undefined ? 1 : Number(data.version);
  if (!Number.isInteger(version) || version < 1 || version > 5) throw new Error('暂不支持此伴读整包版本，请保留原包。');
  for (const key of ['chats','images','vectors','audio','retrievalLogs']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('伴读整包条目格式无效。');
  }
  if (data.prefs !== undefined && !record(data.prefs)) throw new Error('伴读整包设置格式无效。');
  return data;
}

export async function applyCoreadPackageData(data, {blobStore, coread, isPlainObject, base64ToBlob, warn, check = () => {}, progress = createCoreadImportProgress()}) {
  check();
  for (const b of data.books) {
    check();
    if (!b?.meta?.id) { progress.invalid++; continue; }
    try {
      await blobStore.putBook(b.meta.id, { meta: { title: b.meta.title, author: b.meta.author, mode: b.meta.mode || 'text' }, fullText: b.fullText || '', chapters: b.chapters || [], sig: b.sig || '', comicDescriptions: isPlainObject(b.comicDescriptions) ? b.comicDescriptions : {} });
      progress.ok++;
      check();
      if (b.coverB64) { try { await blobStore.putCover(b.meta.id, base64ToBlob(b.coverB64, b.coverMime || 'image/jpeg')); progress.coverOk++; check(); b.meta.hasCover = true; } catch (_) { check(); progress.failed++; } }
      const idx = (coread().books || []).findIndex((x) => x.id === b.meta.id);
      if (idx >= 0) coread().books[idx] = b.meta; else coread().books.unshift(b.meta);
    } catch (e) { check(); progress.failed++; warn(`import book failed`, e); }
  }
  // 伴读对话 + 记忆切片（reader_chats·按 bucketKey=chatKey::bookId 覆盖式还原·v2 新增）
  if (Array.isArray(data.chats)) {
    for (const c of data.chats) {
      check();
      if (!c?.key || !isPlainObject(c.rec)) { progress.invalid++; continue; }
      try { await blobStore.putReaderChat(c.key, c.rec); progress.chatOk++; check(); } catch (e) { check(); progress.failed++; warn(`import chat failed`, e); }
    }
  }
  if (Array.isArray(data.images)) {
    for (const item of data.images) {
      check();
      if (!item?.key || !item.b64) { progress.invalid++; continue; }
      try { await blobStore.putReaderImageByKey(item.key, base64ToBlob(item.b64, item.mime || 'image/*')); progress.imageOk++; check(); } catch (e) { check(); progress.failed++; warn(`import reader image failed`, e); }
    }
  }
  if (Array.isArray(data.vectors)) {
    for (const item of data.vectors) {
      check();
      if (!item?.key || !isPlainObject(item.rec)) { progress.invalid++; continue; }
      try { await blobStore.putReaderVectors(item.key, item.rec); progress.vectorOk++; check(); } catch (e) { check(); progress.failed++; warn(`import vectors failed`, e); }
    }
  }
  if (Array.isArray(data.audio)) {
    const entries = [];
    for (const item of data.audio) {
      check();
      if (!item?.key || !item?.b64) { progress.invalid++; continue; }
      try {
        entries.push({
          key: item.key,
          blob: base64ToBlob(item.b64, item.mime || 'audio/mpeg'),
          meta: { ...(item.meta || {}), source: 'coread' },
          createdAt: item.createdAt || Date.now(),
        });
      } catch (e) { check(); progress.failed++; warn(`decode coread audio failed`, e); }
    }
    check();
    const failedBeforeAudio = progress.failed;
    const onProgress = result => {
      progress.audioOk = result.added;
      progress.skipped = result.skipped || 0;
      progress.failed = failedBeforeAudio + (result.failed || 0);
    };
    try { const result = await blobStore.bulkPutAudio(entries, {onProgress}); onProgress(result); check(); } catch (e) { check(); progress.failed++; warn(`import coread audio failed`, e); }
  }
  if (Array.isArray(data.retrievalLogs)) {
    const ordered = data.retrievalLogs.slice().sort((a, b) => (a?.at || 0) - (b?.at || 0));
    for (const item of ordered) {
      check();
      if (!isPlainObject(item)) { progress.invalid++; continue; }
      const rec = { ...item }; delete rec.id;
      try { await blobStore.pushRetLog(rec, 50); progress.logOk++; check(); } catch (e) { check(); progress.failed++; warn(`import retrieval log failed`, e); }
    }
  }
  check();
  return progress;
}

export function createCoreadImportProgress() {
  return {ok:0, coverOk:0, chatOk:0, imageOk:0, vectorOk:0, audioOk:0, logOk:0, failed:0, invalid:0, skipped:0};
}

export function coreadImportProgressText(p) {
  return `已导入 ${p.ok} 本书原件 · ${p.coverOk} 张封面 · ${p.chatOk} 段对话 · ${p.imageOk} 张插图 · ${p.vectorOk} 组向量 · ${p.audioOk} 条语音 · ${p.logOk} 条检索记录；失败 ${p.failed} 项，格式无效 ${p.invalid} 项，已存在音频跳过 ${p.skipped} 项。`;
}
