// The reading surface has one vertical slot per narrative shot. Only versions
// of that same shot share arrows; this projection never changes saved records.
export function storyboardInlineShotKey(record, chatKey = '') {
  return JSON.stringify([String(record.chatKey || chatKey), record.floor, Number(record.swipeId || 0),
    record.messageRef?.messageKey || record.messageHash || '',
    record.variantRootId || record.planShotId || record.groupId || record.id]);
}

export function buildStoryboardReadingShots(records, { chatKey = '', choices = {}, requestTimes = new Map() } = {}) {
  const groups = new Map();
  for (const record of records || []) {
    if (!record?.id || !record.inline || record.chatKey && record.chatKey !== chatKey) continue;
    const key = storyboardInlineShotKey(record, chatKey);
    if (!groups.has(key)) groups.set(key, { key, records: [] });
    groups.get(key).records.push(record);
  }
  return [...groups.values()].map(group => {
    const requests = new Map();
    for (const record of group.records) {
      const id = String(record.taskId || record.groupId || record.id);
      if (!requests.has(id)) requests.set(id, { id, time: 0, order: requests.size, records: [] });
      const request = requests.get(id);
      request.time = Math.max(request.time, Number(record.requestQueuedAt || requestTimes.get(record.id) || record.createdAt) || 0);
      request.records.push(record);
    }
    const ordered = [...requests.values()].sort((a, b) => a.time - b.time || a.order - b.order);
    const candidates = ordered.flatMap(request => request.records.sort((a, b) =>
      (Number(a.imageIndex) || 0) - (Number(b.imageIndex) || 0) || String(a.id).localeCompare(String(b.id))));
    const latest = ordered.at(-1);
    const saved = Object.hasOwn(choices, group.key) ? choices[group.key] : null;
    const selected = saved?.latestRequestId === latest.id && candidates.find(record => record.id === saved.recordId);
    return { ...group, records: candidates, latestRequestId: latest.id, record: selected || latest.records[0] };
  });
}

const blocks = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const excluded = 'script,style,iframe,img,video,audio,svg,button,think,thinking,[hidden],[aria-hidden="true"],details:not([open]),[data-qianmu-transient],.sd-storyboard-inline,.sd-tts-inline,.mes_reasoning';

// Read visible prose as paragraphs, descending through layout wrappers instead
// of treating an entire outer DIV as one paragraph. Keep exact DOM endpoints for
// BR/newline prose; no text extraction or replacement touches chat[].mes.
export function storyboardProseParagraphs(root, clean = value => String(value || '').trim()) {
  if (!root) return [];
  const result = [], view = root.ownerDocument?.defaultView;
  let text = '', endpoint = null;
  const flush = boundary => {
    const value = clean(text);
    if (value && (boundary || endpoint)) result.push({ text: value, ...(boundary || endpoint) });
    text = ''; endpoint = null;
  };
  const visit = node => {
    if (node.nodeType === 3) {
      const value = String(node.nodeValue || '');
      let start = 0;
      for (const match of value.matchAll(/\r?\n/g)) {
        text += value.slice(start, match.index); endpoint = { node, offset: match.index + match[0].length };
        flush(); start = match.index + match[0].length;
      }
      text += value.slice(start); endpoint = { node, offset: value.length };
      return;
    }
    if (node.nodeType !== 1 || node.matches?.(excluded)) return;
    const style = view?.getComputedStyle?.(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.contentVisibility === 'hidden') return;
    if (node.tagName === 'BR') { flush({ node, after: true }); return; }
    const block = blocks.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes || []) visit(child);
    if (block) flush({ node, after: true });
  };
  for (const node of root.childNodes || []) visit(node);
  flush();
  return result;
}

export function resolveStoryboardProseAnchor(root, records, { clean, score } = {}) {
  const anchor = records.find(record => record.paragraphAnchor)?.paragraphAnchor;
  if (!anchor) return { node: null, fallback: true, score: 0 };
  const paragraphs = storyboardProseParagraphs(root, clean);
  const ranked = paragraphs.map((entry, index) => ({ ...entry, score: score(anchor, entry.text, index,
    paragraphs[index - 1]?.text || '', paragraphs[index + 1]?.text || '') })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  // Position alone is not evidence. Ambiguous or weak matches stay in the
  // gallery, rather than silently attaching an image to the final paragraph.
  return best && best.score >= 55 && best.score > (ranked[1]?.score ?? -1)
    ? { ...best, fallback: false } : { node: null, fallback: true, score: best?.score || 0 };
}

export function insertStoryboardProseImage(root, anchor, wrapper, tails = new Map()) {
  if (!anchor?.node || anchor.fallback || !root.contains(anchor.node)) return false;
  const target = anchor.node;
  const key = target;
  const prior = tails.get(key);
  if (prior && prior.isConnected) {
    if (prior.nextSibling !== wrapper) prior.after(wrapper);
  } else if (anchor.after) {
    if (target.nextSibling !== wrapper) target.after(wrapper);
  } else {
    const offset = Math.min(anchor.offset || 0, target.nodeValue?.length || 0);
    if (offset === target.nodeValue?.length && target.nextSibling === wrapper) return true;
    const range = root.ownerDocument.createRange();
    range.setStart(target, offset); range.collapse(true); range.insertNode(wrapper); range.detach?.();
  }
  tails.set(key, wrapper);
  return true;
}
