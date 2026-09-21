// A bounded provenance receipt, not a live setting or a persistence claim.
// The host must still verify the current opt-in, source and saved attempt before
// spending. This receipt never authorizes prose insertion, voice or video.
import {normalizeWorldSource,worldSourceKey} from './qianmu-world-source.js';
export const WORLD_AUTOMATIC_APPROVAL_SCHEMA='qianmu.world-automatic-approval.v1';
export function normalizeWorldAutomaticApproval(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==WORLD_AUTOMATIC_APPROVAL_SCHEMA
    ||Object.keys(value).some(key=>!['schema','namespace','requestId','source'].includes(key))
    ||typeof value.namespace!=='string'||!/^st-user:.+$/u.test(value.namespace)||!value.namespace.slice(8).trim()||value.namespace.length>168||/[\u0000-\u001f]/.test(value.namespace)
    ||!/^wa-[a-f0-9]{32}$/.test(value.requestId||''))return null;
  const source=normalizeWorldSource(value.source);
  if(!source)return null;
  return {schema:WORLD_AUTOMATIC_APPROVAL_SCHEMA,namespace:value.namespace,requestId:value.requestId,source};
}
export function worldAutomaticApprovalMatches(value,source,chatKey) {
  const approval=normalizeWorldAutomaticApproval(value),key=worldSourceKey(source);
  return Boolean(approval&&key&&approval.source.chatKey===chatKey&&worldSourceKey(approval.source)===key);
}
