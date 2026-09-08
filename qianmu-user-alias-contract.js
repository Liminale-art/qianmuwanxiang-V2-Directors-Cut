import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const aliasHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const number=value=>Number.isSafeInteger(value)&&value>=0&&value<=2048;
const fail=()=>{throw Object.assign(new Error('USER地址核对输入或结果无效'),{code:'character_archive_alias'});};
export function validateAliasInput(action,input){
  const keys=['choices',...(action==='user-alias-preview'?['offset']:['digest','confirmed'])];
  if(!['user-alias-preview','user-alias-apply'].includes(action)||!exact(input,keys)||!input.choices||typeof input.choices!=='object'||Array.isArray(input.choices)||Object.keys(input.choices).length>2048||Object.entries(input.choices).some(([key,value])=>!aliasHash(key)||!aliasHash(value)))fail();
  if(action==='user-alias-preview'?!number(input.offset)||input.offset%24:!aliasHash(input.digest)||input.confirmed!==true)fail();return input;
}
export function validateAliasTargets(rows,expected){
  if(!Array.isArray(expected)||expected.length>2048||new Set(expected).size!==expected.length||expected.some(key=>canonicalUserSubjectKey(key)!==key)||!Array.isArray(rows)||rows.length!==expected.length
    ||rows.some((row,index)=>!exact(row,['subjectKey','present'])||row.subjectKey!==expected[index]||typeof row.present!=='boolean'))fail();return rows;
}
export function validateAliasPage(value,namespace,chatHash,input){
  validateAliasInput('user-alias-preview',input);
  if(!exact(value,['version','namespace','chatHash','digest','offset','total','groups','unresolved','missing','ready','rows'])||value.version!==1||value.namespace!==namespace||value.chatHash!==chatHash||!aliasHash(value.chatHash)||!aliasHash(value.digest)
    ||value.offset!==input.offset||![value.total,value.groups,value.unresolved,value.missing].every(number)||value.groups>value.total||value.unresolved>value.groups||value.missing>value.groups||typeof value.ready!=='boolean'||value.ready!==(value.groups>0&&!value.unresolved&&!value.missing)
    ||!Array.isArray(value.rows)||value.rows.length!==Math.min(24,Math.max(0,value.total-value.offset))||value.offset&&value.offset>=value.total)fail();
  for(const row of value.rows){if(!exact(row,['groupId','candidateId','sourceKey','targetKey','scope','chatKey','archiveId','archiveName','selected','conflict','present'])||!aliasHash(row.groupId)||!aliasHash(row.candidateId)
    ||canonicalUserSubjectKey(row.sourceKey)!==row.targetKey||canonicalUserSubjectKey(row.targetKey)!==row.targetKey||!['chat','default'].includes(row.scope)||typeof row.chatKey!=='string'||row.chatKey.length>512||(row.scope==='default'?row.chatKey!=='':!row.chatKey)
    ||typeof row.archiveId!=='string'||!/^[a-zA-Z0-9_-]{0,160}$/.test(row.archiveId)||typeof row.archiveName!=='string'||row.archiveName.length>80||['selected','conflict','present'].some(key=>typeof row[key]!=='boolean')
    ||Object.hasOwn(input.choices,row.groupId)&&row.selected!==(input.choices[row.groupId]===row.candidateId))fail();}return value;
}
export function validateAliasResult(value,namespace,chatHash,input){
  validateAliasInput('user-alias-apply',input);
  if(!exact(value,['version','namespace','chatHash','digest','receiptDigest','before','after','status'])||value.version!==1||value.namespace!==namespace||value.chatHash!==chatHash||value.digest!==input.digest||!aliasHash(value.receiptDigest)||value.status!=='verified'
    ||!number(value.before)||!value.before||!number(value.after)||!value.after||value.after>value.before)fail();return value;
}
