import {captureStAccountStorageWorkerContext, isStAccountStorageConfigured, createStAccountStorage} from './qianmu-st-account-storage.js';
import {characterNativeAccount, characterNativeExact, characterNativeFail as fail} from './qianmu-character-native-contract.js';

export async function captureCharacterWorkerStorage(namespace, guard) {
  characterNativeAccount(namespace);
  if (typeof guard !== 'function') fail('setup','角色库后台缺少账户保护');
  await guard(); if (!isStAccountStorageConfigured()) return null;
  const value = await captureStAccountStorageWorkerContext(); await guard();
  if (value.namespace !== namespace) fail('account','角色库后台账户不一致');
  return value;
}

// Only the same ST origin/account and CSRF cross the boundary. The worker must
// ask its owner for a LIVE identity guard on every native transport check; this
// captured identity is not permission by itself and contains no model API key.
export function characterWorkerStorageOptions(value, {namespace, origin = globalThis.location?.origin, guard, isCurrent = () => true} = {}) {
  if (value === undefined || value === null) return false;
  characterNativeAccount(namespace);
  if (!characterNativeExact(value, ['namespace','origin','csrf']) || value.namespace !== namespace || value.origin !== origin
    || typeof value.csrf !== 'string' || value.csrf.length > 8192 || /[\r\n]/.test(value.csrf) || typeof guard !== 'function' || typeof isCurrent !== 'function') fail('account','角色库后台储存来源无效');
  let site; try { site = new URL(origin); } catch { fail('account','角色库后台站点无效'); }
  if (!['http:','https:'].includes(site.protocol) || site.origin !== origin) fail('account','角色库后台仅能访问当前 ST 站点');
  const captured = {...value};
  return {createStorage: options => createStAccountStorage({...options, origin, isCurrent: () => isCurrent() === true && (!options?.isCurrent || options.isCurrent() === true),
    resolveNamespace: async () => { if (isCurrent() !== true) fail('changed','角色库后台会话已结束'); await guard(); return namespace; },
    headers: () => ({'X-CSRF-Token': captured.csrf})})};
}
