import { vibeDigest } from './qianmu-vibe-file.js';

export const SUBJECT_EVIDENCE_SCHEMA = 'qianmu.storyboard.subject-evidence.v1';
const fields = { char: ['name','description','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions','alternate_greetings'],
  user: ['name','description','position','depth','role','lorebook','title'] };
const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_subject_evidence', submissionState: 'not_submitted' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = row => JSON.stringify([row.category, row.subjectKey]);
const order = (a,b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name));
function subject(row) {
  if (!object(row) || !['char','user','other'].includes(row.category) || typeof row.subjectKey !== 'string' || !row.subjectKey || row.subjectKey.length > 1024 || /[\u0000-\u001f\u007f]/.test(row.subjectKey)) fail('角色来源标识无效');
  return { category: row.category, subjectKey: row.subjectKey };
}
export function storyboardSubjectTargets(bindings = []) {
  if (!Array.isArray(bindings) || bindings.length > 2080) fail('角色来源目标超过支持范围');
  const rows = new Map(); for (const row of bindings) { const target = subject(row); rows.set(key(target), target); }
  return [...rows.values()].sort(order);
}

// Project declared narrative fields only, never the entire ST card, settings or third-party extensions.
export function projectStoryboardSubjects(rows) {
  if (!Array.isArray(rows) || rows.length > 2080) fail('角色来源列表无效或过多');
  const seen = new Set();
  return rows.map(row => {
    const target = subject(row), id = key(target); if (seen.has(id)) fail('角色来源编号重复，不能猜测同名对象'); seen.add(id);
    if (!['present','missing','unavailable'].includes(row.state)) fail('角色来源状态无效');
    if (row.state !== 'present') return { ...target, state: row.state, profile: null };
    if (!fields[row.category] || !object(row.profile)) fail('角色来源正文不完整');
    const profile = {};
    for (const name of fields[row.category]) {
      const value = row.profile[name] ?? null;
      if (name === 'alternate_greetings') {
        if (value !== null && (!Array.isArray(value) || value.length > 4096 || Array.from(value).some(text => typeof text !== 'string'))) fail('角色候选开场白格式不支持');
        profile[name] = value === null ? null : [...value];
      } else {
        if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail('角色来源字段格式不支持');
        profile[name] = value;
      }
    }
    return { ...target, state: 'present', profile };
  }).sort(order);
}
export async function readStoryboardBoundSubjects(namespace) {
  const { createCharacterArchiveStore } = await import('./qianmu-character-archive-store.js');
  const store = createCharacterArchiveStore();
  try { return storyboardSubjectTargets(await store.bindings(namespace)); } finally { store.close(); }
}
export function storyboardSubjectProfilesMatch(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((row,index) => {
    const next = right[index];
    if (row.category !== next.category || row.subjectKey !== next.subjectKey || row.state !== next.state) return false;
    if (row.profile === null || next.profile === null) return row.profile === next.profile;
    return fields[row.category].every(name => {
      const a = row.profile[name], b = next.profile[name];
      return Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((text,index) => text === b[index]) : a === b;
    });
  });
}
export function readStoryboardSubjectProfiles(targets, { characters, power } = {}) {
  const requested = storyboardSubjectTargets(targets);
  const cards = new Map();
  if (Array.isArray(characters)) for (const card of characters) {
    const avatar = String(card?.avatar || card?.data?.avatar || ''), list = cards.get(avatar) || []; list.push(card); cards.set(avatar,list);
  }
  return projectStoryboardSubjects(requested.map(target => {
    const row = { ...target, state: 'unavailable', profile: null };
    if (target.category === 'char' && target.subjectKey.startsWith('char:') && Array.isArray(characters)) {
      const matches = cards.get(target.subjectKey.slice(5)) || [];
      if (!matches.length) return { ...row, state: 'missing' };
      if (matches.length > 1) fail('ST 存在重复角色文件名，请先核对');
      const card = matches[0], data = object(card.data) ? card.data : {};
      if (card._lazy || typeof (card.description ?? data.description) !== 'string') return row;
      return { ...row, state: 'present', profile: Object.fromEntries(fields.char.map(name => [name, card[name] ?? data[name] ?? null])) };
    }
    if (target.category === 'user' && object(power?.personas) && object(power?.persona_descriptions)) {
      const match = /^user:\/User(?:%20| )Avatars\/(.+)$/.exec(target.subjectKey); if (!match) return row;
      let avatar; try { avatar = decodeURIComponent(match[1]); } catch (_) { return row; }
      if (!avatar || /[\/\\]/.test(avatar)) return row;
      if (!Object.hasOwn(power.personas,avatar)) return { ...row, state: 'missing' };
      const descriptor = power.persona_descriptions[avatar]; if (!object(descriptor) || typeof descriptor.description !== 'string') return row;
      return { ...row, state: 'present', profile: { ...Object.fromEntries(fields.user.map(name => [name, descriptor[name] ?? null])), name: power.personas[avatar] } };
    }
    return row;
  }));
}
export async function captureStoryboardSubjectEvidence(input, { guard = async () => {} } = {}) {
  const projected = projectStoryboardSubjects(input), subjects = []; let bytes = 0;
  await guard();
  for (const row of projected) {
    const text = JSON.stringify(row.profile); bytes += new TextEncoder().encode(text).length;
    if (bytes > 64 * 1048576) fail('角色来源内容超过 64 MiB，未截断或生成缺失摘要');
    subjects.push({ category: row.category, subjectKey: row.subjectKey, state: row.state, sha256: row.state === 'present' ? await vibeDigest(text) : null });
  }
  const core = { schema: SUBJECT_EVIDENCE_SCHEMA, scope: 'declared-narrative-fields', subjects };
  const digest = await vibeDigest(JSON.stringify(core)); await guard(); return { ...core, digest };
}
export async function inspectStoryboardSubjectEvidence(value) {
  if (!exact(value,['schema','scope','subjects','digest']) || value.schema !== SUBJECT_EVIDENCE_SCHEMA || value.scope !== 'declared-narrative-fields' || !hash(value.digest)
    || !Array.isArray(value.subjects) || value.subjects.length > 2080) fail('角色来源摘要结构无效');
  const subjects = value.subjects.map(row => {
    const target = subject(row);
    if (!exact(row,['category','subjectKey','state','sha256']) || !['present','missing','unavailable'].includes(row.state)
      || (row.state === 'present' ? !hash(row.sha256) || !fields[row.category] : row.sha256 !== null)) fail('角色来源摘要条目无效');
    return { ...target, state: row.state, sha256: row.sha256 };
  });
  if (JSON.stringify(storyboardSubjectTargets(subjects)) !== JSON.stringify(subjects.map(subject))) fail('角色来源目录重复或未按稳定顺序排列');
  const core = { schema: SUBJECT_EVIDENCE_SCHEMA, scope: value.scope, subjects };
  if (await vibeDigest(JSON.stringify(core)) !== value.digest) fail('角色来源内容摘要不符');
  return { ...core, digest: value.digest };
}
export async function compareStoryboardSubjectEvidence(source, target, bindings = []) {
  source = await inspectStoryboardSubjectEvidence(source); target = await inspectStoryboardSubjectEvidence(target);
  const wanted = new Map(source.subjects.map(row => [key(row),row])), actual = new Map(target.subjects.map(row => [key(row),row]));
  if (JSON.stringify([...wanted.keys()]) !== JSON.stringify([...actual.keys()])) fail('角色来源核对目标不完整');
  const required = new Set(storyboardSubjectTargets(bindings.filter(row => row.archiveId)).map(key));
  if ([...required].some(id => !wanted.has(id))) fail('来源摘要缺少待恢复的角色绑定，请保留原包');
  const rows = source.subjects.map(row => {
    const id = key(row), current = actual.get(id);
    return { category: row.category, subjectKey: row.subjectKey, required: required.has(id),
      state: current.state === 'missing' ? 'missing' : row.state !== 'present' || current.state !== 'present' ? 'unverified' : row.sha256 === current.sha256 ? 'matched' : 'changed' };
  });
  return { digest: await vibeDigest(JSON.stringify({ source: source.digest, target: target.digest, required: [...required].sort() })), rows,
    ready: !rows.some(row => row.required && row.state === 'missing') };
}
