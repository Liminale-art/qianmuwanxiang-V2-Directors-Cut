import {characterArchiveError, characterBindingTarget} from './qianmu-character-archive.js';
import {validateCharacterLibraryBackup, CHARACTER_LIBRARY_BACKUP_SCHEMA, characterBackupBindingKey} from './qianmu-character-library-backup.js';
import {stAccountImmutableReference} from './qianmu-st-account-storage.js';

export const CHARACTER_NATIVE_SLOT = 'character-library';
export const CHARACTER_ORIGINAL_SLOT = 'character-record';
export const CHARACTER_NATIVE_SCHEMA = 'qianmu.character.native-index.v1';
export const CHARACTER_ORIGINAL_SCHEMA = 'qianmu.character.original.v1';
export const characterNativeFail = (code, message) => { throw characterArchiveError(code, message); };
export const characterNativeBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const characterNativeEqual = (a, b) => JSON.stringify(a, canonical) === JSON.stringify(b, canonical);
function canonical(_, value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
}
export const characterNativeExact = (value, keys) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => { const field = Object.getOwnPropertyDescriptor(value, key); return field?.enumerable && Object.hasOwn(field, 'value'); });
export function characterNativeAccount(value) {
  if (typeof value !== 'string' || !/^st-user:.+/.test(value) || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) characterNativeFail('account', '角色库缺少当前 ST 账户');
  return value;
}
export const characterNativeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const headKeys = ['id', 'revision', 'version', 'category', 'name', 'aliases', 'cover', 'bytes', 'createdAt', 'updatedAt'];
const bindingKeys = ['category', 'subjectKey', 'scope', 'chatKey', 'archiveId', 'revision', 'updatedAt'];
export function characterNativeHead(value) {
  if (!characterNativeExact(value, headKeys) || !characterNativeId(value.id) || !characterNativeId(value.revision)
    || !integer(value.version, 1) || !['char', 'user', 'other'].includes(value.category)
    || typeof value.name !== 'string' || !value.name || value.name.length > 80 || value.name.trim() !== value.name
    || !Array.isArray(value.aliases) || value.aliases.length > 24 || new Set(value.aliases).size !== value.aliases.length
    || value.aliases.some(item => typeof item !== 'string' || !item || item.length > 80 || item.trim() !== item)
    || typeof value.cover !== 'string' || value.cover.length > 2048 || !integer(value.bytes, 1) || value.bytes > 64 * 1024
    || !integer(value.createdAt) || !integer(value.updatedAt, value.createdAt)) characterNativeFail('index', '角色档案目录无效，未改写原件');
  return value;
}
export function characterNativeBinding(value) {
  if (!characterNativeExact(value, bindingKeys) || !characterNativeId(value.revision) || !integer(value.updatedAt)
    || value.archiveId !== '' && !characterNativeId(value.archiveId)) characterNativeFail('index', '角色绑定目录无效');
  const target = characterBindingTarget(value);
  if (!characterNativeEqual(target, Object.fromEntries(['category', 'subjectKey', 'scope', 'chatKey'].map(key => [key, value[key]])))) characterNativeFail('index', '角色绑定位置未经完整保留');
  return value;
}
export const characterNativeStoredHead = (namespace, head) => ({key: JSON.stringify([namespace, head.id]), namespace, ...structuredClone(head)});
export const characterNativeStoredBinding = (namespace, row) => ({key: JSON.stringify([namespace, row.category, row.subjectKey, row.scope, row.chatKey]), namespace, ...structuredClone(row)});
export const characterNativeUsage = archives => archives.reduce((sum, row) => sum + row.head.bytes, 0);
export function emptyCharacterNativeIndex(namespace) {
  return {schema: CHARACTER_NATIVE_SCHEMA, namespace: characterNativeAccount(namespace), revision: 0, archives: [], bindings: [],
    usage: {count: 0, bytes: 0, bindings: 0}, retired: {archives: [], bindings: []}};
}
// Deleted identities are retained in the directory so a later old-device import
// cannot silently resurrect them. These are not visible records or physical deletes.
export function validateCharacterNativeIndex(value, {namespace, scope}) {
  characterNativeAccount(namespace);
  if (!characterNativeExact(value, ['schema', 'namespace', 'revision', 'archives', 'bindings', 'usage', 'retired'])
    || value.schema !== CHARACTER_NATIVE_SCHEMA || value.namespace !== namespace || !integer(value.revision)
    || !Array.isArray(value.archives) || value.archives.length > 512 || !Array.isArray(value.bindings) || value.bindings.length > 2048
    || !characterNativeExact(value.usage, ['count', 'bytes', 'bindings']) || !characterNativeExact(value.retired, ['archives', 'bindings'])) characterNativeFail('index', '角色库目录格式或数量无效');
  const archives = new Map(), bindings = new Set();
  for (const row of value.archives) {
    if (!characterNativeExact(row, ['head', 'original'])) characterNativeFail('index', '角色目录含无法保留的字段');
    const head = characterNativeHead(row.head);
    if (archives.has(head.id)) characterNativeFail('index', '角色目录存在重复编号');
    stAccountImmutableReference(row.original, {scope, slot: CHARACTER_ORIGINAL_SLOT, maxBytes: 96 * 1024});
    if (head.bytes >= row.original.bytes) characterNativeFail('index', '角色原件计值无效');
    archives.set(head.id, head);
  }
  for (const input of value.bindings) {
    const row = characterNativeBinding(input), key = characterBackupBindingKey(row);
    if (bindings.has(key) || row.archiveId && archives.get(row.archiveId)?.category !== row.category) characterNativeFail('index', '角色绑定重复、缺档或分类不符');
    bindings.add(key);
  }
  for (const name of ['archives', 'bindings']) {
    const rows = value.retired[name];
    if (!Array.isArray(rows) || rows.length > 8192 || new Set(rows).size !== rows.length) characterNativeFail('capacity', '角色历史删除标记过多或无效，未截断');
    for (const row of rows) {
      if (name === 'archives') { if (!characterNativeId(row) || archives.has(row)) characterNativeFail('index', '角色删除标记与现有目录不符'); }
      else {
        let tuple; try { tuple = JSON.parse(row); } catch { characterNativeFail('index', '角色绑定删除标记无效'); }
        if (!Array.isArray(tuple) || tuple.length !== 4 || JSON.stringify(tuple) !== row || bindings.has(row)) characterNativeFail('index', '角色绑定删除标记无效');
        const target = characterBindingTarget({category: tuple[0], subjectKey: tuple[1], scope: tuple[2], chatKey: tuple[3]});
        if (characterBackupBindingKey(target) !== row) characterNativeFail('index', '角色绑定删除位置不符');
      }
    }
  }
  const usage = {count: archives.size, bytes: characterNativeUsage(value.archives), bindings: bindings.size};
  if (!characterNativeEqual(value.usage, usage) || usage.bytes > 16 * 1024 * 1024 || characterNativeBytes(value) > 8 * 1024 * 1024) characterNativeFail('capacity', '角色库计值不符或达到上限，未截断原文');
  return value;
}
export function characterNativeBackup(namespace, archives, bindings) {
  const value = {schema: CHARACTER_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false,
    archives: structuredClone(archives).sort((a, b) => a.head.id.localeCompare(b.head.id)),
    bindings: structuredClone(bindings).sort((a, b) => characterBackupBindingKey(a).localeCompare(characterBackupBindingKey(b))),
    usage: {count: archives.length, bytes: characterNativeUsage(archives), bindings: bindings.length}};
  validateCharacterLibraryBackup(value); return value;
}
export function createCharacterNativeOriginals(storage) {
  const namespace = characterNativeAccount(storage.namespace), scope = storage.scope;
  function validate(value) {
    if (!characterNativeExact(value, ['schema', 'namespace', 'head', 'document']) || value.schema !== CHARACTER_ORIGINAL_SCHEMA || value.namespace !== namespace) characterNativeFail('original', '角色原件不属于当前账户或格式无效');
    characterNativeHead(value.head); characterNativeBackup(namespace, [{head: value.head, document: value.document}], []);
    return value;
  }
  return Object.freeze({
    async preserve(input, options) {
      const value = validate({schema: CHARACTER_ORIGINAL_SCHEMA, namespace, ...structuredClone(input)});
      const saved = await storage.preserveImmutable(CHARACTER_ORIGINAL_SLOT, value, options);
      if (saved?.exists !== true || !characterNativeEqual(validate(saved.value), value)) characterNativeFail('original', '角色原件保存回读不一致');
      const original = stAccountImmutableReference(saved.reference, {scope, slot: CHARACTER_ORIGINAL_SLOT, maxBytes: 96 * 1024});
      if (saved.fingerprint !== original.fingerprint) characterNativeFail('original', '角色原件保存版本不一致');
      return {head: structuredClone(value.head), original};
    },
    async read(input, options) {
      if (!characterNativeExact(input, ['head', 'original'])) characterNativeFail('original', '角色原件目录无效');
      const captured = structuredClone(input); characterNativeHead(captured.head);
      const reference = stAccountImmutableReference(captured.original, {scope, slot: CHARACTER_ORIGINAL_SLOT, maxBytes: 96 * 1024});
      const saved = await storage.readImmutable(reference, options);
      if (saved?.exists !== true || saved.fingerprint !== reference.fingerprint || !characterNativeEqual(saved.reference, reference)
        || !characterNativeEqual(validate(saved.value).head, captured.head)) characterNativeFail('original', '角色原件与当前目录不符，未使用其他版本替代');
      return {head: structuredClone(saved.value.head), document: structuredClone(saved.value.document)};
    },
  });
}
