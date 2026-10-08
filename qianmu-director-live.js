const FIELDS = {
  story_status: ['命运之脉', ['title', 'summary', 'current_arc']],
  quests: ['预演', ['title', 'content', 'description', 'trigger']],
  character_dynamics: ['此间一人', ['title', 'name', 'content', 'description', 'current_goal', 'next_action']],
  npc_updates: ['其他人物动向', ['title', 'name', 'content', 'description', 'current_goal', 'next_action']],
  world_updates: ['世界回声', ['title', 'type', 'content', 'scope', 'timing']],
  chain_reactions: ['涟漪', ['spark', 'chain', 'impact']],
  relation_undercurrents: ['关系暗涌', ['title', 'parties', 'surface', 'undercurrent', 'tension', 'content']],
  parallel_scene: ['未映之幕', ['title', 'content']],
  interlude: ['幕间拾趣', ['title', 'owner', 'content']],
  world_chatter: ['尘寰群生', ['who', 'where', 'text']],
  factions: ['世界格局', ['name', 'standing', 'agenda']],
  faction_relations: ['势力关系', ['a', 'b', 'kind', 'note']],
  world_events: ['世界事件', ['title', 'essence', 'content']],
};
const OBJECT_FIELDS = new Set(['story_status', 'parallel_scene', 'interlude']);
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
    if (key === 'parallel_scene' && (!value || typeof value.content !== 'string' || !value.content.trim())) return;
    if (key === 'interlude') {
      if (!value || !['forum', 'theater', 'phone'].includes(value.type)) return;
      const entries = value.type === 'forum' ? value.posts : value.type === 'phone' ? value.messages : null;
      if (!(typeof value.content === 'string' && value.content.trim()) &&
        !(Array.isArray(entries) && entries.some(item => typeof item?.content === 'string' && item.content.trim()))) return;
    }
    const [label, fields] = FIELDS[key];
    const lines = value && !Array.isArray(value) && typeof value === 'object' ? fields.map(field => Array.isArray(value[field]) ? value[field].filter(x => typeof x === 'string').join(' · ') : typeof value[field] === 'string' ? value[field] : '').filter(Boolean) : [];
    if (key === 'story_status' && Array.isArray(value?.directions)) {
      for (const direction of value.directions) {
        if (typeof direction?.content === 'string' && direction.content.trim()) {
          lines.push([typeof direction.title === 'string' ? direction.title : '', direction.content].filter(Boolean).join('：'));
        }
      }
    }
    if (key === 'interlude') {
      const entries = value.type === 'forum' ? value.posts : value.messages;
      if (Array.isArray(entries)) for (const entry of entries) {
        if (typeof entry?.content === 'string' && entry.content.trim()) lines.push(entry.content);
      }
    }
    if (!lines.some(line => line.trim())) return;
    cards.push({ field: key, label, value, lines });
  }
  return cards;
}

export function directorPreviewPlan(log) {
  if (!log || !(log.status === 'loading' || (['error', 'cancelled'].includes(log.status) && log.request))) return null;
  const plan = { _streamPreview: true, _generation: {
    status: log.status, completion: { finishReason: log.completion?.finishReason, interrupted: log.completion?.interrupted }, quality: log.quality, creativeOptions: log.creativeOptions,
  } };
  for (const card of completeDirectorCards(log.response)) {
    if (OBJECT_FIELDS.has(card.field)) plan[card.field] = card.value;
    else (plan[card.field] ||= []).push(card.value);
  }
  return plan;
}

const qualityIssues = log => Array.isArray(log?.quality) ? log.quality : Array.isArray(log?.quality?.issues) ? log.quality.issues : [];

export function directorSectionEnabled(plan, field, fallback = {}) {
  const options = plan?._generation?.creativeOptions || fallback;
  if (field === 'parallel_scene') return options.parallelSceneEnabled !== false;
  if (field === 'interlude') return options.interludeEnabled !== false;
  if (field === 'world_chatter') return Boolean(options.worldChatterEnabled);
  if (['factions', 'faction_relations', 'world_events'].includes(field)) return Boolean(options.geopoliticsEnabled);
  return true;
}

// Small in-place status, derived from the same recorded outcome as the log.
// Never infer a token limit or model refusal from an absent section alone.
export function directorSectionStatus(plan, field) {
  const generation = plan?._generation;
  if (!generation || !['error', 'cancelled'].includes(generation.status)) return '';
  const value = plan[field], hasContent = Array.isArray(value) ? value.length > 0 : Boolean(value);
  const affected = qualityIssues(generation).some(issue => issue?.field === field);
  if (!affected && (generation.quality || hasContent || ['faction_relations', 'world_updates'].includes(field))) return '';
  if (generation.status === 'cancelled') return '已停止，本栏未完整生成。详情见日志。';
  if (/^(length|max_tokens|max_output_tokens)$/i.test(generation.completion?.finishReason || '')) return '回复截断，本栏未完整生成。详情见日志。';
  return hasContent ? '本栏返回不完整，已收到内容保留供查阅。详情见日志。' : '本栏未生成成功。详情见日志。';
}

export function directorQualitySummary(log) {
  const fields = new Map();
  for (const issue of qualityIssues(log)) {
    if (!issue || !Object.hasOwn(FIELDS, issue.field)) continue;
    const previous = fields.get(issue.field) || { missing: 0, reason: '' };
    fields.set(issue.field, { missing: Math.max(previous.missing, Number.isInteger(issue.missing) ? issue.missing : 0), reason: previous.reason || (typeof issue.reason === 'string' ? issue.reason : '') });
  }
  return [...fields].map(([field, issue]) => `${FIELDS[field][0]}${issue.missing > 0 ? `缺 ${issue.missing} ${['parallel_scene', 'interlude'].includes(field) ? '张' : '条'}` : `：${issue.reason || '内容尚未符合要求'}`}`).join('；');
}

// Used only by the world-map's read-only streaming surface. Other pages reuse
// their ordinary field renderers, without an extra progress card or write actions.
export function renderDirectorLive(log, { fields = Object.keys(FIELDS), tasksOnly = false } = {}) {
  if (!log || log.status === 'success') return '';
  const plan = directorPreviewPlan(log);
  const cards = completeDirectorCards(log.response).filter(card => fields.includes(card.field) && (!tasksOnly || ['quests','chain_reactions'].includes(card.field))
    && (!log.creativeOptions || directorSectionEnabled(plan, card.field, log.creativeOptions)));
  const shown = new Set(cards.map(card => card.field));
  if (plan && log.status !== 'loading') for (const field of fields) {
    if ((!tasksOnly || ['quests', 'chain_reactions'].includes(field)) && directorSectionEnabled(plan, field) && directorSectionStatus(plan, field)) shown.add(field);
  }
  return [...shown].map(field => {
    const status = directorSectionStatus(plan, field);
    return `<section class="sd-card sd-plan-section"><h3>${escape(FIELDS[field][0])}</h3>${status ? `<p class="sd-muted sd-director-section-notice">${escape(status)}</p>` : ''}${cards.filter(card => card.field === field).map(card => `<article class="sd-lib-row"><div class="sd-lib-main">${card.lines.map((line, i) => i === 0 ? `<h4>${escape(line)}</h4>` : `<p>${escape(line)}</p>`).join('')}</div></article>`).join('')}</section>`;
  }).join('');
}

export function modelFailureText(log) {
  const info = log.completion;
  const failed = ['error', 'cancelled'].includes(log.status) || info?.interrupted;
  if (!failed) return log.error || '';
  const reason = info?.finishReason;
  const finish = reason && !['stop', 'end_turn', 'completed'].includes(reason)
    ? `结束原因：${reason}` : info?.interrupted ? '回复未完整完成。' : '';
  return [...new Set([log.error || (log.status === 'cancelled' ? '本次推演已停止。' : '本次推演未完成。'), finish].filter(Boolean))].join('\n');
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
  const qualityText = directorQualitySummary(log);
  return `${memoryLabel ? `<p class="sd-muted sd-memory-notice">${escape(memoryLabel)}</p>` : ''}
    ${memoryCodes.length ? `<details><summary>记忆核对详情</summary><pre class="sd-term">${escape(memoryCodes.join('\n'))}</pre></details>` : ''}
    ${qualityText ? `<p class="sd-muted sd-creative-quality">本次内容未完整：${escape(qualityText)}。${log.repairResponse || log.repairError ? '处理详情见历史补写记录。' : '未自动补写。'}</p>` : ''}
    ${info?.compatibility ? `<p class="sd-muted">${escape(info.compatibility)}</p>` : ''}
    ${info?.rawTransport ? `<details><summary>未解析的原始响应片段</summary><pre class="sd-term">${escape(info.rawTransport)}</pre></details>` : ''}
    <details class="sd-log-reasoning" ${log.reasoning ? '' : 'hidden'}><summary>渠道返回的推理内容</summary><pre class="sd-term sd-term-reasoning">${escape(log.reasoning || '')}</pre></details>
    ${log.repairResponse || log.repairError ? `<div class="sd-log-cap">历史补写记录 · 独立模型回复</div><pre class="sd-term">${escape(log.repairResponse || log.repairError)}</pre>` : ''}`;
}

export function paintModelLog(root, log, renderEntry) {
  if (!root) return;
  const entry = [...root.querySelectorAll('.sd-log-entry')].find(node => node.dataset.acc === `log-${log.id}`);
  if (!entry) return;
  if (!entry.open) {
    if (renderEntry && log.status !== 'loading') {
      const template = entry.ownerDocument.createElement('template'); template.innerHTML = renderEntry(log, 0, false);
      const summary = template.content.firstElementChild?.querySelector('summary');
      if (summary) entry.querySelector('summary').innerHTML = summary.innerHTML;
    }
    return;
  }
  const request = entry?.querySelector('.sd-term-request');
  if (request && request._rawText !== log.request) { request.textContent = log.request || '暂无'; request._rawText = log.request; }
  const pre = entry?.querySelector('.sd-term-response');
  if (pre && pre._rawText !== log.response) {
    const follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24, top = pre.scrollTop;
    pre.textContent = log.response || '';
    pre._rawText = log.response;
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
