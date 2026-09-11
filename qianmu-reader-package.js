// Reader packs contain original media, unlike the smaller configuration-only package.
import {parseBoundedJson} from './qianmu-json-input.js';
export const COREAD_PACKAGE_LIMITS = Object.freeze({bytes:256*1048576,depth:40,nodes:500000});
export const coreadPackageSafeKey = key => !['__proto__','prototype','constructor'].includes(key);
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

export async function applyCoreadPackageData(data, {blobStore, coread, isPlainObject, base64ToBlob, warn, check = () => {}}) {
  check();
  let ok = 0;
  for (const b of data.books) {
    check();
    if (!b?.meta?.id) continue;
    try {
      await blobStore.putBook(b.meta.id, { meta: { title: b.meta.title, author: b.meta.author, mode: b.meta.mode || 'text' }, fullText: b.fullText || '', chapters: b.chapters || [], sig: b.sig || '', comicDescriptions: isPlainObject(b.comicDescriptions) ? b.comicDescriptions : {} });
      check();
      if (b.coverB64) { try { await blobStore.putCover(b.meta.id, base64ToBlob(b.coverB64, b.coverMime || 'image/jpeg')); check(); b.meta.hasCover = true; } catch (_) { check(); } }
      const idx = (coread().books || []).findIndex((x) => x.id === b.meta.id);
      if (idx >= 0) coread().books[idx] = b.meta; else coread().books.unshift(b.meta);
      ok++;
    } catch (e) { check(); warn(`import book failed`, e); }
  }
  // 伴读对话 + 记忆切片（reader_chats·按 bucketKey=chatKey::bookId 覆盖式还原·v2 新增）
  let chatOk = 0;
  if (Array.isArray(data.chats)) {
    for (const c of data.chats) {
      check();
      if (!c?.key || !isPlainObject(c.rec)) continue;
      try { await blobStore.putReaderChat(c.key, c.rec); chatOk++; check(); } catch (e) { check(); warn(`import chat failed`, e); }
    }
  }
  let imageOk = 0;
  if (Array.isArray(data.images)) {
    for (const item of data.images) {
      check();
      if (!item?.key || !item.b64) continue;
      try { await blobStore.putReaderImageByKey(item.key, base64ToBlob(item.b64, item.mime || 'image/*')); imageOk++; check(); } catch (e) { check(); warn(`import reader image failed`, e); }
    }
  }
  let vectorOk = 0;
  if (Array.isArray(data.vectors)) {
    for (const item of data.vectors) {
      check();
      if (!item?.key || !isPlainObject(item.rec)) continue;
      try { await blobStore.putReaderVectors(item.key, item.rec); vectorOk++; check(); } catch (e) { check(); warn(`import vectors failed`, e); }
    }
  }
  let audioOk = 0;
  if (Array.isArray(data.audio)) {
    const entries = [];
    for (const item of data.audio) {
      check();
      if (!item?.key || !item?.b64) continue;
      try {
        entries.push({
          key: item.key,
          blob: base64ToBlob(item.b64, item.mime || 'audio/mpeg'),
          meta: { ...(item.meta || {}), source: 'coread' },
          createdAt: item.createdAt || Date.now(),
        });
      } catch (e) { check(); warn(`decode coread audio failed`, e); }
    }
    check();
    try { audioOk = (await blobStore.bulkPutAudio(entries)).added; check(); } catch (e) { check(); warn(`import coread audio failed`, e); }
  }
  let logOk = 0;
  if (Array.isArray(data.retrievalLogs)) {
    const ordered = data.retrievalLogs.slice().sort((a, b) => (a?.at || 0) - (b?.at || 0));
    for (const item of ordered) {
      check();
      if (!isPlainObject(item)) continue;
      const rec = { ...item }; delete rec.id;
      try { await blobStore.pushRetLog(rec, 50); logOk++; check(); } catch (e) { check(); warn(`import retrieval log failed`, e); }
    }
  }
  check();
  return {ok, chatOk, imageOk, vectorOk, audioOk, logOk};
}
