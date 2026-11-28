// 数据管理的统一导出／导入。
// 导出：勾选项目；只选一项就是那一项自己的备份文件，选多项则打包成一个 zip（各项仍是各自原有的备份文件，原样放进去）。
// 导入：选一个或多个文件（打包文件或单项备份都行），按文件内容自动认出是哪一项，勾选后逐项交给各自原有的导入函数。
// 弹窗沿用清理弹窗的图层与样式。本模块不读写任何数据，只做选择、识别与分发。

export const STORAGE_TRANSFER_ITEMS = Object.freeze([
  ['config', '配置'], ['notes', '便笺'], ['collection', '正文收藏'], ['excerpt', '书摘成图稿'], ['favorites', '语音收藏'], ['audio', '音频缓存'],
  ['reader', '伴读资料'], ['assistant', '场外特助'], ['focus', '专注语音库'], ['ringtones', '来电铃声'],
]);
const LABEL = Object.fromEntries(STORAGE_TRANSFER_ITEMS);
// 配置放最后恢复：它会整页重画，排在前面会打断后面的项目。
const IMPORT_ORDER = STORAGE_TRANSFER_ITEMS.map(([key]) => key).filter(key => key !== 'config').concat('config');

// 各备份文件开头都带有自己的类型标记；只看文件头，不整份解析。
const MARKERS = Object.freeze([
  ['config', /"type"\s*:\s*"qianmu-config"/], ['notes', /"type"\s*:\s*"qianmu-notes"/], ['favorites', /"type"\s*:\s*"qianmu-tts-favorites"/],
  ['audio', /"type"\s*:\s*"qianmu-tts-audio-cache"/], ['reader', /"type"\s*:\s*"qianmu-coread"/], ['collection', /"type"\s*:\s*"qianmu-text-collection"/],
  ['assistant', /"type"\s*:\s*"qianmu-assistant-library"/], ['focus', /"schema"\s*:\s*"qianmu\.focus\.library\.v1"/], ['ringtones', /"type"\s*:\s*"qianmu-ringtones"/],
  ['excerpt', /"type"\s*:\s*"qianmu-excerpt-studio"/],
]);
export async function detectStorageFile(file) {
  let part = file.slice(0, 4096);
  // 单项 zip 只看它第一个条目 manifest.json（不压缩存放），别的条目里碰巧有标记也不算。
  if (await isItemPack(file)) {
    const local = new DataView(await file.slice(0, 30).arrayBuffer()), start = 30 + local.getUint16(26, true) + local.getUint16(28, true);
    part = local.getUint16(8, true) === 0 ? file.slice(start, start + Math.min(local.getUint32(18, true), 4096)) : new Blob([]);
  }
  const head = await part.text();
  return MARKERS.find(([, pattern]) => pattern.test(head))?.[0] || '';
}

// ── 打包：zip。条目逐个以 Blob 拼接，不把整份读进内存。默认只存储不压缩（各备份多是已编码的文本或音频）；
// 标了 deflate 的条目（伴读整包、书摘成图稿里的 JSON）在浏览器支持时压缩。没有 ZIP64：单个文件至多 4 GB、65535 个条目。
const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
export async function crc32(blob) {
  let crc = 0xffffffff;
  for (let at = 0; at < blob.size; at += 4 * 1048576) {
    const bytes = new Uint8Array(await blob.slice(at, at + 4 * 1048576).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const ZIP_LIMIT = 0xfffffffe, ZIP_ENTRIES = 0xffff;
async function deflated(blob) {
  if (typeof globalThis.CompressionStream !== 'function' || !blob.size) return null;
  const packed = await new Response(blob.stream().pipeThrough(new globalThis.CompressionStream('deflate-raw'))).blob();
  return packed.size < blob.size ? packed : null;
}
// files: [{ name, blob, deflate? }]
export async function buildZip(files) {
  if (files.length > ZIP_ENTRIES) throw new Error('备份条目过多，请分几次导出');
  const encoder = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const { name, blob, deflate = false } of files) {
    const label = encoder.encode(name), crc = await crc32(blob), packed = deflate ? await deflated(blob) : null, body = packed || blob, method = packed ? 8 : 0;
    if (blob.size > ZIP_LIMIT || offset + 30 + label.length + body.size > ZIP_LIMIT) throw new Error('备份超过 4 GB，请分几次导出');
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(6, 0x0800, true); header.setUint16(8, method, true);
    header.setUint32(14, crc, true); header.setUint32(18, body.size, true); header.setUint32(22, blob.size, true); header.setUint16(26, label.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true); entry.setUint16(10, method, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, body.size, true); entry.setUint32(24, blob.size, true); entry.setUint16(28, label.length, true); entry.setUint32(42, offset, true);
    parts.push(header, label, body); central.push(entry, label);
    offset += 30 + label.length + body.size;
  }
  const size = central.reduce((sum, part) => sum + part.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  if (offset + size > ZIP_LIMIT) throw new Error('备份超过 4 GB，请分几次导出');
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
export const buildStoragePack = files => buildZip(files.map(({ name, blob }) => ({ name, blob })));
export async function isStoragePack(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
}
// 单项备份本身也可以是 zip（伴读整包 v6、书摘成图稿）：第一个条目是 manifest.json。它们不是多项打包文件，不拆开。
export async function isItemPack(file) {
  const head = new DataView(await file.slice(0, 30 + 64).arrayBuffer());
  if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) return false;
  const length = head.getUint16(26, true);
  return length === 13 && new TextDecoder().decode(new Uint8Array(head.buffer, 30, Math.min(length, head.byteLength - 30))) === 'manifest.json';
}
// 读中央目录：[{ name, method, size, compressedSize, offset }]。只读目录与各条目的本地头，不读正文。
export async function readZipDirectory(file, { invalid = '文件不是有效的 zip', broken = '文件已损坏', incomplete = '文件不完整' } = {}) {
  const tailStart = Math.max(0, file.size - 66000), tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let at = tail.byteLength - 22;
  while (at >= 0 && tail.getUint32(at, true) !== 0x06054b50) at--;
  if (at < 0) throw new Error(invalid);
  const count = tail.getUint16(at + 10, true), size = tail.getUint32(at + 12, true), start = tail.getUint32(at + 16, true);
  if (start + size > file.size) throw new Error(incomplete);
  const directory = new DataView(await file.slice(start, start + size).arrayBuffer()), decoder = new TextDecoder(), entries = [];
  for (let index = 0, cursor = 0; index < count; index++) {
    if (cursor + 46 > directory.byteLength || directory.getUint32(cursor, true) !== 0x02014b50) throw new Error(invalid);
    const method = directory.getUint16(cursor + 10, true), compressedSize = directory.getUint32(cursor + 20, true), length = directory.getUint32(cursor + 24, true);
    const nameLength = directory.getUint16(cursor + 28, true), skip = directory.getUint16(cursor + 30, true) + directory.getUint16(cursor + 32, true), offset = directory.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > directory.byteLength) throw new Error(invalid);
    const name = decoder.decode(new Uint8Array(directory.buffer, cursor + 46, nameLength));
    const local = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
    if (local.byteLength < 30 || local.getUint32(0, true) !== 0x04034b50) throw new Error(broken);
    const data = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (data + compressedSize > file.size || (method === 0 && data + length > file.size)) throw new Error(incomplete);
    entries.push({ name, method, size: length, compressedSize, offset: data });
    cursor += 46 + nameLength + skip;
  }
  return entries;
}
// 取一个条目的内容。存储的直接切片；压缩的边解压边计数，超过 maxBytes 或与目录记的大小不符就报错。
export async function zipEntryBlob(file, entry, { type = '', maxBytes = Infinity } = {}) {
  if (entry.size > maxBytes) throw new Error('条目超过读取上限');
  const raw = file.slice(entry.offset, entry.offset + entry.compressedSize);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new Error('条目大小不符');
    return type ? raw.slice(0, raw.size, type) : raw;
  }
  if (entry.method !== 8) throw new Error('条目压缩方式不支持');
  if (typeof globalThis.DecompressionStream !== 'function') throw new Error('此浏览器不能解压这份备份');
  let total = 0;
  const limit = Math.min(maxBytes, entry.size);
  const count = new TransformStream({ transform(chunk, controller) { total += chunk.byteLength; if (total > limit) controller.error(new Error('条目超过读取上限')); else controller.enqueue(chunk); } });
  const blob = await new Response(raw.stream().pipeThrough(new globalThis.DecompressionStream('deflate-raw')).pipeThrough(count)).blob();
  if (blob.size !== entry.size) throw new Error('条目大小不符');
  return type ? blob.slice(0, blob.size, type) : blob;
}
// 读回打包文件里的各份备份。只认本模块写出的那种（不压缩）；别的 zip 一律拒绝，不猜。
export async function openStoragePack(file, FileClass = globalThis.File) {
  const entries = await readZipDirectory(file, { invalid: '不是千幕的打包备份', broken: '打包备份已损坏', incomplete: '打包备份不完整' });
  if (entries.some(entry => entry.method !== 0)) throw new Error('不是千幕的打包备份');
  return entries.map(entry => new FileClass([file.slice(entry.offset, entry.offset + entry.size)], entry.name.split('/').pop(), { type: 'application/json' }));
}

// ── 弹窗 ──
// deps: document, layerId, modal()（主面板，可无）, themeClass(), variables（要抄到浮层上的主题变量名）, icons(node), mountPortal(node), lifetime(layer, modal, resolve)
export function createStorageDialogs({ document, layerId, modal = () => null, themeClass = () => '', variables = [], icons = () => {}, mountPortal = () => {}, lifetime, escape }) {
  function open(inner, collect) {
    document.getElementById(layerId)?.remove();
    return new Promise(resolve => {
      const layer = document.createElement('div'), host = modal(), source = host ? document.defaultView.getComputedStyle(host) : null;
      layer.id = layerId; layer.className = themeClass();
      for (const name of variables) { const value = source?.getPropertyValue(name); if (value) layer.style.setProperty(name, value); }
      layer.innerHTML = `<button type="button" class="sd-storage-cleanup-backdrop" aria-label="取消"></button>${inner}`;
      document.body.appendChild(layer);
      icons(layer);
      const finish = lifetime(layer, host, resolve);
      mountPortal(layer);
      const confirm = layer.querySelector('.sd-storage-cleanup-confirm');
      const sync = () => { if (confirm) confirm.disabled = !layer.querySelector('input:checked'); };
      layer.addEventListener('change', sync); sync();
      confirm?.addEventListener('click', () => finish(collect(layer)));
      for (const selector of ['.sd-storage-cleanup-backdrop', '.sd-storage-cleanup-close', '.sd-storage-cleanup-cancel']) layer.querySelector(selector)?.addEventListener('click', () => finish(null));
    });
  }
  const frame = (title, body, action, { danger = '', note = '', extra = '' } = {}) => `<section class="sd-storage-cleanup-dialog${extra}" role="dialog" aria-modal="true" aria-label="${title}">
    <header><div><h3>${title}</h3>${danger ? `<p class="is-danger">${danger}</p>` : ''}${note ? `<p>${note}</p>` : ''}</div><button type="button" class="sd-icon-btn sd-storage-cleanup-close" title="取消" aria-label="取消"><i class="fa-solid fa-xmark"></i></button></header>
    ${body}
    <footer><button type="button" class="sd-btn sd-storage-cleanup-cancel">取消</button><button type="button" class="sd-btn sd-primary sd-storage-cleanup-confirm" disabled>${action}</button></footer>
  </section>`;
  const option = item => `<label><input type="checkbox" value="${escape(item.id)}" ${item.checked ? 'checked' : ''} ${item.disabled ? 'disabled' : ''}><span><b>${escape(item.label)}</b>${item.meta ? `<small>${escape(item.meta)}</small>` : ''}</span></label>`;
  return {
    // items: [{ id, label, meta?, checked?, disabled? }]。返回勾选的 id 数组；取消返回 null。
    choose({ title, action, items, danger, note }) {
      return open(frame(title, `<div class="sd-storage-cleanup-list">${items.map(option).join('')}</div>`, action, { danger, note }), layer => [...layer.querySelectorAll('input:checked')].map(input => input.value));
    },
    // groups: [{ id, label, meta, items: [{ id, label, meta }] }]。返回 [{ group, item }]；取消返回 null。
    chooseGrouped({ title, action, groups, danger, empty }) {
      const rows = groups.map(group => `<details class="sd-storage-chat-group"><summary><span><b>${escape(group.label)}</b><small>${escape(group.meta)}</small></span></summary><div>${group.items.map(item =>
        `<label><input type="checkbox" data-group="${escape(group.id)}" value="${escape(item.id)}"><span><b>${escape(item.label)}</b><small>${escape(item.meta)}</small></span></label>`).join('')}</div></details>`).join('');
      return open(frame(title, `<div class="sd-storage-chat-groups">${rows || `<p class="sd-muted">${empty}</p>`}</div>`, action, { danger, extra: ' sd-storage-chat-cleanup-dialog' }),
        layer => [...layer.querySelectorAll('input:checked')].map(input => ({ group: input.dataset.group, item: input.value })));
    },
  };
}

// ── 导出 ──
// exports: { key: (button) => Promise }；capture(work) 在 work 期间把各项要下载的文件收集起来并返回 [{ blob, name }]；download(blob, name) 真正下载。
export async function runStorageExport({ dialogs, exports, capture, download, notify, stamp, button }) {
  const picked = await dialogs.choose({ title: '导出', action: '导出', note: '选多项会打包成一个文件',
    items: STORAGE_TRANSFER_ITEMS.filter(([key]) => exports[key]).map(([id, label]) => ({ id, label, checked: id !== 'audio' })) });
  if (!picked?.length) return;
  const each = async key => { try { await exports[key](button); } catch (error) { notify(`${LABEL[key]}导出未完成：${error?.message || error}`, 'warning'); } };
  if (picked.length === 1) return each(picked[0]);
  const files = await capture(async () => { for (const key of picked) await each(key); });
  if (!files.length) return notify('没有可导出的内容。', 'info');
  if (files.length === 1) return download(files[0].blob, files[0].name);
  try {
    const names = new Set();
    const unique = files.map(({ blob, name }) => { let label = name; for (let n = 2; names.has(label); n++) label = name.replace(/(\.[^.]*)?$/, `-${n}$1`); names.add(label); return { blob, name: label }; });
    download(await buildStoragePack(unique), `qianmu-backup-${stamp()}.zip`);
    notify(`已打包导出 ${files.length} 个文件。`, 'success');
  } catch (error) {
    // 打包不成就退回逐个下载，已经备好的内容不丢。
    for (const file of files) { download(file.blob, file.name); await new Promise(resolve => setTimeout(resolve, 400)); }
    notify(`未能打包（${error?.message || error}），已改为逐个下载。`, 'warning');
  }
}

// ── 导入 ──
// imports: { key: (file, input, event) => Promise }。slot 是卡片里一枚常驻的隐藏文件输入：个别导入函数要从「输入框事件」里取文件，这里把文件放进去再交给它们。
export async function runStorageImport({ dialogs, imports, files, slot, notify, DataTransferClass = globalThis.DataTransfer }) {
  const found = [], unknown = [];
  for (const file of files) {
    let batch = [file];
    try { if (await isStoragePack(file) && !await isItemPack(file)) batch = await openStoragePack(file); }
    catch (error) { unknown.push(file.name); notify(`${file.name}：${error?.message || error}`, 'warning'); continue; }
    for (const item of batch) { const key = await detectStorageFile(item); if (key && imports[key]) found.push({ key, file: item }); else unknown.push(item.name); }
  }
  if (!found.length) return notify(unknown.length ? '选中的文件不是千幕的备份。' : '没有可导入的内容。', 'warning');
  if (unknown.length) notify(`${unknown.length} 个文件不是千幕的备份，已略过。`, 'info');
  const picked = await dialogs.choose({ title: '导入', action: '导入', items: found.map((item, index) => ({ id: String(index), label: LABEL[item.key], meta: item.file.name, checked: true })) });
  if (!picked?.length) return;
  const queue = picked.map(index => found[Number(index)]).sort((a, b) => IMPORT_ORDER.indexOf(a.key) - IMPORT_ORDER.indexOf(b.key));
  for (const { key, file } of queue) {
    try {
      if (slot && DataTransferClass) { const carrier = new DataTransferClass(); carrier.items.add(file); slot.files = carrier.files; }
      await imports[key](file, slot, { target: slot, currentTarget: slot });
    } catch (error) { notify(`${LABEL[key]}导入未完成：${error?.message || error}`, 'warning'); }
    finally { if (slot) slot.value = ''; }
  }
}
