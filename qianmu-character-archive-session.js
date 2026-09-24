import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {createCharacterNativeStore} from './qianmu-character-native-store.js';
import {CHARACTER_NATIVE_SLOT, characterNativeAccount, validateCharacterNativeIndex, characterNativeFail as fail} from './qianmu-character-native-contract.js';
import {validateCharacterStorageSummary} from './qianmu-character-storage.js';
import {requestCharacterMigration,getCharacterMigrationStatus} from './qianmu-character-migration-idle.js';
import {emptyCharacterSources} from './qianmu-character-source-backup.js';

const methods = ['list','load','save','createOnce','bindings','bind','remove','backup','restoreBackup','applyUserAliasReview','storageSummary','usage','overview','legacyImports','previewLegacyImport','legacyDocument','resolveLegacyImport','backupSources','previewSources','verifySources','restoreSources'];
const mutating = new Set(['save','createOnce','bind','remove','restoreBackup','applyUserAliasReview','resolveLegacyImport','restoreSources']);
const optionAt = {backup: 1, storageSummary: 1, createOnce: 2, restoreBackup: 2, applyUserAliasReview: 2, resolveLegacyImport:2,backupSources:1,previewSources:2,verifySources:2,restoreSources:2};
function capture(method, args) {
  const captured = [...args];
  if (['save','createOnce','bind','restoreBackup','applyUserAliasReview','legacyDocument','resolveLegacyImport','previewSources','verifySources','restoreSources'].includes(method)) captured[1] = structuredClone(args[1]);
  const at = optionAt[method];
  if (at !== undefined && args[at]) {
    const value = {...args[at]};
    for (const key of ['decisions','expectedBindings','expectedHeads']) if (Object.hasOwn(value,key)) value[key] = structuredClone(value[key]);
    captured[at] = value;
  }
  return captured;
}

// Compatibility checkpoint: an existing native directory always wins, with no
// failure-to-IDB fallback. Fresh, fully verified empty libraries use native ST.
// Nonempty originals remain usable while the idle first-publication migration
// preserves them. Existing native use also requests deferred old-source audit.
export function createCharacterArchiveSession({createLocal, createStorage = createConfiguredStAccountStorage, requestMigration = requestCharacterMigration} = {}) {
  if (typeof createLocal !== 'function' || typeof createStorage !== 'function') fail('setup','角色库储存环境未就绪');
  let closed = false, owner = '', opening, storage, local, native, inspectedLocal = false, selecting;
  const alive = () => { if (closed) fail('closed','角色库会话已结束'); };
  const getLocal = () => { alive(); return local ||= createLocal(); };
  async function connect(namespace) {
    characterNativeAccount(namespace); alive();
    if (owner && owner !== namespace) fail('account','角色库会话不能切换 ST 账户');
    owner = namespace;
    if (!opening) opening = Promise.resolve().then(() => createStorage({isCurrent: () => !closed, maxBytes: 8 * 1024 * 1024})).then(value => {
      if (closed) { value.close(); fail('closed','角色库会话已结束'); }
      if (value.namespace !== namespace) { value.close(); fail('account','角色库不属于当前 ST 账户'); }
      storage = value; return value;
    }).catch(error => { opening = null; throw error; });
    const value = await opening; alive(); return value;
  }
  const activateNative = (requireExisting = true) => {
    alive();
    if (!native) { native = createCharacterNativeStore({createStorage: async () => storage, requireExisting}); local?.close(); local = null; }
    requestMigration({namespace:owner,createLocal,createStorage});return native;
  };
  async function inspectNative(transport) {
    // Selection only asks whether a native head exists. The delegated native
    // operation reads and validates the complete index before returning data;
    // never download the same catalogue body twice merely to choose a store.
    if(typeof storage.readFingerprint==='function'){
      const fingerprint=await storage.readFingerprint(CHARACTER_NATIVE_SLOT,transport);alive();return fingerprint!==null;
    }
    const result = await storage.read(CHARACTER_NATIVE_SLOT, transport); alive();
    if (result.exists) validateCharacterNativeIndex(result.value, {namespace: owner, scope: storage.scope});
    return result.exists;
  }
  async function select(namespace, transport, check) {
    await connect(namespace); check(); if (native) { requestMigration({namespace,createLocal,createStorage});return native; }
    if (!selecting) selecting = (async () => {
      if (await inspectNative(transport)) return activateNative();
      if (!inspectedLocal) {
        const summary = validateCharacterStorageSummary(await getLocal().storageSummary(namespace, {isCurrent: () => { check(); return true; }}), namespace); check();
        // The atomic IDB metadata/key audit detects orphan originals without
        // loading or normalizing old documents just to decide whether it is empty.
        // Recheck after the IDB audit: another device may have published ST.
        if (await inspectNative(transport)) return activateNative();
        inspectedLocal = true;
        if (!summary.documents.count && !summary.bindings.count) return activateNative(false);
      }
      requestMigration({namespace,createLocal,createStorage});
      return getLocal();
    })().finally(() => { selecting = null; });
    const selected = await selecting; check(); return selected;
  }
  async function invoke(method, input) {
    const args = capture(method, input), namespace = characterNativeAccount(args[0]), options = args[optionAt[method]] || {};
    const current = options.isCurrent ?? (() => true);
    if (typeof current !== 'function') fail('changed','角色库缺少当前身份保护');
    const check = () => { alive(); if (options.signal?.aborted || current() !== true) fail('changed','角色库页面或账户已变化'); };
    const transport = {signal: options.signal, guard: () => { check(); return true; }};
    check(); const selected = await select(namespace, transport, check); check();
    let wrote = false;
    try {
      let result;
      if(selected!==native&&method==='legacyImports')result=[];
      else if(selected!==native&&method==='backupSources')result=emptyCharacterSources(namespace);
      else if(selected!==native&&['previewSources','verifySources','restoreSources'].includes(method))fail('setup','旧本机角色库尚未完成ST保全，请保留原包，待自动迁移完成后重新核对');
      else if(selected!==native&&method==='overview'){const [rows,bindings]=await Promise.all([selected.list(namespace),selected.bindings(namespace)]);result={rows,bindings,imports:[]};}
      else result=await selected[method](...args);
      wrote = mutating.has(method); check();
      if (selected !== native && await inspectNative(transport)) {
        activateNative();
        throw Object.assign(new Error(mutating.has(method)
          ? '角色库已在另一端切换为ST储存；本次本机结果未并入，原件仍保留，请重新核对。不会自动重投。'
          : '角色库已在另一端更新，请重新打开核对'), {code: 'character_archive_changed'});
      }
      check(); return method==='overview'?{...result,migrationStatus:getCharacterMigrationStatus(namespace)}:result;
    } catch (error) {
      if (wrote && error instanceof Error) error.writeState = 'unconfirmed'; throw error;
    }
  }
  return Object.freeze({...Object.fromEntries(methods.map(method => [method, (...args) => invoke(method, args)])),
    close() { closed = true; local?.close(); native?.close(); storage?.close(); },
  });
}
