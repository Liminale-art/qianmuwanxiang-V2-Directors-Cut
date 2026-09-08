import { inspectStoryboardSubjectEvidence, storyboardSubjectTargets } from './qianmu-storyboard-subject-evidence.js';
import { characterBackupBindingKey, validateCharacterLibraryBackup } from './qianmu-character-library-backup.js';
import { comfyLibraryBackupDigest as digest } from './qianmu-comfy-library-backup.js';

export const SUBJECT_MAP_SCHEMA = 'qianmu.storyboard.subject-map.v1';
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_subject_map', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const subjectMapKey = row => JSON.stringify([row.category,row.subjectKey]);
const physicalTargetKey = row => {
  if(row.category!=='user')return subjectMapKey(row);
  const match=/^user:\/User(?:%20| )Avatars\/(.+)$/.exec(row.subjectKey);if(!match)return subjectMapKey(row);
  let name;try{name=decodeURIComponent(match[1]);}catch(_){fail('人设目标头像标识编码无效');}
  if(!name || /[\/\\\u0000-\u001f\u007f]/.test(name) || name==='.' || name==='..')fail('人设目标头像标识无效');
  return JSON.stringify(['user',name]);
};
export function validStoryboardSubjectTargetPage(value,{sourceBound=false}={}) {
  if(!exact(value,['category','query','offset','total','rows',...(sourceBound?['sourceDigest']:[])]) || sourceBound&&!hash(value.sourceDigest) || !['char','user'].includes(value.category) || typeof value.query!=='string' || value.query.length>160
    || !Number.isSafeInteger(value.offset) || value.offset<0 || value.offset%24 || !Number.isSafeInteger(value.total) || value.total<0 || value.total>100000
    || !Array.isArray(value.rows) || value.rows.length!==Math.min(24,Math.max(0,value.total-value.offset)) || value.offset&&value.offset>=value.total)return false;
  try {return value.rows.every(row=>exact(row,['category','subjectKey','name']) && row.category===value.category && typeof row.name==='string' && row.name.length<=240)
    && storyboardSubjectTargets(value.rows).length===value.rows.length;}catch(_){return false;}
}
export function normalizeStoryboardSubjectMappings(input, subjects) {
  if (!Array.isArray(input) || input.length > 2048) fail('角色目标映射数量无效');
  const source = new Map(storyboardSubjectTargets(subjects).map(row => [subjectMapKey(row),row])), choices = new Map();
  for (const row of input) {
    if (!exact(row,['category','sourceKey','targetKey']) || !['char','user'].includes(row.category)) fail('只可映射CHAR或USER的ST绑定目标');
    const [target] = storyboardSubjectTargets([{ category:row.category,subjectKey:row.targetKey }]);
    const key = subjectMapKey({category:row.category,subjectKey:row.sourceKey});
    if (!source.has(key) || choices.has(key) || row.targetKey === row.sourceKey) fail('角色目标映射重复、过期或未发生变化');
    if (row.category === 'char' ? !/^char:[^/\\]+$/.test(target.subjectKey) : !/^user:\/User(?:%20| )Avatars\/.+$/.test(target.subjectKey)) fail('请选择真实ST角色文件或人设头像目标');
    choices.set(key,{category:row.category,sourceKey:row.sourceKey,targetKey:row.targetKey});
  }
  const used = new Set();
  for (const [key,row] of source) {
    const target = physicalTargetKey({category:row.category,subjectKey:choices.get(key)?.targetKey || row.subjectKey});
    if (used.has(target)) fail('多个来源不能合并为同一个角色或人设，请逐项核对');used.add(target);
  }
  return [...choices.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,row]) => row);
}
export function mappedStoryboardSubjectTargets(subjects, mappings) {
  const choices = normalizeStoryboardSubjectMappings(mappings,subjects), bySource = new Map(choices.map(row => [subjectMapKey({category:row.category,subjectKey:row.sourceKey}),row.targetKey]));
  return storyboardSubjectTargets(subjects.map(row => ({category:row.category,subjectKey:bySource.get(subjectMapKey(row)) || row.subjectKey})));
}
export function assertSubjectMappingTargetsUnambiguous(local,mappings) {
  const destinations=new Map(mappings.map(row=>[physicalTargetKey({category:row.category,subjectKey:row.targetKey}),row.targetKey]));
  for(const row of local.bindings){const expected=destinations.get(physicalTargetKey(row));if(expected&&expected!==row.subjectKey)fail('本机同一人设存在另一种地址格式的绑定，请先在角色库核对，不能绕过原绑定覆盖选择');}
}
export async function deriveStoryboardSubjectBindings(library, evidence, input, sourceDigest) {
  validateCharacterLibraryBackup(library);if (!hash(sourceDigest)) fail('角色映射缺少原包摘要');
  const source = await inspectStoryboardSubjectEvidence(evidence), mappings = normalizeStoryboardSubjectMappings(input, source.subjects);
  const available = new Set(library.bindings.map(subjectMapKey));
  if (mappings.some(row => !available.has(subjectMapKey({category:row.category,subjectKey:row.sourceKey})))) fail('来源缺少可映射的ST绑定');
  const targets = new Map(mappings.map(row => [subjectMapKey({category:row.category,subjectKey:row.sourceKey}),row.targetKey])), bindings = [], lineage = [];
  for (const row of library.bindings) {
    const targetKey = targets.get(subjectMapKey(row));if (!targetKey) {bindings.push(row);continue;}
    // A new binding gets a derived revision; archive documents, IDs, old snapshots and source rows are untouched.
    const next = {...row,subjectKey:targetKey,revision:'mapped-'+await digest({sourceDigest,source:row,targetKey})};
    bindings.push(next);lineage.push({source:structuredClone(row),target:structuredClone(next)});
  }
  bindings.sort((a,b) => characterBackupBindingKey(a).localeCompare(characterBackupBindingKey(b)));
  const value = {...library,bindings};validateCharacterLibraryBackup(value);
  return {value,mappings,lineage};
}
export async function compareMappedStoryboardSubjects(source, target, bindings, input) {
  source = await inspectStoryboardSubjectEvidence(source);target = await inspectStoryboardSubjectEvidence(target);
  const mappings = normalizeStoryboardSubjectMappings(input,source.subjects), desired = mappedStoryboardSubjectTargets(source.subjects,mappings);
  if (JSON.stringify(desired) !== JSON.stringify(storyboardSubjectTargets(target.subjects))) fail('角色映射目标核对不完整');
  const bySource = new Map(mappings.map(row => [subjectMapKey({category:row.category,subjectKey:row.sourceKey}),row.targetKey]));
  const actual = new Map(target.subjects.map(row => [subjectMapKey(row),row])), required = new Set(storyboardSubjectTargets(bindings.filter(row => row.archiveId)).map(subjectMapKey));
  if ([...required].some(key => !actual.has(key))) fail('角色来源缺少待恢复的绑定');
  const rows = source.subjects.map(row => {
    const targetKey = bySource.get(subjectMapKey(row)) || row.subjectKey, current = actual.get(subjectMapKey({category:row.category,subjectKey:targetKey}));
    return {category:row.category,subjectKey:row.subjectKey,...(targetKey !== row.subjectKey ? {targetKey} : {}),required:required.has(subjectMapKey(current)),
      state:current.state === 'missing' ? 'missing' : row.state !== 'present' || current.state !== 'present' ? 'unverified' : row.sha256 === current.sha256 ? 'matched' : 'changed'};
  });
  const ready = !rows.some(row => row.required && row.state === 'missing') && mappings.every(row => actual.get(subjectMapKey({category:row.category,subjectKey:row.targetKey})).state === 'present');
  return {rows,ready,targetEvidence:target,digest:await digest({source:source.digest,target:target.digest,required:[...required].sort(),mappings})};
}
export async function createStoryboardSubjectMapReview({namespace,chatHash,sourceDigest,environmentDigest=null,sourceEvidence,targetEvidence,lineage,mappings}) {
  if (!hash(chatHash) || !hash(sourceDigest) || environmentDigest !== null && !hash(environmentDigest) || typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512) fail('角色映射缺少环境来源');
  const source = await inspectStoryboardSubjectEvidence(sourceEvidence), target = await inspectStoryboardSubjectEvidence(targetEvidence);
  const choices = normalizeStoryboardSubjectMappings(mappings,source.subjects);
  if (!choices.length || !Array.isArray(lineage) || lineage.length > 2048) fail('角色映射来源清单无效');
  const sourceByKey = new Map(source.subjects.map(row => [subjectMapKey(row),row])), targetByKey = new Map(target.subjects.map(row => [subjectMapKey(row),row]));
  const rows = choices.map(row => {
    const before = sourceByKey.get(subjectMapKey({category:row.category,subjectKey:row.sourceKey})), after = targetByKey.get(subjectMapKey({category:row.category,subjectKey:row.targetKey}));
    if (after?.state !== 'present') fail('所选角色或人设未载入完整资料，请先在ST中确认目标');
    return {...row,sourceState:before.state,sourceHash:before.sha256,targetHash:after.sha256};
  });
  const value = {schema:SUBJECT_MAP_SCHEMA,scope:'declared-binding-mappings',namespace,chatHash,sourceDigest,environmentDigest,rows,lineage:structuredClone(lineage)};
  return {...value,digest:await digest(value)};
}
export async function inspectStoryboardSubjectMapReview(value) {
  if (!exact(value,['schema','scope','namespace','chatHash','sourceDigest','environmentDigest','rows','lineage','digest']) || value.schema !== SUBJECT_MAP_SCHEMA || value.scope !== 'declared-binding-mappings'
    || typeof value.namespace !== 'string' || !/^st-user:.+/.test(value.namespace) || value.namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(value.namespace)
    || !hash(value.chatHash) || !hash(value.sourceDigest) || !hash(value.digest) || value.environmentDigest !== null && !hash(value.environmentDigest)
    || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 2048 || !Array.isArray(value.lineage) || value.lineage.length > 2048) fail('角色映射凭据结构无效');
  const choices=value.rows.map(row => {
    if (!exact(row,['category','sourceKey','targetKey','sourceState','sourceHash','targetHash']) || !['present','missing','unavailable'].includes(row.sourceState)
      || (row.sourceState==='present' ? !hash(row.sourceHash) : row.sourceHash!==null) || !hash(row.targetHash)) fail('角色映射凭据缺少内容摘要');
    return {category:row.category,sourceKey:row.sourceKey,targetKey:row.targetKey};
  });
  const normalized=normalizeStoryboardSubjectMappings(choices,choices.map(row=>({category:row.category,subjectKey:row.sourceKey})));
  if (JSON.stringify(choices)!==JSON.stringify(normalized)) fail('角色映射凭据顺序不符');
  const bindings=new Set(),covered=new Set(),bySource=new Map(choices.map(row=>[subjectMapKey({category:row.category,subjectKey:row.sourceKey}),row]));
  for(const pair of value.lineage){
    if(!exact(pair,['source','target']))fail('角色绑定谱系结构无效');
    for(const row of [pair.source,pair.target]){
      if(!exact(row,['category','subjectKey','scope','chatKey','archiveId','revision','updatedAt']) || !['char','user'].includes(row.category) || !['chat','default'].includes(row.scope)
        || typeof row.chatKey!=='string' || row.chatKey.length>512 || (row.scope==='default' ? row.chatKey!=='' : !row.chatKey)
        || typeof row.archiveId!=='string' || !/^[a-zA-Z0-9_-]{0,160}$/.test(row.archiveId) || typeof row.revision!=='string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.revision)
        || !Number.isSafeInteger(row.updatedAt) || row.updatedAt<0)fail('角色绑定谱系内容无效');
      storyboardSubjectTargets([row]);
    }
    const sourceKey=subjectMapKey(pair.source),choice=bySource.get(sourceKey),key=characterBackupBindingKey(pair.source);
    if(!choice || bindings.has(key) || pair.target.subjectKey!==choice.targetKey || ['category','scope','chatKey','archiveId','updatedAt'].some(field=>pair.source[field]!==pair.target[field])
      || pair.target.revision!=='mapped-'+await digest({sourceDigest:value.sourceDigest,source:pair.source,targetKey:choice.targetKey}))fail('角色绑定谱系与原映射不符');
    bindings.add(key);covered.add(sourceKey);
  }
  if(covered.size!==choices.length)fail('角色映射缺少原绑定');
  const {digest:claimed,...core}=value;if(await digest(core)!==claimed)fail('角色映射凭据摘要不符');
  if(new TextEncoder().encode(JSON.stringify(value)).length>8*1048576)fail('角色映射凭据超过8MiB，未截断');
  return structuredClone(value);
}
