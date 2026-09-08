import { normalizeCharacterArchive, characterBindingTarget, characterArchiveError } from './qianmu-character-archive.js';
import { comfyLibraryBackupDigest } from './qianmu-comfy-library-backup.js';

export const CHARACTER_LIBRARY_BACKUP_SCHEMA = 'qianmu.character.library-backup.v1';
export const CHARACTER_LIBRARY_BACKUP_BYTES = 24 * 1024 * 1024;
const fail = message => { throw characterArchiveError('backup', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => { if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) fail('角色库备份含未知字段，请保留原文件'); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const canonical = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (a, b) => canonical(a) === canonical(b);
const account = value => { if (typeof value !== 'string' || !/^st-user:.+/.test(value) || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) fail('角色库备份账户无效'); return value; };
const headFields = ['id', 'revision', 'version', 'category', 'name', 'aliases', 'cover', 'bytes', 'createdAt', 'updatedAt'];
const bindingFields = ['category', 'subjectKey', 'scope', 'chatKey', 'archiveId', 'revision', 'updatedAt'];
const project = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
export const characterBackupBindingKey = row => JSON.stringify([row.category, row.subjectKey, row.scope, row.chatKey]);

export function validateCharacterLibraryBackup(value) {
  only(value, ['schema', 'namespace', 'credentialsIncluded', 'archives', 'bindings', 'usage']);
  if (value.schema !== CHARACTER_LIBRARY_BACKUP_SCHEMA || value.credentialsIncluded !== false || !Array.isArray(value.archives) || value.archives.length > 512 || !Array.isArray(value.bindings) || value.bindings.length > 2048) fail('角色库备份格式或数量无效');
  account(value.namespace); const archives = new Map(); let bytes = 0, references = 0;
  for (const row of value.archives) {
    only(row, ['head', 'document']); only(row.head, headFields); const head = row.head;
    if (!id(head.id) || !id(head.revision) || !integer(head.version, 1) || archives.has(head.id) || !integer(head.createdAt) || !integer(head.updatedAt, head.createdAt)) fail('角色档案身份或时间索引无效');
    let document; try { document = normalizeCharacterArchive(row.document); } catch (_) { fail('角色档案原文无效，请保留原件核对'); }
    if (!equal(document, row.document)) fail('角色档案含无法无损保留的字段，未改写或截短');
    if (head.category !== document.category || head.name !== document.name || !equal(head.aliases, document.aliases) || head.cover !== (document.imagegen.preview?.url || '') || head.bytes !== size(document)) fail('角色档案索引与原文不符');
    bytes += head.bytes; references += Number(Boolean(document.imagegen.reference)); archives.set(head.id, row);
  }
  if (bytes > 16 * 1024 * 1024) fail('角色库原文超过 16 MiB');
  const seen = new Set();
  for (const row of value.bindings) {
    only(row, bindingFields); let target;
    try { target = characterBindingTarget(row); } catch (_) { fail('角色绑定位置无效'); }
    if (!equal(target, project(row, ['category', 'subjectKey', 'scope', 'chatKey'])) || !id(row.revision) || !integer(row.updatedAt) || (row.archiveId !== '' && !id(row.archiveId))) fail('角色绑定索引无效');
    const key = characterBackupBindingKey(row); if (seen.has(key)) fail('角色绑定位置重复'); seen.add(key);
    if (row.archiveId && archives.get(row.archiveId)?.head.category !== row.category) fail('角色绑定缺档或分类不符，未猜测同名角色');
  }
  only(value.usage, ['count', 'bytes', 'bindings']);
  if (!equal(value.usage, { count: archives.size, bytes, bindings: seen.size })) fail('角色库计值与原件不符');
  if (size(value) > CHARACTER_LIBRARY_BACKUP_BYTES) fail('角色库备份索引超过 24 MiB');
  return { ...value.usage, references };
}

export function packCharacterLibraryRecords(namespace, records) {
  account(namespace);
  for (const row of records.archives) only(row.head, [...headFields, 'key', 'namespace']);
  for (const row of records.bindings) only(row, [...bindingFields, 'key', 'namespace']);
  only(records.usage, ['key', 'count', 'bytes', 'bindings']);
  if (records.usage.key !== namespace) fail('角色库计值账户不符');
  const value = { schema: CHARACTER_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false,
    archives: records.archives.map(row => ({ head: project(row.head, headFields), document: structuredClone(row.document) })).sort((a, b) => a.head.id.localeCompare(b.head.id)),
    bindings: records.bindings.map(row => project(row, bindingFields)).sort((a, b) => characterBackupBindingKey(a).localeCompare(characterBackupBindingKey(b))),
    usage: project(records.usage, ['count', 'bytes', 'bindings']) };
  validateCharacterLibraryBackup(value); return value;
}

// A character DB retains current documents only, not an immutable ancestor chain. Never infer ancestry from version numbers or clocks.
export function planCharacterLibraryRestore(local, incoming, { decisions = {} } = {}) {
  validateCharacterLibraryBackup(local); validateCharacterLibraryBackup(incoming);
  if (local.namespace !== incoming.namespace) fail('角色库备份属于另一 ST 账户；角色、聊天和文件需显式重新绑定');
  if (!object(decisions)) fail('角色库冲突选择无效');
  const archives = new Map(local.archives.map(row => [row.head.id, row])), bindings = new Map(local.bindings.map(row => [characterBackupBindingKey(row), row]));
  const conflicts = [], archiveWrites = [], bindingWrites = [], keys = new Set(); let kept = 0, added = 0, replaced = 0;
  const choose = (key, previous, next, kind, summary) => {
    if (!previous) { added++; return true; }
    if (equal(previous, next)) { kept++; return false; }
    keys.add(key); const choice = Object.hasOwn(decisions, key) ? decisions[key] : undefined;
    if (choice !== undefined && !['local', 'incoming'].includes(choice)) fail('请选择保留本机或使用备份');
    conflicts.push({ key, kind, ...summary, choice: choice || '' });
    if (choice === 'incoming') { replaced++; return true; } if (choice === 'local') kept++;
    return false;
  };
  for (const row of incoming.archives) {
    const previous = archives.get(row.head.id);
    if (previous && previous.head.category !== row.head.category) fail('同编号角色档案分类不同，不能覆盖或猜测关联');
    if (choose(`archive:${row.head.id}`, previous, row, 'archive', { id: row.head.id, localName: previous?.head.name || '', incomingName: row.head.name, localVersion: previous?.head.version || 0, incomingVersion: row.head.version })) { archives.set(row.head.id, row); archiveWrites.push(row); }
  }
  for (const row of incoming.bindings) {
    const key = characterBackupBindingKey(row), previous = bindings.get(key);
    if (choose(`binding:${key}`, previous, row, 'binding', { category: row.category, subjectKey: row.subjectKey, scope: row.scope, chatKey: row.chatKey, localArchiveId: previous?.archiveId || '', incomingArchiveId: row.archiveId })) { bindings.set(key, row); bindingWrites.push(row); }
  }
  if (Object.keys(decisions).some(key => !keys.has(key))) throw characterArchiveError('choice_stale', '冲突选择已过期，请重新核对');
  const value = { ...local, archives: [...archives.values()].sort((a, b) => a.head.id.localeCompare(b.head.id)), bindings: [...bindings.values()].sort((a, b) => characterBackupBindingKey(a).localeCompare(characterBackupBindingKey(b))), usage: { count: archives.size, bytes: [...archives.values()].reduce((sum, row) => sum + row.head.bytes, 0), bindings: bindings.size } };
  validateCharacterLibraryBackup(value);
  return { value, archiveWrites, bindingWrites, conflicts, ready: conflicts.every(row => row.choice), summary: { added, replaced, kept, conflicts: conflicts.length, archives: value.usage.count, bindings: value.usage.bindings, bytes: value.usage.bytes } };
}
export const characterLibraryBackupDigest = comfyLibraryBackupDigest;
