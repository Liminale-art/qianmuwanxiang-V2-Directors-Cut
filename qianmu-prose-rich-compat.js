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

function isRichBoundary(node) {
  if (node?.nodeType !== 1 || isProseRun(node)) return false;
  const tag = tagName(node);
  return tag === 'style' || isStyledBlock(node) || RICH_ELEMENTS.has(tag)
    || !!node.querySelector?.('style, .np-min-card, [data-sd-prose-exempt]');
}

export function isRichProse(message) {
  if (!message) return false;
  if (message.querySelector?.('style, .np-min-card, [data-sd-prose-exempt]')) return true;
  return Array.from(message.children || []).some(isStyledBlock);
}

function hasProseContent(nodes) {
  return nodes.some((node) => isProseRun(node)
    || node.nodeType === 1
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
      if (mutation.target === owner || layout.splitBreaks || layout.contentWidth > 80
        || added.some(isRichBoundary) || removed.some(isRichBoundary)) roots.add(owner);
      continue;
    }
    for (const node of added) {
      if (node.nodeType === 1 && (node.matches?.('.mes_text') || node.querySelector?.('.mes_text'))) roots.add(node);
    }
  }
  return roots;
}
