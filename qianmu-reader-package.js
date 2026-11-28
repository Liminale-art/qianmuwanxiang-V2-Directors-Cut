// Reader packs contain original media, unlike the smaller configuration-only package.
// v6（现行）：zip，每本书一个目录（书架条目、正文记录、封面、插图、对话与记忆、检索资料），另有 prefs.json 与 shared/（语音、
// 认不出属于哪本书的条目、检索记录）。逐条以 Blob 写入，不拼成一份大 JSON，也不转 base64。v1–v5 的单个 JSON 照常能恢复。
import {parseBoundedJson,base64DecodedLength} from './qianmu-json-input.js';
import {buildZip,isStoragePack,readZipDirectory,zipEntryBlob} from './qianmu-storage-transfer.js?v=1.59.630';
export const COREAD_PACKAGE_LIMITS = Object.freeze({bytes:256*1048576,depth:40,nodes:500000});
// v6 每个条目各自的上限（JSON 解析前按目录里记的大小先拦）。向量条目数字多，节点上限放宽，字节上限不变。
export const COREAD_ZIP_LIMITS = Object.freeze({json:64*1048576,media:512*1048576,depth:40,nodes:8000000});

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isBlob = value => !!value && typeof value.slice === 'function' && Number.isSafeInteger(value.size);
const asJson = value => new Blob([JSON.stringify(value)], {type:'application/json'});
const MEDIA_EXT = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/webm':'webm','audio/mp4':'m4a'};
const mediaName = (base, type) => `${base}.${MEDIA_EXT[String(type || '').split(';')[0].toLowerCase()] || 'bin'}`;
const mediaPattern = kind => new RegExp(`^${kind}/[a-z0-9.+*-]+(?:;[^\\r\\n]*)?$`, 'i');

// 对话、检索资料的键是「…::书」，漫画页稿是「comic::书」；插图是「书::n」。认不出的放进 shared/。
const ownerOfBucket = (key, ids) => { const at = String(key).lastIndexOf('::'); const id = at >= 0 ? String(key).slice(at + 2) : ''; return ids.has(id) ? id : ''; };
const ownerOfImage = (key, ids) => { const at = String(key).lastIndexOf('::'); const id = at >= 0 ? String(key).slice(0, at) : ''; return ids.has(id) ? id : ''; };

// 导出 v6。缺正文的书（另一台设备同步来、还没补正文）只导出书架条目与附属资料；声明有封面却找不到的，跳过封面。
// 这两种都记进 skipped，不中止。其余读取失败仍整份停下，不把不完整的备份当成完整的。
export async function buildCoreadPackage({bookMetas, prefs, blobStore, check = () => {}, now = () => new Date()}) {
  let category = '书籍原件';
  const read = async load => { check(); const value = await load(); check(); return value; };
  const list = async load => { const items = await read(load); if (!Array.isArray(items)) throw Error('invalid inventory'); return items; };
  const files = [], skipped = [], books = [], counts = {books:0, chats:0, images:0, vectors:0, audio:0};
  const shared = {images:[], chats:[], vectors:[], audio:[], retrievalLogs:null};
  try {
    const ids = new Set(bookMetas.map(meta => meta?.id).filter(id => typeof id === 'string' && id));
    category = '伴读对话与记忆';
    const chatKeys = await list(() => blobStore.listReaderChatKeys());
    category = '伴读检索资料';
    const vectorKeys = await list(() => blobStore.listReaderVectorKeys());
    category = '伴读插图';
    const images = await list(() => blobStore.listReaderImages());
    const put = (name, blob, deflate = false) => files.push({name, blob, deflate});
    const addChat = async (key, target, dir) => {
      category = '伴读对话与记忆';
      const rec = await read(() => blobStore.getReaderChat(key));
      if (!key || !isRecord(rec)) throw Error('missing listed chat');
      const file = `${dir}chats/${target.length + 1}.json`;
      target.push({key, file}); put(file, asJson(rec), true);
      if (!String(key).startsWith('comic::')) counts.chats++;
    };
    const addVectors = async (key, target, dir) => {
      category = '伴读检索资料';
      const rec = await read(() => blobStore.getReaderVectors(key));
      if (!key || !isRecord(rec)) throw Error('missing listed vectors');
      const file = `${dir}vectors/${target.length + 1}.json`;
      target.push({key, file}); put(file, asJson(rec), true); counts.vectors++;
    };
    const addImage = (item, target, dir) => {
      category = '伴读插图';
      if (!item?.key || !isBlob(item.blob)) throw Error('missing listed image');
      const mime = item.blob.type || 'image/*', file = mediaName(`${dir}images/${target.length + 1}`, mime);
      target.push({key:String(item.key), file, mime}); put(file, item.blob); counts.images++;
    };
    for (const [index, meta] of bookMetas.entries()) {
      category = '书籍原件';
      if (!meta?.id) throw Error('missing book identity');
      const dir = `books/${index + 1}/`, title = String(meta.title || '未命名书籍');
      const entry = {id:meta.id, meta:`${dir}meta.json`, book:null, cover:null, images:[], chats:[], vectors:[]};
      const rec = await read(() => blobStore.getBook(meta.id));
      put(entry.meta, asJson(meta), true);
      if (isRecord(rec) && typeof rec.fullText === 'string') {
        const {meta:_meta, savedAt:_saved, ...body} = rec;
        entry.book = `${dir}book.json`;
        put(entry.book, asJson({...body, fullText:rec.fullText, chapters:Array.isArray(rec.chapters) ? rec.chapters : [], sig:rec.sig || '', comicDescriptions:isRecord(rec.comicDescriptions) ? rec.comicDescriptions : {}}), true);
        counts.books++;
        category = '书籍封面';
        const cover = await read(() => blobStore.getCover(meta.id));
        if (isBlob(cover)) {
          const mime = cover.type || 'image/jpeg';
          entry.cover = {file:mediaName(`${dir}cover`, mime), mime}; put(entry.cover.file, cover);
        } else if (meta.hasCover) skipped.push({id:meta.id, title, part:'cover'});
      } else skipped.push({id:meta.id, title, part:'text'});
      for (const item of images) if (ownerOfImage(item?.key, ids) === meta.id) addImage(item, entry.images, dir);
      for (const key of chatKeys) if (ownerOfBucket(key, ids) === meta.id) await addChat(key, entry.chats, dir);
      for (const key of vectorKeys) if (ownerOfBucket(key, ids) === meta.id) await addVectors(key, entry.vectors, dir);
      put(`${dir}index.json`, asJson(entry), true);
      books.push({id:meta.id, dir});
    }
    for (const item of images) if (!ownerOfImage(item?.key, ids)) addImage(item, shared.images, 'shared/');
    for (const key of chatKeys) if (!ownerOfBucket(key, ids)) await addChat(key, shared.chats, 'shared/');
    for (const key of vectorKeys) if (!ownerOfBucket(key, ids)) await addVectors(key, shared.vectors, 'shared/');
    category = '伴读语音';
    for (const item of (await list(() => blobStore.listAudio())).filter(entry => entry?.meta?.source === 'coread')) {
      if (!item?.key || !isBlob(item.blob)) throw Error('missing listed audio');
      const mime = item.blob.type || 'audio/mpeg', file = mediaName(`shared/audio/${shared.audio.length + 1}`, mime);
      shared.audio.push({key:item.key, file, mime, meta:item.meta || {}, createdAt:item.createdAt || 0}); put(file, item.blob); counts.audio++;
    }
    category = '伴读检索记录';
    const retrievalLogs = await list(() => blobStore.listRetLog());
    if (retrievalLogs.some(item => !isRecord(item))) throw Error('invalid retrieval log');
    shared.retrievalLogs = 'shared/retlog.json'; put(shared.retrievalLogs, asJson(retrievalLogs), true);
    put('shared/index.json', asJson(shared), true);
    check();
  } catch (_) { check(); throw Error(`未能完整读取${category}，未导出备份。请保留本机资料，检查后重试。`); }
  const manifest = {type:'qianmu-coread', version:6, exportedAt:now().toISOString(), credentialsIncluded:false, prefs:'prefs.json', shared:'shared/index.json', books, skipped};
  const blob = await buildZip([{name:'manifest.json', blob:asJson(manifest)}, {name:'prefs.json', blob:asJson(isRecord(prefs) ? prefs : {}), deflate:true}, ...files]);
  check();
  return {blob, skipped, counts};
}

// 导出后的提示：成功时一句数目，有跳过的另起一句列书名。
export function coreadPackageExportText({counts, skipped}) {
  const titles = list => list.slice(0, 5).map(item => `《${item.title}》`).join('') + (list.length > 5 ? '等' : '');
  const text = skipped.filter(item => item.part === 'text'), cover = skipped.filter(item => item.part === 'cover');
  const notes = [`伴读数据已打包导出：${counts.books} 本书 · ${counts.chats} 段对话 · ${counts.images} 张插图 · ${counts.audio} 条语音。`];
  if (text.length) notes.push(`有 ${text.length} 本书在这台设备上没有正文，未导出：${titles(text)}`);
  if (cover.length) notes.push(`有 ${cover.length} 本书的封面不在这台设备上，未导出封面：${titles(cover)}`);
  return notes.join(' ');
}
export const coreadPackageSafeKey = key => !['__proto__','prototype','constructor'].includes(key);
// The file input may be hidden; watch its owning page, not the file chooser itself.
export function createCoreadImportViewGuard(origin, action = '导入', subject = '伴读') {
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
    if (invalid) throw Error(`${subject}${action}页面已关闭或变化，后续已停止；${action === '导出' ? '未导出备份。' : '已写入内容保留。'}`);
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
  if (typeof file?.slice === 'function' && Number.isSafeInteger(file.size) && file.size >= 4 && await isStoragePack(file)) return openCoreadZipPackage(file);
  if (!file || typeof file.text !== 'function' || (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > COREAD_PACKAGE_LIMITS.bytes))) {
    throw new Error('伴读整包须在256 MiB以内；请保留原包，大包暂不直接恢复。');
  }
  const data = parseBoundedJson(await file.text(), {maxBytes:COREAD_PACKAGE_LIMITS.bytes,maxDepth:COREAD_PACKAGE_LIMITS.depth,maxNodes:COREAD_PACKAGE_LIMITS.nodes,label:'伴读整包'});
  inspectCoreadPackage(data);
  return data;
}

// v6 预检：只读目录、manifest 与各书的 index.json，核对条目都在、编号不重复、媒体类型对、大小在上限内；有一处不对就整包不写。
// 正文与对话等内容在恢复时逐条读，坏了只算那一条失败。prefs.json 读不出不拦整包：书照常恢复，偏好另报。
export async function openCoreadZipPackage(file) {
  const limits = COREAD_ZIP_LIMITS;
  const entries = new Map((await readZipDirectory(file, {invalid:'不是有效的千幕阅读数据文件。', broken:'伴读整包已损坏，请保留原包。', incomplete:'伴读整包不完整，请保留原包。'})).map(entry => [entry.name, entry]));
  const readJson = async (name, label = '伴读整包') => {
    const entry = entries.get(name);
    if (!entry) throw Error(`${label}缺少条目`);
    const blob = await zipEntryBlob(file, entry, {maxBytes:limits.json});
    return parseBoundedJson(await blob.text(), {maxBytes:limits.json, maxDepth:limits.depth, maxNodes:limits.nodes, label});
  };
  const readMedia = (name, type) => zipEntryBlob(file, entries.get(name), {type, maxBytes:limits.media});
  // 语音写入是同步取下一条的；语音一律不压缩存，直接切片。
  const sliceMedia = (name, type) => {
    const entry = entries.get(name);
    if (!entry || entry.method !== 0 || entry.size !== entry.compressedSize || entry.size > limits.media) throw Error('媒体条目无效');
    return file.slice(entry.offset, entry.offset + entry.size, type);
  };
  let manifest;
  try { manifest = await readJson('manifest.json', '伴读整包目录'); }
  catch (_) { throw Error('不是有效的千幕阅读数据文件。'); }
  if (!isRecord(manifest) || manifest.type !== 'qianmu-coread' || !Array.isArray(manifest.books)) throw Error('不是有效的千幕阅读数据文件。');
  if (manifest.version !== 6) throw Error('暂不支持此伴读整包版本，请保留原包。');
  const present = (name, maxBytes) => typeof name === 'string' && entries.has(name) && entries.get(name).size <= maxBytes;
  const seen = {books:new Set(), images:new Set(), chats:new Set(), vectors:new Set(), audio:new Set()};
  const checkList = (list, store, kind, fail) => {
    if (!Array.isArray(list)) fail('条目格式无效');
    for (const item of list) {
      if (!isRecord(item) || typeof item.key !== 'string' || !item.key.trim()) fail('编号无效');
      if (seen[store].has(item.key)) fail('编号重复，无法确定应恢复哪一份');
      seen[store].add(item.key);
      if (!present(item.file, kind ? limits.media : limits.json)) fail('条目缺失或过大');
      if (kind && (typeof item.mime !== 'string' || !mediaPattern(kind).test(item.mime))) fail('媒体类型无效');
    }
  };
  const books = [];
  for (const [index, ref] of manifest.books.entries()) {
    const fail = message => { throw Error(`伴读书籍第 ${index + 1} 项${message}；未写入内容，请保留原包。`); };
    if (!isRecord(ref) || typeof ref.id !== 'string' || !ref.id.trim() || typeof ref.dir !== 'string') fail('编号无效');
    if (seen.books.has(ref.id)) fail('编号重复，无法确定应恢复哪一份');
    seen.books.add(ref.id);
    let book;
    try { book = await readJson(`${ref.dir}index.json`, '伴读书籍目录'); } catch (_) { fail('目录无法读取'); }
    if (!isRecord(book) || book.id !== ref.id || !present(book.meta, limits.json)) fail('书目信息缺失');
    if (book.book != null && !present(book.book, limits.json)) fail('正文原件缺失');
    if (book.cover != null && (!isRecord(book.cover) || !present(book.cover.file, limits.media) || typeof book.cover.mime !== 'string' || !mediaPattern('image').test(book.cover.mime))) fail('封面缺失或媒体类型无效');
    checkList(book.images, 'images', 'image', fail);
    checkList(book.chats, 'chats', '', fail);
    checkList(book.vectors, 'vectors', '', fail);
    books.push(book);
  }
  let shared = {images:[], chats:[], vectors:[], audio:[], retrievalLogs:null};
  if (manifest.shared !== undefined) {
    const fail = message => { throw Error(`伴读共用资料${message}；未写入内容，请保留原包。`); };
    try { shared = await readJson(manifest.shared, '伴读共用资料'); } catch (_) { fail('无法读取'); }
    if (!isRecord(shared)) fail('格式无效');
    checkList(shared.images, 'images', 'image', fail);
    checkList(shared.chats, 'chats', '', fail);
    checkList(shared.vectors, 'vectors', '', fail);
    checkList(shared.audio, 'audio', 'audio', fail);
    if (shared.audio.some(item => item.meta !== undefined && !isRecord(item.meta))) fail('媒体信息格式无效');
    if (shared.retrievalLogs != null && !present(shared.retrievalLogs, limits.json)) fail('检索记录缺失');
  }
  let prefs, prefsUnreadable = false;
  if (manifest.prefs !== undefined) {
    try { prefs = await readJson(manifest.prefs, '伴读设置'); if (!isRecord(prefs)) throw Error('invalid prefs'); }
    catch (_) { prefs = undefined; prefsUnreadable = true; }
  }
  return {type:'qianmu-coread', version:6, books, prefs, prefsUnreadable, shared, skipped:Array.isArray(manifest.skipped) ? manifest.skipped : [], zip:{readJson, readMedia, sliceMedia}};
}

// Read-only structural preflight. Reject a broken later entry before any overwrite.
// Optional v1-v5 categories stay optional; unknown historical record fields are kept.
export function inspectCoreadPackage(data) {
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(data) || data.type !== 'qianmu-coread' || !Array.isArray(data.books)) throw new Error('不是有效的千幕阅读数据文件。');
  const version = data.version === undefined ? 1 : (typeof data.version === 'number' || typeof data.version === 'string') ? Number(data.version) : NaN;
  if (!Number.isInteger(version) || version < 1 || version > 5) throw new Error('暂不支持此伴读整包版本，请保留原包。');
  for (const key of ['chats','images','vectors','audio','retrievalLogs']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error('伴读整包条目格式无效。');
  }
  if (data.prefs !== undefined && !record(data.prefs)) throw new Error('伴读整包设置格式无效。');
  const groups=[['books','书籍'],['chats','对话与记忆'],['images','插图'],['vectors','检索资料'],['audio','语音'],['retrievalLogs','检索记录']];
  for(const [key,label] of groups){
    const seen=new Set();
    for(const [index,item] of (data[key]||[]).entries()){
      const fail=message=>{throw Error(`伴读${label}第 ${index+1} 项${message}；未写入内容，请保留原包。`);};
      const media=(data,mime,kind)=>{
        if(mime!==undefined&&(typeof mime!=='string'||mime&&!new RegExp(`^${kind}/[a-z0-9.+*-]+(?:;[^\\r\\n]*)?$`,'i').test(mime)))fail('媒体类型无效');
        try{base64DecodedLength(data,{maxEncodedBytes:COREAD_PACKAGE_LIMITS.bytes,maxBytes:COREAD_PACKAGE_LIMITS.bytes});}catch(error){fail(error.message);}
      };
      if(!record(item))fail('格式无效');
      if(key==='retrievalLogs')continue; // Log IDs are intentionally recreated by the writer.
      if(key==='books'&&!record(item.meta))fail('书目信息缺失');
      const id=key==='books'?item.meta.id:item.key;
      if(typeof id!=='string'||!id.trim())fail('编号无效');
      if(seen.has(id))fail('编号重复，无法确定应恢复哪一份');
      seen.add(id);
      if(key==='books'){
        // Empty text is valid (e.g. a comic), missing/non-text originals are not.
        if(typeof item.fullText!=='string')fail('正文原件缺失或格式无效');
        if(item.chapters!==undefined&&!Array.isArray(item.chapters))fail('章节格式无效');
        if(item.comicDescriptions!==undefined&&!record(item.comicDescriptions))fail('漫画描述格式无效');
        if(item.coverB64!==undefined&&typeof item.coverB64!=='string')fail('封面格式无效');
        if(item.meta.hasCover&&!item.coverB64)fail('声明的封面原件缺失');
        if(item.coverB64)media(item.coverB64,item.coverMime,'image');
      }else if(key==='chats'||key==='vectors'){
        if(!record(item.rec))fail('记录缺失或格式无效');
      }else{
        if(typeof item.b64!=='string'||!item.b64)fail('媒体原件缺失或格式无效');
        if(key==='audio'&&item.meta!==undefined&&!record(item.meta))fail('媒体信息格式无效');
        media(item.b64,item.mime,key==='audio'?'audio':'image');
      }
    }
  }
  return data;
}

// Called after preflight; only counts and fixed copy enter the confirmation, never imported HTML.
export function coreadPackageRestoreMessage(data) {
  const count = key => Array.isArray(data[key]) ? data[key].length : 0;
  const covers = data.books.filter(book => book.coverB64).length;
  return `将恢复 ${count('books')} 本书及其对话、插图、语音，同编号内容会被覆盖。`;
}

// 书架条目：已有的替换，新书放最前；本机已有封面而包里没带时，保留本机封面标记。
function indexRestoredBook(coread, meta, cover) {
  const idx = (coread().books || []).findIndex((x) => x.id === meta.id);
  const next = {...meta, hasCover:!!cover || !!(idx >= 0 && coread().books[idx].hasCover)};
  if (idx >= 0) coread().books[idx] = next; else coread().books.unshift(next);
}

// v6：一本书一本书恢复，每本按「插图、对话、检索资料 → 正文记录与封面 → 书架条目」写；任何一条失败只记一笔，接着下一条。
// 页面或状态变化（check 抛错）照旧立刻停下，已写入的保留。
async function applyCoreadZipPackage(data, {blobStore, coread, isPlainObject, warn, check, onBookIndexed, progress}) {
  const {readJson, readMedia, sliceMedia} = data.zip;
  const attempt = async (label, work) => {
    check();
    try { await work(); check(); } catch (e) { check(); progress.failed++; warn(label, e); }
  };
  const restoreBuckets = async ({images = [], chats = [], vectors = []}) => {
    for (const item of images) await attempt('import reader image failed', async () => { await blobStore.putReaderImageByKey(item.key, await readMedia(item.file, item.mime)); progress.imageOk++; });
    for (const item of chats) await attempt('import chat failed', async () => {
      const rec = await readJson(item.file, '伴读对话');
      if (!isPlainObject(rec)) throw TypeError('chat record is not an object');
      await blobStore.putReaderChat(item.key, rec);
      if (!item.key.startsWith('comic::')) progress.chatOk++;
    });
    for (const item of vectors) await attempt('import vectors failed', async () => {
      const rec = await readJson(item.file, '伴读检索资料');
      if (!isPlainObject(rec)) throw TypeError('vector record is not an object');
      await blobStore.putReaderVectors(item.key, rec); progress.vectorOk++;
    });
  };
  check();
  for (const book of data.books) {
    check();
    await restoreBuckets(book);
    let indexed = false;
    try {
      const meta = await readJson(book.meta, '伴读书目');
      if (!isPlainObject(meta) || meta.id !== book.id) throw TypeError('book meta does not match its folder');
      if (book.book) {
        const rec = await readJson(book.book, '伴读正文');
        if (!isPlainObject(rec) || typeof rec.fullText !== 'string' || (rec.chapters !== undefined && !Array.isArray(rec.chapters)) || (rec.comicDescriptions !== undefined && !isPlainObject(rec.comicDescriptions))) throw TypeError('book record is invalid');
        const cover = book.cover ? await readMedia(book.cover.file, book.cover.mime) : null;
        check();
        await blobStore.putBookWithCover(book.id, {...rec, meta:{...meta, mode:meta.mode || 'text'}, chapters:rec.chapters || [], sig:typeof rec.sig === 'string' ? rec.sig : '', comicDescriptions:rec.comicDescriptions || {}}, cover);
        progress.ok++;
        if (cover) progress.coverOk++;
        check();
        indexRestoredBook(coread, meta, cover);
        indexed = true;
      } else {
        // 导出时这本书就没有正文：本机没有这本时只补书架条目（之后可补正文），本机已有的不动。
        check();
        progress.noText++;
        if (!(coread().books || []).some((x) => x.id === book.id)) { coread().books.unshift({...meta, hasCover:false}); indexed = true; }
      }
    } catch (e) { check(); progress.failed++; warn('import book failed', e); }
    if (indexed) {
      check();
      try { onBookIndexed(); } catch (_) { check(); throw Error('书目保存请求未确认，后续恢复已停止；原件与本页书目保留，请先导出备份。'); }
      check();
    }
  }
  const shared = data.shared || {};
  await restoreBuckets(shared);
  if (Array.isArray(shared.audio) && shared.audio.length) {
    let decodeFailures = 0;
    function* entries() {
      for (const item of shared.audio) {
        check();
        try { yield {key:item.key, blob:sliceMedia(item.file, item.mime), meta:{...(item.meta || {}), source:'coread'}, createdAt:item.createdAt || Date.now()}; }
        catch (e) { check(); decodeFailures++; progress.failed++; warn('read coread audio failed', e); }
      }
    }
    const failedBeforeAudio = progress.failed;
    const onProgress = result => {
      progress.audioOk = result.added;
      progress.skipped = result.skipped || 0;
      progress.failed = failedBeforeAudio + decodeFailures + (result.failed || 0);
    };
    check();
    try { const result = await blobStore.bulkPutAudio(entries(), {onProgress}); onProgress(result); check(); } catch (e) { check(); progress.failed++; warn('import coread audio failed', e); }
  }
  if (shared.retrievalLogs) {
    let logs = [];
    await attempt('read retrieval logs failed', async () => { logs = await readJson(shared.retrievalLogs, '伴读检索记录'); if (!Array.isArray(logs)) { logs = []; throw TypeError('retrieval logs are not a list'); } });
    for (const item of logs.slice().sort((a, b) => (a?.at || 0) - (b?.at || 0))) {
      check();
      if (!isPlainObject(item)) { progress.invalid++; continue; }
      const rec = {...item}; delete rec.id;
      await attempt('import retrieval log failed', async () => { await blobStore.pushRetLog(rec, 50); progress.logOk++; });
    }
  }
  if (data.prefsUnreadable) progress.prefsUnreadable = 1;
  check();
  return progress;
}

export async function applyCoreadPackageData(data, {blobStore, coread, isPlainObject, base64ToBlob, warn, check = () => {}, onBookIndexed = () => {}, progress = createCoreadImportProgress()}) {
  if (data?.version === 6 && data.zip) return applyCoreadZipPackage(data, {blobStore, coread, isPlainObject, warn, check, onBookIndexed, progress});
  check();
  for (const b of data.books) {
    check();
    if (!b?.meta?.id) { progress.invalid++; continue; }
    let indexed = false;
    try {
      const cover = b.coverB64 ? base64ToBlob(b.coverB64, b.coverMime || 'image/jpeg') : null;
      // Keep import-time book metadata with its original if the later shelf handoff fails.
      // This is not live reading state or proof of ownership; the shelf remains authoritative.
      await blobStore.putBookWithCover(b.meta.id, { meta: { ...b.meta, mode: b.meta.mode || 'text' }, fullText: b.fullText || '', chapters: b.chapters || [], sig: b.sig || '', comicDescriptions: isPlainObject(b.comicDescriptions) ? b.comicDescriptions : {} }, cover);
      progress.ok++;
      if (cover) progress.coverOk++;
      check();
      // A book-only legacy pack preserves the already indexed local cover, not the old reading progress.
      indexRestoredBook(coread, b.meta, cover);
      indexed = true;
    } catch (e) { check(); progress.failed++; warn(`import book failed`, e); }
    // Request host persistence before waiting on the next original/category. This callback is synchronous.
    // A failed request is not a failed original write; stop without rolling back the committed book.
    if (indexed) {
      check();
      try { onBookIndexed(); } catch (_) { check(); throw Error('书目保存请求未确认，后续恢复已停止；原件与本页书目保留，请先导出备份。'); }
      check();
    }
  }
  // 伴读对话 + 记忆切片（reader_chats·按 bucketKey=chatKey::bookId 覆盖式还原·v2 新增）
  if (Array.isArray(data.chats)) {
    for (const c of data.chats) {
      check();
      if (!c?.key || !isPlainObject(c.rec)) { progress.invalid++; continue; }
      // 键为 comic::书 的是漫画页稿，照常恢复，但不算作一段对话。
      try { await blobStore.putReaderChat(c.key, c.rec); if (!String(c.key).startsWith('comic::')) progress.chatOk++; check(); } catch (e) { check(); progress.failed++; warn(`import chat failed`, e); }
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
    let decodeFailures = 0;
    // The existing writer consumes one item only after the previous transaction settles.
    // Do not allocate a decoded Blob for every track before starting the first write.
    function* entries() {
      for (const item of data.audio) {
        check();
        if (!item?.key || !item?.b64) { progress.invalid++; continue; }
        try {
          yield {
            key: item.key,
            blob: base64ToBlob(item.b64, item.mime || 'audio/mpeg'),
            meta: { ...(item.meta || {}), source: 'coread' },
            createdAt: item.createdAt || Date.now(),
          };
        } catch (e) { check(); decodeFailures++; progress.failed++; warn(`decode coread audio failed`, e); }
      }
    }
    check();
    const failedBeforeAudio = progress.failed;
    const onProgress = result => {
      progress.audioOk = result.added;
      progress.skipped = result.skipped || 0;
      progress.failed = failedBeforeAudio + decodeFailures + (result.failed || 0);
    };
    try { const result = await blobStore.bulkPutAudio(entries(), {onProgress}); onProgress(result); check(); } catch (e) { check(); progress.failed++; warn(`import coread audio failed`, e); }
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
  return {ok:0, coverOk:0, chatOk:0, imageOk:0, vectorOk:0, audioOk:0, logOk:0, failed:0, invalid:0, skipped:0, noText:0, prefsUnreadable:0};
}

export function coreadImportProgressText(p) {
  return `已导入 ${p.ok} 本书原件 · ${p.coverOk} 张封面 · ${p.chatOk} 段对话 · ${p.imageOk} 张插图 · ${p.vectorOk} 组向量 · ${p.audioOk} 条语音 · ${p.logOk} 条检索记录；失败 ${p.failed} 项，格式无效 ${p.invalid} 项，已存在音频跳过 ${p.skipped} 项${p.noText ? `；${p.noText} 本书包里没有正文` : ''}。`;
}

// Originals are already committed. Compensate preferences only; never roll back book indexes or stores.
// `save` requests the host's debounced persistence, not a durable-write acknowledgement.
// 偏好与书各自恢复：有书失败时包里的偏好照样应用（阅读记录、主题方案、合集、标签色、首页布局等），只是各自报结果。
// reload：偏好换过之后让运行中的阅读记录重新读一次设置，免得它把内存里的旧记录写回去。
export function finishCoreadPackageImport({reader, progress, hasPrefs, preparePrefs, check, save, refresh, notify, reload = () => {}}) {
  check();
  const partial = !!(progress.failed || progress.invalid);
  let previous, touched = false, prefsFailed = false, saveFailed = false, compensationFailed = false, reloadFailed = false;
  const reloadLive = () => { try { reload(); } catch (_) { reloadFailed = true; } };
  const mutable = key => key !== 'books' && key !== 'enabled' && coreadPackageSafeKey(key);
  const restore = () => {
    let complete = true;
    for (const key of Object.keys(reader).filter(mutable)) {
      try { if (!Object.hasOwn(previous, key)) delete reader[key]; } catch (_) { complete = false; }
    }
    for (const [key, value] of Object.entries(previous)) {
      try { if (mutable(key)) reader[key] = value; } catch (_) { complete = false; }
    }
    return complete;
  };
  if (hasPrefs) {
    previous = {...reader};
    try {
      const prepared = preparePrefs(); // Caller merges only into a detached copy, retaining connection policy.
      check();
      touched = true;
      for (const [key, value] of Object.entries(prepared)) if (mutable(key)) reader[key] = value;
    } catch (_) {
      check(); prefsFailed = true;
      if (touched) compensationFailed = !restore();
    }
    if (touched) reloadLive();
  }
  if (!compensationFailed) {
    try { check(); save(); }
    catch (_) {
      check(); saveFailed = true;
      if (touched && !prefsFailed) { prefsFailed = true; compensationFailed = !restore(); reloadLive(); }
      // A throwing save may have queued a write. Request the compensated state once, never loop.
      if (!compensationFailed) { try { check(); save(); } catch (_) { check(); } }
    }
  }
  check();
  let viewFailed = false;
  if (!compensationFailed) { try { refresh(); } catch (_) { viewFailed = true; } }
  const notes = [coreadImportProgressText(progress)];
  if (compensationFailed) notes.push('阅读偏好还原未完成，请保留当前页面并先导出备份，不要再次覆盖。');
  else if (prefsFailed) notes.push('包内阅读偏好未应用，已保留本机偏好及已恢复书目。');
  else if (hasPrefs) notes.push('阅读偏好已恢复。');
  if (progress.prefsUnreadable) notes.push('包内阅读偏好无法读取，未应用。');
  if (reloadFailed) notes.push('阅读记录未能刷新，请刷新页面后再看统计。');
  if (saveFailed) notes.push('设置保存结果未确认，请保留当前页面并先导出备份；已写入原件保留。');
  if (viewFailed) notes.push('原件写入结果不变，但页面更新未完成，请重新打开千幕检查，不必重复导入。');
  notify(notes.join(' '), compensationFailed || saveFailed ? 'error' : partial || prefsFailed || viewFailed || reloadFailed || progress.prefsUnreadable ? 'warning' : 'success');
  return {preferences:compensationFailed ? 'incomplete' : prefsFailed ? 'retained' : hasPrefs ? 'applied' : 'unchanged', persistence:compensationFailed ? 'uncertain' : saveFailed ? 'uncertain' : 'requested', view:compensationFailed ? 'skipped' : viewFailed ? 'incomplete' : 'updated'};
}
