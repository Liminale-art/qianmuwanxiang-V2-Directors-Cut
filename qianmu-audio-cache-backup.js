// Existing v1 cache format, with bounded admission and commit-aware storage adapters.
// This legacy cache belongs to this browser/site, not a proven character or account archive.
import { parseBoundedJson, assertJsonInputBounds, base64DecodedLength } from './qianmu-json-input.js';
export const AUDIO_CACHE_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, entries: 2000, encodedBytes: 64 * 1024 * 1024, audioBytes: 48 * 1024 * 1024 });
const META = ['speaker','text','format','provider','folder','fileNameBase','chatKey','messageIndex','lineIndex','sourceTime','source','bookId'];
export function audioCacheMeta(value) {
  const out = {};
  for (const key of META) if (typeof value?.[key] === 'string' || typeof value?.[key] === 'boolean' || typeof value?.[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key];
  return out;
}
export function validateAudioCacheBackup(payload) {
  if (payload?.type !== 'qianmu-tts-audio-cache' || ![1,'1'].includes(payload.version) || !Array.isArray(payload.entries)) throw Error('不是受支持的千幕音频缓存备份；未写入内容。');
  if (payload.entries.length > AUDIO_CACHE_LIMITS.entries) throw Error('缓存条目超过 2000 条导入上限；请保留原文件，未写入内容。');
  if (payload.count != null && payload.count !== payload.entries.length) throw Error('备份条数与实际内容不符；未写入内容。');
  const keys = new Set();
  for (const [i, entry] of payload.entries.entries()) {
    const fail = text => { throw Error(`音频缓存第 ${i + 1} 条${text}；未开始恢复，请保留原文件。`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('格式无效');
    if (typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > 4096 || entry.key !== entry.key.trim() || keys.has(entry.key)) fail('编号无效或重复');
    keys.add(entry.key);
    if (entry.createdAt != null && (!Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0)) fail('时间无效');
    if (entry.type != null && (typeof entry.type !== 'string' || entry.type.length > 256 || !/^(?:audio\/[a-z0-9.+-]+(?:;[^\r\n]*)?|application\/octet-stream)$/i.test(entry.type))) fail('音频类型无效');
    if (entry.meta != null && (typeof entry.meta !== 'object' || Array.isArray(entry.meta))) fail('元数据无效');
    for (const key of META) if (entry.meta?.[key] != null && !['string','boolean','number'].includes(typeof entry.meta[key])) fail('文字或定位信息格式无效');
    for (const [key, value] of Object.entries(audioCacheMeta(entry.meta))) if (typeof value === 'string' && value.length > (key === 'text' ? 12000 : 4096)) fail('文字超过无损恢复上限');
    try { base64DecodedLength(entry.data, {maxEncodedBytes:AUDIO_CACHE_LIMITS.encodedBytes,maxBytes:AUDIO_CACHE_LIMITS.audioBytes}); }
    catch (error) { fail(error.message); }
  }
  return payload;
}
export async function readAudioCacheBackup(file, {check}) {
  check();
  if (!file || typeof file.text !== 'function' || file.size != null && (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > AUDIO_CACHE_LIMITS.bytes)) throw Error('缓存备份为空或超过 256 MB；未读取或写入内容。');
  const raw = await file.text(); check();
  const payload = parseBoundedJson(raw, {maxBytes:AUDIO_CACHE_LIMITS.bytes,label:'音频缓存备份'});
  validateAudioCacheBackup(payload); check(); return payload;
}
export function prepareAudioCacheBackup(payload) {
  const raw = JSON.stringify(payload), blob = new Blob([raw], {type:'application/json'});
  let preservationOnly = false;
  try { assertJsonInputBounds(raw,{maxBytes:AUDIO_CACHE_LIMITS.bytes,label:'音频缓存备份'}); validateAudioCacheBackup(payload); }
  catch { preservationOnly = true; }
  return {blob,preservationOnly};
}
export async function exportAudioCacheBackup({reader,encode,check,confirm,download,stamp,notify}) {
  check(); const records = await reader.listAudio(); check();
  if (!records.length) { notify('音频缓存为空，没有可导出的内容。','info'); return {status:'empty'}; }
  const entries = [];
  for (const record of records) {
    check();
    if (!(record.blob instanceof Blob) || !record.blob.size) throw Error('有音频原件无法读取，未导出不完整备份。');
    const data = await encode(record.blob); check();
    if (typeof data !== 'string' || base64DecodedLength(data,{maxEncodedBytes:Number.MAX_SAFE_INTEGER,maxBytes:Number.MAX_SAFE_INTEGER}) !== record.blob.size) throw Error('音频编码不完整，未下载备份。');
    entries.push({key:record.key,meta:audioCacheMeta(record.meta),createdAt:record.createdAt || 0,type:record.blob.type || 'audio/mpeg',data});
  }
  const payload = {version:1,type:'qianmu-tts-audio-cache',credentialsIncluded:false,exportedAt:new Date().toISOString(),count:entries.length,entries};
  const result = prepareAudioCacheBackup(payload);
  if (result.preservationOnly && await confirm('仅保存保全副本','缓存超过当前导入限制或含暂不能完整恢复的记录。可以保存全部音频和可迁移信息，不截断或删条，但当前不能直接完整恢复。是否下载保全副本？') !== true) return {status:'cancelled'};
  check(); download(result.blob,`qianmu-语音缓存-${result.preservationOnly?'preservation-':''}${stamp()}.json`);
  notify(result.preservationOnly ? '已导出音频缓存保全副本，当前不能直接完整恢复；请保留原文件和本机缓存。' : `已导出 ${entries.length} 条音频缓存。`, result.preservationOnly?'warning':'success');
  return {status:'exported',count:entries.length,preservationOnly:result.preservationOnly};
}
export async function importAudioCacheBackup(file, {writer,decode,check,confirm,progress}) {
  const payload = await readAudioCacheBackup(file,{check});
  if (!payload.entries.length) throw Error('缓存备份没有条目，未写入内容。');
  if (await confirm('恢复音频缓存',`将向本浏览器的当前 ST 站点导入 ${payload.entries.length} 条音频缓存，可能包含多个聊天；不是按当前角色筛选。旧缓存没有可靠账户归属，不能视为当前账户专属。同编号保留现有音频，不覆盖；不恢复语音收藏、音色或 API 设置，不自动播放或重新合成。是否继续？`) !== true) return {status:'cancelled'};
  check();
  for (const entry of payload.entries) {
    check(); const blob = await decode(entry.data,entry.type || 'audio/mpeg'); check();
    if (!(blob instanceof Blob) || blob.size !== base64DecodedLength(entry.data,{maxEncodedBytes:AUDIO_CACHE_LIMITS.encodedBytes,maxBytes:AUDIO_CACHE_LIMITS.audioBytes})) throw Error('音频还原不完整，后续恢复已停止。');
    const before = {...progress};
    await writer.bulkPutAudio([{key:entry.key,blob,meta:audioCacheMeta(entry.meta),createdAt:entry.createdAt || 0}],{
      onProgress: current => { for (const key of ['added','skipped','failed']) progress[key] = (before[key] || 0) + (current[key] || 0); },
    });
    check();
  }
  return {status:progress.failed?'partial':'imported',...progress};
}
