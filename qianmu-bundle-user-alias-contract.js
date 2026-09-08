import {validateAliasInput,aliasHash} from './qianmu-user-alias-contract.js';
import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
const count=(value,max=2048)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const fail=()=>{throw Object.assign(new Error('原包USER地址核对范围或结果不符'),{code:'storyboard_bundle_user_alias'});};
export const validateBundleAliasInput=input=>validateAliasInput('user-alias-preview',input);
const fields=['version','sourceDigest','digest','total','groups','unresolved','evidenceChanges','unverified','changed','ready'];
function base(value,sourceDigest){
  if(value.version!==1||!aliasHash(value.sourceDigest)||value.sourceDigest!==sourceDigest||!aliasHash(value.digest)||![value.total,value.groups,value.unresolved].every(n=>count(n))
    ||value.groups>value.total||value.unresolved>value.groups||!count(value.evidenceChanges,2080)||!count(value.unverified,2080)||value.unverified>value.evidenceChanges
    ||typeof value.changed!=='boolean'||value.changed!==(value.evidenceChanges>0)||value.ready!==(value.unresolved===0))fail();
}
export function validateBundleAliasSummary(value,sourceDigest){
  if(!exact(value,[...fields,'receiptDigest','targetsReady']))fail();base(value,sourceDigest);
  if(value.receiptDigest!==null&&!aliasHash(value.receiptDigest)||Boolean(value.receiptDigest)!==(value.changed&&value.ready)||value.targetsReady!==null&&typeof value.targetsReady!=='boolean')fail();return value;
}
export function validateBundleAliasPage(value,sourceDigest,input){
  validateBundleAliasInput(input);if(!exact(value,[...fields,'offset','rows']))fail();base(value,sourceDigest);
  if(value.offset!==input.offset||!Array.isArray(value.rows)||value.rows.length!==Math.min(24,Math.max(0,value.total-input.offset))||value.offset&&value.offset>=value.total)fail();
  for(const row of value.rows){
    if(!exact(row,['groupId','candidateId','targetKey','sourceKey','scope','chatKey','archiveId','selected','conflict','archiveName'])||!aliasHash(row.groupId)||!aliasHash(row.candidateId)
      ||canonicalUserSubjectKey(row.sourceKey)!==row.targetKey||canonicalUserSubjectKey(row.targetKey)!==row.targetKey||!['default','chat'].includes(row.scope)||typeof row.chatKey!=='string'||row.chatKey.length>512||(row.scope==='default'?row.chatKey!=='':!row.chatKey)
      ||typeof row.archiveId!=='string'||!/^[a-zA-Z0-9_-]{0,160}$/.test(row.archiveId)||typeof row.archiveName!=='string'||row.archiveName.length>80||typeof row.selected!=='boolean'||typeof row.conflict!=='boolean'
      ||Object.hasOwn(input.choices,row.groupId)&&row.selected!==(input.choices[row.groupId]===row.candidateId))fail();
  }return value;
}
