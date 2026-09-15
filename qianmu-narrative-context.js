// Optional provenance on existing records, not a second ledger or an authorization grant.
export const QIANMU_NARRATIVE_CONTEXT_SCHEMA = 'qianmu.narrative-context.v1';
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const identifier = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const fail = () => { throw Object.assign(new Error('叙事来源标记无效，请核对来源后再使用'), { code: 'narrative_context_invalid' }); };
function identifiers(value) {
  if (!Array.isArray(value) || value.length > 40 || value.some(item => !identifier(item, 160) || item === '*')) fail();
  return [...new Set(value)].sort();
}

export function normalizeNarrativeContext(value) {
  if (!object(value) || value.schema !== QIANMU_NARRATIVE_CONTEXT_SCHEMA || !identifier(value.chatKey, 512)
    || !['fact', 'prediction', 'unknown'].includes(value.claim) || !object(value.branch)
    || !['mainline', 'parallel'].includes(value.branch.kind) || !identifier(value.branch.id)
    || !object(value.time) || !['past', 'present', 'future', 'timeless', 'unknown'].includes(value.time.layer)
    || typeof value.time.label !== 'string' || value.time.label.length > 240 || !object(value.knowledge)) fail();
  const branch = value.branch;
  let fork = null;
  if (branch.kind === 'mainline') {
    if (branch.id !== 'mainline' || branch.fork != null) fail();
  } else {
    if (branch.id === 'mainline' || !object(branch.fork) || !identifier(branch.fork.branchId)
      || branch.fork.branchId === branch.id || !identifier(branch.fork.recordId) || !identifier(branch.fork.revisionId)) fail();
    fork = { branchId: branch.fork.branchId, recordId: branch.fork.recordId, revisionId: branch.fork.revisionId };
  }
  return {
    schema: QIANMU_NARRATIVE_CONTEXT_SCHEMA,
    chatKey: value.chatKey,
    branch: { kind: branch.kind, id: branch.id, fork },
    claim: value.claim,
    time: { layer: value.time.layer, label: value.time.label },
    knowledge: { knownBy: identifiers(value.knowledge.knownBy), hiddenFrom: identifiers(value.knowledge.hiddenFrom) },
  };
}

export function retainNarrativeContext(value) {
  try { return normalizeNarrativeContext(value); } catch (_) { return { invalid: true }; }
}

// Present-but-invalid must survive normalization; dropping it would restore legacy privileges.
export function narrativeContextField(container) {
  return own(container, 'narrativeContext') ? { narrativeContext: retainNarrativeContext(container.narrativeContext) } : {};
}

export function narrativeContextIssues(container, chatKey) {
  if (!own(container, 'narrativeContext')) return [];
  try {
    const context = normalizeNarrativeContext(container.narrativeContext);
    return chatKey === undefined || context.chatKey === chatKey ? [] : ['narrative_context_chat_mismatch'];
  } catch (_) { return ['narrative_context_invalid']; }
}

export function narrativeContextKey(container) {
  return own(container, 'narrativeContext') ? JSON.stringify(retainNarrativeContext(container.narrativeContext)) : '';
}

export function matchingNarrativeContexts(left, right) {
  if (!own(left, 'narrativeContext') && !own(right, 'narrativeContext')) return true;
  if (!own(left, 'narrativeContext') || !own(right, 'narrativeContext')) return false;
  try { return JSON.stringify(normalizeNarrativeContext(left.narrativeContext)) === JSON.stringify(normalizeNarrativeContext(right.narrativeContext)); }
  catch (_) { return false; }
}

export function isMainlineNarrativeFact(value) {
  try {
    const context = normalizeNarrativeContext(value);
    return context.branch.kind === 'mainline' && context.claim === 'fact' && ['past', 'present', 'timeless'].includes(context.time.layer);
  } catch (_) { return false; }
}

export function canRevealNarrativeContext(value, viewerId) {
  if (!isMainlineNarrativeFact(value)) return false;
  const context = normalizeNarrativeContext(value);
  return identifier(viewerId, 160) && context.knowledge.knownBy.includes(viewerId) && !context.knowledge.hiddenFrom.includes(viewerId);
}

export function narrativeContextLayer(value) {
  if (!isMainlineNarrativeFact(value)) return 'imagined';
  return normalizeNarrativeContext(value).time.layer === 'past' ? 'memory' : 'present';
}
