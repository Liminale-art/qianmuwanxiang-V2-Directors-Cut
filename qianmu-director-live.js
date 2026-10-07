const FIELDS = {
  quests: ['际遇', ['title', 'content', 'description', 'trigger']],
  character_dynamics: ['此间一人', ['title', 'name', 'content', 'description', 'current_goal', 'next_action']],
  npc_updates: ['其他人物动向', ['title', 'name', 'content', 'description', 'current_goal', 'next_action']],
  world_updates: ['世界回声', ['title', 'type', 'content', 'scope', 'timing']],
  chain_reactions: ['涟漪', ['spark', 'chain', 'impact']],
  relation_undercurrents: ['关系暗涌', ['title', 'parties', 'surface', 'undercurrent', 'tension', 'content']],
  parallel_scene: ['未映之幕', ['title', 'content']],
  interlude: ['幕间拾趣', ['title', 'owner', 'content']],
};
const OBJECT_FIELDS = new Set(['parallel_scene', 'interlude']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// Consume only closed known cards. Top-level extras stay read-only, just like array previews.
export function completeDirectorCards(source) {
  const text = String(source || ''), cards = [], stack = [];
  let string = false, escaped = false, tokenStart = -1, key = '', itemStart = -1, expectKey = false;
  const keys = new Set();
  for (let i = text.indexOf('{'); i >= 0 && i < text.length; i++) {
    const ch = text[i];
    if (string) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch !== '"') continue;
      string = false;
      if (stack.length === 1 && expectKey) {
        try { key = JSON.parse(text.slice(tokenStart, i + 1)); } catch (_) { return cards; }
        if (keys.has(key)) return []; // Duplicate top-level fields are ambiguous, not a second revision.
        keys.add(key); expectKey = false;
      }
    } else if (ch === '"') {
      string = true; tokenStart = i;
      if (stack.length === 2 && stack[1] === '[' && itemStart < 0) itemStart = i;
      continue;
    } else if (ch === '{' || ch === '[') {
      if (stack.length === 1 && ch === '{' && OBJECT_FIELDS.has(key)) itemStart = i;
      if (stack.length === 2 && stack[1] === '[' && itemStart < 0) itemStart = i;
      stack.push(ch);
      if (stack.length === 1) expectKey = true;
      continue;
    } else if (ch === '}' || ch === ']') {
      if (!stack.length || (ch === '}' ? '{' : '[') !== stack.at(-1)) return cards;
      // Only closing the outer item completes it; nested arrays/objects leave its start intact.
      if (stack.length === 2 && stack[1] === '[') { stack.pop(); itemStart = -1; continue; }
      stack.pop(); if (!stack.length) break;
      if (stack.length === 1 && ch === '}' && OBJECT_FIELDS.has(key) && itemStart >= 0) {
        add(text.slice(itemStart, i + 1), true); itemStart = -1;
      }
    } else if (stack.length === 1 && ch === ',') { key = ''; expectKey = true; continue; }
    else if (stack.length === 2 && stack[1] === '[' && ch === ',') { itemStart = -1; continue; }
    else continue;
    if (stack.length === 2 && stack[1] === '[' && itemStart >= 0) { add(text.slice(itemStart, i + 1)); itemStart = -1; }
  }
  function add(raw, objectField = false) {
    if (!Object.hasOwn(FIELDS, key)) return;
    if (OBJECT_FIELDS.has(key) !== objectField) return;
    let value; try { value = JSON.parse(raw); } catch (_) { return; }
    if (OBJECT_FIELDS.has(key) && (!value || typeof value.content !== 'string' || !value.content.trim())) return;
    if (key === 'interlude' && !['theater', 'phone'].includes(value.type)) return;
    const [label, fields] = FIELDS[key];
    const lines = value && !Array.isArray(value) && typeof value === 'object' ? fields.map(field => Array.isArray(value[field]) ? value[field].filter(x => typeof x === 'string').join(' · ') : typeof value[field] === 'string' ? value[field] : '').filter(Boolean) : [];
    if (!lines.some(line => line.trim())) return;
    cards.push({ field: key, label, value, lines });
  }
  return cards;
}

export function renderDirectorLive(log, { tasksOnly = false } = {}) {
  if (!log || log.status === 'success') return '';
  const cards = completeDirectorCards(log.response).filter(card => !tasksOnly || ['quests','chain_reactions'].includes(card.field));
  return `<section class="sd-card sd-director-live" data-live-log="${escape(log.id)}">
    <div class="sd-field-head"><h3>${log.status === 'loading' ? '正在推演' : '本次未完整完成'}</h3><button type="button" class="sd-btn sd-director-log" data-log-id="${escape(log.id)}">查看本次原文</button></div>
    <p class="sd-muted">${escape(log.error || (cards.length ? '已收到的完整条目如下；尚未写入当前结果或暗线。' : '正在接收回复；完整条目到达后逐卡显示。'))}</p>
    <div class="sd-live-cards">${cards.map(card => `<article class="sd-lib-row"><div class="sd-lib-main"><small class="sd-muted">${escape(card.label)}</small>${card.lines.map((line, i) => i === 0 ? `<h4>${escape(line)}</h4>` : `<p>${escape(line)}</p>`).join('')}</div></article>`).join('')}</div>
  </section>`;
}

export function parseDirectorFinal(raw) {
  const text = String(raw || ''), start = text.indexOf('{'), end = text.lastIndexOf('}');
  try {
    if (start < 0 || end < start) throw new Error('没有完整对象');
    const value = JSON.parse(text.slice(start, end + 1));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('不是对象');
    return value;
  } catch (error) { throw new Error(`JSON_PARSE_FAILED::${error.message}`); }
}

export function renderModelDiagnostics(log) {
  const info = log.completion;
  const memoryLabel = { partial: '部分记忆可用，本次仅采用已核对内容。', unverified: '记忆暂无法核对，本次未采用。', unsupported: '当前记忆版本尚未适配，本次未采用。' }[log.memory?.status];
  const memoryCodes = memoryLabel && Array.isArray(log.memory?.diagnostics)
    ? log.memory.diagnostics.filter(item => typeof item?.code === 'string').map(item => `${item.code}${typeof item.scope === 'string' && item.scope ? ` · ${item.scope}` : ''}`) : [];
  const issues = Array.isArray(log.quality) ? log.quality : Array.isArray(log.quality?.issues) ? log.quality.issues : [];
  const qualityFields = new Map();
  for (const issue of issues) {
    if (!issue || typeof issue.field !== 'string') continue;
    const previous = qualityFields.get(issue.field) || { missing: 0, reason: '' };
    const missing = Number.isInteger(issue.missing) && issue.missing > 0 ? issue.missing : 0;
    qualityFields.set(issue.field, { missing: Math.max(previous.missing, missing), reason: previous.reason || (typeof issue.reason === 'string' ? issue.reason : '') });
  }
  const qualityText = [...qualityFields].map(([field, issue]) => {
    const label = FIELDS[field]?.[0] || ({ world_chatter: '尘寰群生', factions: '世界格局·组织', faction_relations: '世界格局·关系', world_events: '世界格局·局势', limitations: '受限说明' })[field] || '其他栏目';
    return `${label}${issue.missing ? `缺 ${issue.missing} ${OBJECT_FIELDS.has(field) ? '张' : '条'}` : `：${issue.reason || '内容尚未符合要求'}`}`;
  }).join('；');
  return `${memoryLabel ? `<p class="sd-muted sd-memory-notice">${escape(memoryLabel)}</p>` : ''}
    ${memoryCodes.length ? `<details><summary>记忆核对详情</summary><pre class="sd-term">${escape(memoryCodes.join('\n'))}</pre></details>` : ''}
    ${qualityText ? `<p class="sd-muted sd-creative-quality">本次内容未完整：${escape(qualityText)}</p>` : ''}
    ${info ? `<p class="sd-muted">结束原因：${escape(info.finishReason || '渠道未提供')}${info.interrupted ? ' · 未完整完成' : ''}${info.compatibility ? ` · ${escape(info.compatibility)}` : ''}</p>` : ''}
    ${info?.rawTransport ? `<details><summary>未解析的原始响应片段</summary><pre class="sd-term">${escape(info.rawTransport)}</pre></details>` : ''}
    <details class="sd-log-reasoning" ${log.reasoning ? '' : 'hidden'}><summary>渠道返回的推理内容</summary><pre class="sd-term sd-term-reasoning">${escape(log.reasoning || '')}</pre></details>
    ${log.repairResponse || log.repairError ? `<div class="sd-log-cap">定向补写（独立回复，不拼入首轮原文）</div><pre class="sd-term">${escape(log.repairResponse || log.repairError)}</pre>` : ''}`;
}

export function paintModelLog(root, log, renderEntry) {
  if (!root) return;
  const entry = [...root.querySelectorAll('.sd-log-entry')].find(node => node.dataset.acc === `log-${log.id}`);
  const request = entry?.querySelector('.sd-term-request');
  if (request && log.request && request.textContent !== log.request) request.textContent = log.request;
  const pre = entry?.querySelector('.sd-term-response');
  if (pre) {
    const follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24, top = pre.scrollTop;
    pre.textContent = log.response || '';
    pre.scrollTop = follow ? pre.scrollHeight : top;
  }
  const thoughts = entry?.querySelector('.sd-term-reasoning');
  if (thoughts && log.reasoning) { thoughts.textContent = log.reasoning; thoughts.closest('details').hidden = false; }
  // Background completion updates only this log's status/diagnostics, preserving its raw-text node and scroll.
  if (entry && renderEntry && log.status !== 'loading') {
    const stamp = JSON.stringify([log.status, log.error, log.duration]);
    if (entry._modelFinal === stamp) return;
    const template = entry.ownerDocument.createElement('template'); template.innerHTML = renderEntry(log, 0);
    const fresh = template.content.firstElementChild;
    for (const selector of ['summary', '.sd-log-failure', '.sd-log-diagnostics']) {
      const target = entry.querySelector(selector), source = fresh?.querySelector(selector);
      if (!target || !source) continue;
      const open = [...target.querySelectorAll('details')].map(node => node.open);
      const positions = [...target.querySelectorAll('pre')].map(node => node.scrollTop);
      target.innerHTML = source.innerHTML;
      [...target.querySelectorAll('details')].forEach((node, i) => { node.open = open[i] || false; });
      [...target.querySelectorAll('pre')].forEach((node, i) => { node.scrollTop = positions[i] || 0; });
    }
    entry._modelFinal = stamp;
  }
}
