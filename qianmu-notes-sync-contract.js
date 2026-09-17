// Account-wide plain-text originals. Geometry and device presentation never enter this contract.
export const NOTES_SYNC_VERSION = 1;
export const NOTES_SYNC_SCHEMA = 'qianmu.notes-sync.v1';
export const NOTES_SYNC_LIMITS = Object.freeze({id:120,title:120,body:20000,notes:10000,mutations:100000,bytes:64*1024*1024});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, fields) => object(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const account = value => typeof value === 'string' && /^st-user:[a-f0-9]{64}$/.test(value);
const text = (value, limit) => typeof value === 'string' && Array.from(value).length <= limit && !value.includes('\0') && new TextDecoder().decode(new TextEncoder().encode(value)) === value;
const identifier = value => text(value, NOTES_SYNC_LIMITS.id) && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
export const notesSyncError = (code, message, status = 409) => Object.assign(new Error(message), {code:`notes_sync_${code}`,status,writeState:'not_started'});
const fail = message => {throw notesSyncError('contract', message, 400);};
export function notesSyncMutationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(value)) fail('便笺同步操作编号无效');
  return value;
}
// getRandomValues remains available on HTTP LAN pages where randomUUID is absent.
export function notesSyncOperationId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return notesSyncMutationId(cryptoImpl.randomUUID());
  if (typeof cryptoImpl?.getRandomValues !== 'function') throw notesSyncError('unavailable', '浏览器无法创建安全便笺编号，请保留草稿并换用支持的浏览器', 503);
  return Array.from(cryptoImpl.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function notesSyncNoteInput(value) {
  if (!keys(value,['title','body','pinned','createdAt']) || !text(value.title,NOTES_SYNC_LIMITS.title) || !text(value.body,NOTES_SYNC_LIMITS.body)
    || typeof value.pinned !== 'boolean' || !integer(value.createdAt)) fail('便笺内容不完整、过大或包含不支持的字段；未截断原文');
  return {title:value.title,body:value.body,pinned:value.pinned,createdAt:value.createdAt};
}
export function notesSyncRecord(value) {
  if (!keys(value,['id','title','body','pinned','createdAt','updatedAt','revision','deleted']) || !identifier(value.id) || !integer(value.updatedAt)
    || !integer(value.revision) || value.revision < 1 || typeof value.deleted !== 'boolean') fail('便笺同步记录无效');
  const note = notesSyncNoteInput({title:value.title,body:value.body,pinned:value.pinned,createdAt:value.createdAt});
  if (value.deleted && (value.title !== '' || value.body !== '' || value.pinned)) fail('便笺删除标记不得包含正文或常驻状态');
  return {id:value.id,...note,updatedAt:value.updatedAt,revision:value.revision,deleted:value.deleted};
}
export function notesSyncWriteRequest(value) {
  if (!keys(value,['version','expectedAccount','id','baseRevision','note','deleted','mutationId']) || value.version !== NOTES_SYNC_VERSION || !account(value.expectedAccount)
    || !identifier(value.id) || !integer(value.baseRevision) || typeof value.deleted !== 'boolean') fail('便笺同步请求无效；不能包含设备位置、尺寸或账户路径');
  const note = notesSyncNoteInput(value.note), mutationId = notesSyncMutationId(value.mutationId);
  if (value.deleted && value.baseRevision === 0) fail('不能删除尚未确认保存的便笺');
  return {version:NOTES_SYNC_VERSION,expectedAccount:value.expectedAccount,id:value.id,baseRevision:value.baseRevision,note,deleted:value.deleted,mutationId};
}
export function notesSyncListResponse(value) {
  if (!keys(value,['ok','version','expectedAccount','revision','notes']) || value.ok !== true || value.version !== NOTES_SYNC_VERSION || !account(value.expectedAccount)
    || !integer(value.revision) || !Array.isArray(value.notes) || value.notes.length > NOTES_SYNC_LIMITS.notes) fail('便笺目录返回格式无效或超过支持总量；未截断目录');
  const notes = value.notes.map(notesSyncRecord), ids = new Set();
  for (const note of notes) {if (ids.has(note.id) || note.revision > value.revision) fail('便笺目录存在重复标识或不一致版本'); ids.add(note.id);}
  return {ok:true,version:NOTES_SYNC_VERSION,expectedAccount:value.expectedAccount,revision:value.revision,notes};
}
export function notesSyncWriteResponse(value) {
  if (!keys(value,['ok','version','expectedAccount','revision','note']) || value.ok !== true || value.version !== NOTES_SYNC_VERSION || !account(value.expectedAccount)
    || !integer(value.revision) || value.revision < 1) fail('便笺保存确认格式无效');
  const note = notesSyncRecord(value.note);
  if (note.revision !== value.revision) fail('便笺保存确认版本不一致');
  return {ok:true,version:NOTES_SYNC_VERSION,expectedAccount:value.expectedAccount,revision:value.revision,note};
}
export function notesSyncConflictResponse(value) {
  if (!keys(value,['ok','version','code','message','writeState','expectedAccount','revision','note']) || value.ok !== false || value.version !== NOTES_SYNC_VERSION
    || value.code !== 'notes_sync_conflict' || typeof value.message !== 'string' || value.writeState !== 'not_started' || !account(value.expectedAccount) || !integer(value.revision)) fail('便笺冲突返回格式无效');
  const note = value.note === null ? null : notesSyncRecord(value.note);
  if (note && note.revision > value.revision) fail('便笺冲突返回版本无效');
  return {...value,note};
}
export function notesSyncErrorPayload(error) {
  if (error?.code === 'notes_sync_conflict' && error?.conflict) return {status:409,body:notesSyncConflictResponse(error.conflict)};
  const known = typeof error?.code === 'string' && /^notes_sync_[a-z_]+$/.test(error.code);
  return {status:known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503,
    body:{ok:false,version:NOTES_SYNC_VERSION,code:known?error.code:'notes_sync_storage',message:known?error.message:'便笺储存暂不可用，原有内容已保留，请稍后核对',
      writeState:error?.writeState === 'unconfirmed' ? 'unconfirmed' : 'not_started'}};
}
