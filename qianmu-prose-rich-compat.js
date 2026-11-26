// A decorated message may contain ordinary prose before and after a rich card.
// Move only its ordinary top-level nodes into narrow prose runs; never rebuild HTML.
const RICH_ELEMENTS = new Set([
  'pre', 'code', 'table', 'figure', 'picture',
  'img', 'video', 'audio', 'canvas', 'svg', 'iframe', 'details', 'hr', 'form',
  'fieldset', 'button', 'input', 'select', 'textarea', 'script', 'template', 'noscript',
]);

function tagName(node) {
  return String(node?.localName || node?.tagName || '').toLowerCase();
}

function isProseRun(node) {
  return node?.nodeType === 1 && node.dataset?.sdProseRun === '1'
    && node.classList?.contains('sd-prose-run');
}

function isStyledBlock(node) {
  if (node?.nodeType !== 1 || isProseRun(node)) return false;
  const tag = tagName(node);
  if (node.classList?.contains('np-min-card') || node.hasAttribute?.('data-sd-prose-exempt')) return true;
  // Top-level author HTML is intentionally left to its own CSS. Markdown's plain
  // paragraphs and bare divs continue through the ordinary prose path.
  return (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'p')
    && (node.hasAttribute?.('class') || node.hasAttribute?.('style'));
}

// A paragraph can only hold inline content, so a <style> inside one comes from
// an inline decoration (e.g. a regex that renders annotations) and styles just
// those spans; the paragraph itself is still prose. A <style> inside a bare
// block container still marks that container as an authored card.
function hasNestedRich(node) {
  if (node.querySelector?.('.np-min-card, [data-sd-prose-exempt]')) return true;
  return tagName(node) !== 'p' && !!node.querySelector?.('style');
}

// A top-level <style> renders nothing, so it never splits prose: markdown lifts
// one out of its paragraph when an inline annotation opens a line, and a split
// there would drop the paragraph gap. A run holding only styles is not created.
function isRichBoundary(node) {
  if (node?.nodeType !== 1 || isProseRun(node)) return false;
  const tag = tagName(node);
  if (tag === 'style') return false;
  return isStyledBlock(node) || RICH_ELEMENTS.has(tag) || hasNestedRich(node);
}

export function isRichProse(message) {
  if (!message) return false;
  if (message.querySelector?.('style, .np-min-card, [data-sd-prose-exempt]')) return true;
  return Array.from(message.children || []).some(isStyledBlock);
}

function hasProseContent(nodes) {
  return nodes.some((node) => isProseRun(node)
    || (node.nodeType === 1 && tagName(node) !== 'style')
    || (node.nodeType === 3 && !!node.textContent?.trim()));
}

function wrapProseGroup(message, nodes) {
  if (!nodes.length || !hasProseContent(nodes)) return;
  // Reuse an existing first run without moving it. A new node added before an
  // existing run requires a fresh first-position run to retain exact node order.
  let run = isProseRun(nodes[0]) ? nodes[0] : null;
  if (!run) {
    run = message.ownerDocument.createElement('div');
    run.classList.add('sd-prose-run');
    run.dataset.sdProseRun = '1';
    message.insertBefore(run, nodes[0]);
  }
  for (const node of nodes) {
    if (node === run) continue;
    if (isProseRun(node)) {
      while (node.firstChild) run.appendChild(node.firstChild);
      node.remove();
    } else {
      run.appendChild(node);
    }
  }
}

export function syncRichProseRuns(message) {
  if (!message) return [];
  if (!isRichProse(message)) {
    clearRichProseRuns(message);
    return [message];
  }
  // Set the marker before moving nodes so the old whole-message prose rule
  // cannot briefly style a newly mixed message during a DOM update.
  message.dataset.sdProseMixed = '1';
  // A streaming update may append a new card inside an earlier prose run.
  // Restore that run's original direct children before drawing new boundaries.
  for (const run of Array.from(message.children || []).filter(isProseRun)) {
    if (!Array.from(run.childNodes).some(isRichBoundary)) continue;
    while (run.firstChild) message.insertBefore(run.firstChild, run);
    run.remove();
  }
  let group = [];
  for (const node of Array.from(message.childNodes)) {
    if (isRichBoundary(node)) {
      wrapProseGroup(message, group);
      group = [];
    } else {
      group.push(node);
    }
  }
  wrapProseGroup(message, group);
  return proseLayoutTargets(message);
}

export function clearRichProseRuns(message) {
  if (!message) return;
  for (const run of Array.from(message.children || []).filter(isProseRun)) {
    while (run.firstChild) message.insertBefore(run.firstChild, run);
    run.remove();
  }
  if (message.dataset) delete message.dataset.sdProseMixed;
}

export function proseLayoutTargets(message) {
  if (!message) return [];
  if (message.dataset?.sdProseMixed !== '1') return [message];
  return Array.from(message.children || []).filter(isProseRun);
}

export function prepareRichProseRuns(messages, clearExpanded) {
  for (const message of messages) {
    if (isRichProse(message)) {
      if (message.dataset.sdProseMixed !== '1') clearExpanded(message);
      syncRichProseRuns(message);
    } else if (message.dataset.sdProseMixed === '1') {
      clearExpanded(message);
      clearRichProseRuns(message);
    }
  }
}

// Drop cap: CSS ::first-letter only looks at a paragraph's first line, so it
// silently misses when that line is empty (a wrapper tag such as <content>
// followed by line breaks) or when the first <p> holds no text at all. Pick
// the first paragraph that really has text, and mark the breaks (plus the
// split-break spacers after them) that precede its first character so CSS
// can fold them away. Nothing is moved or rewritten.
const DROP_IGNORE = new Set(['style', 'script', 'template', 'noscript', 'br']);
// Not body paragraphs: headings, quotes, lists and the like are passed over.
const DROP_PASS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'ul', 'ol', 'table', 'pre', 'details', 'figure', 'img', 'svg', 'iframe']);

function isProseSpacer(node) {
  return node.dataset?.sdProseGap === '1' || node.dataset?.sdProseIndent === '1';
}

function leadingBreaks(paragraph) {
  const lead = [];
  const visit = (node) => {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === 3) { if (child.textContent?.trim()) return true; continue; }
      if (child.nodeType !== 1) continue;
      const tag = tagName(child);
      if (tag === 'br' || isProseSpacer(child)) { lead.push(child); continue; }
      if (DROP_IGNORE.has(tag)) continue;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(paragraph) ? lead : null;
}

// Returns {p, lead}, 'stop' when visible text comes before any paragraph, or null.
function findDropCap(node) {
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === 3) { if (child.textContent?.trim()) return 'stop'; continue; }
    if (child.nodeType !== 1) continue;
    const tag = tagName(child);
    if (DROP_IGNORE.has(tag) || DROP_PASS.has(tag) || isProseSpacer(child)) continue;
    if (tag === 'p') {
      const lead = leadingBreaks(child);
      if (lead) return { p: child, lead };
      continue;
    }
    const hit = findDropCap(child);
    if (hit) return hit;
  }
  return null;
}

// targets: the message's prose roots/runs in order, or null to clear.
export function syncDropCap(message, targets) {
  let hit = null;
  for (const target of targets || []) {
    const found = findDropCap(target);
    if (found === 'stop') break;
    if (found) { hit = found; break; }
  }
  const keep = new Set(hit ? [hit.p, ...hit.lead] : []);
  message.querySelectorAll?.('[data-sd-prose-drop="1"], [data-sd-prose-lead="1"]').forEach((element) => {
    if (keep.has(element)) return;
    delete element.dataset.sdProseDrop;
    delete element.dataset.sdProseDropLine;
    delete element.dataset.sdProseLead;
  });
  if (!hit) clearDropCapRaise(message);
  if (!hit) return null;
  if (hit.p.dataset.sdProseDrop !== '1') hit.p.dataset.sdProseDrop = '1';
  for (const node of hit.lead) if (node.dataset.sdProseLead !== '1') node.dataset.sdProseLead = '1';
  return hit.p;
}

// The single-line raise lives on the message element and is inherited: an
// inline style on the paragraph itself would make it look like an authored
// card (see isStyledBlock) and push it out of the prose run.
export function setDropCapRaise(message, value) {
  if (message.style?.getPropertyValue?.('--sd-prose-drop-raise') !== value) message.style?.setProperty?.('--sd-prose-drop-raise', value);
}

export function clearDropCapRaise(message) {
  if (!message.style?.getPropertyValue?.('--sd-prose-drop-raise')) return;
  message.style.removeProperty('--sd-prose-drop-raise');
  if (!message.getAttribute?.('style')?.trim()) message.removeAttribute?.('style');
}

// First visible character of the drop paragraph and the first ordinary line
// break after it (the end of the first visual paragraph under split breaks).
export function dropCapStart(paragraph) {
  let start = null, stop = null;
  const visit = (node) => {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === 3) {
        if (!start) { const at = child.textContent.search(/\S/); if (at >= 0) start = { node: child, offset: at }; }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = tagName(child);
      if (tag === 'br') { if (start) { stop = child; return true; } continue; }
      if (DROP_IGNORE.has(tag) || isProseSpacer(child)) continue;
      if (visit(child)) return true;
    }
    return false;
  };
  visit(paragraph);
  if (!start) return null;
  const text = start.node.textContent.slice(start.offset);
  // The glyph whose ink decides bottom alignment: skip leading quotes.
  const letter = (text.match(/[\p{L}\p{N}]/u) || [text[0]])[0];
  return { ...start, stop, letter };
}

// Lines of the first visual paragraph in the current layout. The cap's own
// large box is ignored; small boxes are grouped by line.
export function dropCapLines(paragraph, start, fontSize) {
  const range = paragraph.ownerDocument.createRange();
  range.selectNodeContents(paragraph);
  range.setStart(start.node, start.offset);
  if (start.stop) range.setEndBefore(start.stop);
  const tops = [];
  for (const rect of range.getClientRects()) {
    if (!rect.width || !rect.height || rect.height > fontSize * 2) continue;
    if (!tops.some((top) => Math.abs(top - rect.top) < fontSize * 0.6)) tops.push(rect.top);
  }
  return tops.length;
}

export function clearProseBreakMarks(root) {
  root.querySelectorAll?.('[data-sd-prose-gap="1"]').forEach((element) => element.remove());
  root.querySelectorAll?.('[data-sd-prose-indent="1"]').forEach((element) => element.remove());
  root.querySelectorAll?.('br[data-sd-prose-break="1"]').forEach((element) => element.removeAttribute('data-sd-prose-break'));
}

export function changedProseRoots(mutations, layout) {
  const roots = new Set();
  for (const mutation of mutations) {
    const added = Array.from(mutation.addedNodes), removed = Array.from(mutation.removedNodes);
    if (!removed.length && added.length && added.every((node) => node.nodeType === 1
      && (node.dataset?.sdProseGap === '1' || node.dataset?.sdProseIndent === '1'))) continue;
    const owner = mutation.target?.closest?.('.mes_text');
    if (owner) {
      if (mutation.target === owner || layout.splitBreaks || layout.dropCap || layout.contentWidth > 80
        || added.some(isRichBoundary) || removed.some(isRichBoundary)) roots.add(owner);
      continue;
    }
    for (const node of added) {
      if (node.nodeType === 1 && (node.matches?.('.mes_text') || node.querySelector?.('.mes_text'))) roots.add(node);
    }
  }
  return roots;
}
