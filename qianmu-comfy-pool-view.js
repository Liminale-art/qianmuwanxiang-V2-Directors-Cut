// Candidate maintenance is not a generation surface. Only explicit saved workflow versions may be enrolled.
import { createComfyPoolStore, exportComfyPoolDocument, importComfyPoolDocument } from './qianmu-comfy-pool-store.js';
import { COMFY_SELECTION_SCHEMA, COMFY_SELECTION_LIMIT, normalizeComfyAutoPool, normalizeComfyClassification } from './qianmu-comfy-selection.js';
import { readPinnedComfyRouteWorkflow, applyComfyRouteRecipe } from './qianmu-comfy-route.js';
import { renderComfyClassificationBadges } from './qianmu-comfy-library-view.js';
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const clone = value => structuredClone(value);
const size = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const icon = (action, label, glyph) => `<button type="button" class="sd-icon-btn" data-pool-action="${action}" aria-label="${escape(label)}" title="${escape(label)}"><i class="fa-solid fa-${glyph}"></i></button>`;
const freshId = () => { if (!globalThis.crypto?.randomUUID) throw Error('请使用 HTTPS 或本机地址编辑候选方案'); return globalThis.crypto.randomUUID(); };
const classificationOf = document => normalizeComfyClassification(Object.hasOwn(document, 'classification') ? document.classification : { version: 1 });
const readyClassification = value => value.contentClasses.length > 0 && Boolean(value.promptFormat);
export function createComfyPoolCandidate({ namespace, choice, previous = null, id = previous?.id || freshId() }) {
  const { recipe, roles, useReferences, references } = choice;
  if (useReferences && references?.enabled !== true) throw Error('当前工作台没有已启用参考图，请重新选择');
  const target = { providerId: 'comfy', modelId: 'comfy-workflow', capabilityModelId: 'comfy-workflow', parameterPresetId: '',
    connectionPresetId: previous?.target.connectionPresetId || '', comfyWorkflowBinding: recipe.binding, comfyCharacterEnabled: roles,
    comfyReferences: useReferences ? clone(references) : clone(previous?.target.comfyReferences || null) };
  applyComfyRouteRecipe({}, target, recipe); // Includes namespace/graph ownership of copied or retained references.
  const candidate = { id, enabled: false, priority: previous?.priority ?? 0, target, classification: classificationOf(recipe.document) };
  return normalizeComfyAutoPool({ schema: COMFY_SELECTION_SCHEMA, namespace, id: 'draft', revision: 'draft', candidates: [candidate] }).candidates[0];
}
export async function verifyComfyPoolCandidate({ candidate, namespace, connections, guard = async () => {}, readRecipe = readPinnedComfyRouteWorkflow }) {
  if (candidate.target.connectionPresetId && !connections.some(row => row.id === candidate.target.connectionPresetId)) throw Error('此候选的 API 预设已失效，请重新选择');
  await guard(); const recipe = await readRecipe({ namespace, binding: candidate.target.comfyWorkflowBinding, guard }); await guard();
  const classification = classificationOf(recipe.document);
  if (JSON.stringify(classification) !== JSON.stringify(normalizeComfyClassification(candidate.classification))) throw Error('候选分类与固定版本不符，请重新绑定工作流');
  if (!readyClassification(classification)) throw Error('请先在工作流版本中声明内容范围和提示格式，再重新绑定');
  applyComfyRouteRecipe({}, candidate.target, recipe); await guard();
  return '固定版本已核对，执行资格将在生成前检查';
}
function renderMember(candidate, view) {
  const target = candidate.target, binding = target.comfyWorkflowBinding, missing = target.connectionPresetId && !view.connections.some(row => row.id === target.connectionPresetId);
  return `<details class="sd-card sd-comfy-pool-member" data-pool-member="${escape(candidate.id)}" ${view.openMembers?.has(candidate.id) ? 'open' : ''}>
    <summary><b>${escape(binding.name)} · v${binding.version}</b><small>${candidate.enabled ? '参与选择' : '未参与'}</small></summary><div class="sd-storyboard-card-body">
    <div class="sd-comfy-pool-tools"><button type="button" class="sd-btn" data-pool-action="replace-member">更换固定版本</button><button type="button" class="sd-btn" data-pool-action="toggle-member" aria-pressed="${candidate.enabled}">参与选择</button>${icon('remove-member','移除候选','trash-can')}</div>
    <div class="sd-comfy-pool-fields"><label><span>API 预设</span><select class="text_pole" data-pool-member-field="connectionPresetId"><option value="">当前 Comfy API</option>${missing ? `<option value="${escape(target.connectionPresetId)}" selected>API 预设已失效</option>` : ''}${view.connections.map(row => `<option value="${escape(row.id)}" ${row.id === target.connectionPresetId ? 'selected' : ''}>${escape(row.name)}</option>`).join('')}</select></label><label><span>同等匹配优先级</span><input class="text_pole" data-pool-member-field="priority" type="number" min="-100" max="100" step="1" inputmode="numeric" value="${escape(candidate.priority)}"></label></div>
    <div class="sd-comfy-pool-tools"><button type="button" class="sd-btn" data-pool-action="toggle-roles" aria-pressed="${target.comfyCharacterEnabled}">角色库实现</button><span class="sd-comfy-library-note">参考图 ${target.comfyReferences?.items.length || 0} 张</span>${target.comfyReferences ? icon('clear-references','移除本候选参考图','xmark') : ''}</div>
    ${renderComfyClassificationBadges(candidate)}
    <small class="sd-comfy-library-note">${escape(view.checks?.get(candidate.id) || (readyClassification(candidate.classification) ? '分类随固定版本；更改请在工作流库保存新版本后重绑。' : '分类待完善：请先声明内容范围和提示格式。'))}</small>
  </div></details>`;
}
export function renderComfyPools(view) {
  view = { connections: [], ...view };
  const draft = view.draft, disabled = view.busy ? 'disabled' : '';
  const body = draft ? `<div class="sd-comfy-pool-tools">${icon('cancel','取消编辑','xmark')}<span>${escape(draft.name || '新候选方案')}${draft.version ? ` · v${draft.version}` : ''}</span>${icon('export-draft','导出草稿','download')}${icon('save-copy','另存新方案','copy')}${icon('save','保存方案版本','floppy-disk')}</div>
    <section class="sd-card"><div class="sd-storyboard-card-body"><label><span>方案名</span><input class="text_pole" data-pool-name maxlength="80" value="${escape(draft.name)}"></label>
    ${draft.versions?.length ? `<label><span>已保存版本</span><select class="text_pole" data-pool-version>${draft.versions.map(row => `<option value="${escape(row.revision)}" ${row.revision === draft.revision ? 'selected' : ''}>v${row.version} · ${escape(row.name)}</option>`).join('')}</select></label>` : ''}
    <div class="sd-comfy-pool-tools"><button type="button" class="sd-btn" data-pool-action="style-lock" aria-label="连续场景风格锁" title="连续场景风格锁" aria-pressed="${draft.pool.styleLock}">续场风格锁</button><button type="button" class="sd-btn" data-pool-action="check-members">核对版本</button>${icon('add-member','添加候选工作流','plus')}</div>
    <small class="sd-comfy-library-note">仅配置候选，不改变镜头台；自动运行尚未开放。保存前会核对参与候选的固定版本。</small></div></section>
    <div class="sd-comfy-pool-members">${draft.pool.candidates.map(candidate => renderMember(candidate, view)).join('')}</div>`
    : `<div class="sd-comfy-pool-tools"><button type="button" class="sd-btn" data-pool-action="library">工作流库</button><input class="text_pole" type="search" data-pool-search aria-label="搜索候选方案" value="${escape(view.search || '')}">${icon('import','导入候选方案','upload')}${icon('new','新建候选方案','plus')}</div>
    <div class="sd-comfy-pool-tools"><button type="button" class="sd-btn" data-pool-action="archived" aria-pressed="${Boolean(view.archived)}">归档</button><span class="sd-comfy-library-note">${view.usage ? `${view.usage.count} 个方案 · ${view.usage.versions} 个版本 · ${size(view.usage.bytes)} / ${size(view.usage.limit)}` : ''}</span>${icon('refresh','刷新候选方案','rotate')}</div>
    <div class="sd-comfy-pool-rows">${(view.rows || []).map(row => `<section class="sd-card" data-pool-id="${escape(row.id)}" data-pool-search-name="${escape(row.name.toLocaleLowerCase())}" ${view.search && !row.name.toLocaleLowerCase().includes(view.search.toLocaleLowerCase()) ? 'hidden' : ''}><div class="sd-comfy-pool-tools"><button type="button" class="sd-comfy-library-name" data-pool-action="${view.archived ? 'export' : 'edit'}">${escape(row.name)}</button><span>v${row.version}</span></div><small class="sd-comfy-library-note">${row.candidateCount} 个候选 · ${size(row.totalBytes)}</small><div class="sd-comfy-pool-tools sd-comfy-pool-row-actions">${view.archived ? `${icon('restore','恢复候选方案','rotate-left')}${icon('export','导出最新版本','download')}${icon('purge','永久清理全部版本','trash-can')}` : `${icon('edit','编辑方案','pen')}${icon('copy','复制为新方案','copy')}${icon('export','导出最新版本','download')}${icon('archive','归档方案','box-archive')}`}</div></section>`).join('')}</div>`;
  return `<div class="sd-comfy-library sd-comfy-pools" aria-busy="${Boolean(view.busy)}">${view.error ? `<p role="alert" class="sd-comfy-library-note">${escape(view.error)}</p>` : ''}<fieldset ${disabled}>${body}</fieldset><input type="file" data-pool-file accept=".json,application/json" hidden></div>`;
}

export function createComfyPoolController({ resolveNamespace, getScopeKey = () => '', getConnections = () => [], pickWorkflow,
  onLibrary = () => {}, isCurrent = () => true, notify = () => {}, confirm = async () => false, onIcons = () => {}, download,
  store = createComfyPoolStore(), readRecipe = readPinnedComfyRouteWorkflow } = {}) {
  const view = { rows: [], usage: null, search: '', archived: false, draft: null, busy: false, error: '', connections: [], openMembers: new Set(), checks: new Map() };
  let host = null, entry = 0, namespace = '', verifiedEntry = -1, disposed = false;
  const scrolls = { list: 0, draft: 0 };
  const visible = () => !disposed && host?.isConnected && isCurrent();
  const scroller = () => host?.closest('.sd-storyboard-scroll');
  const remember = () => {
    if (scroller()) scrolls[view.draft ? 'draft' : 'list'] = scroller().scrollTop;
    if (view.draft && host?.querySelector('.sd-comfy-pools')) view.openMembers = new Set([...host.querySelectorAll('[data-pool-member]')].filter(node => node.open).map(node => node.dataset.poolMember));
  };
  const restore = () => { if (scroller()) scroller().scrollTop = scrolls[view.draft ? 'draft' : 'list']; };
  const render = () => {
    if (!visible()) return; view.connections = getConnections().map(row => ({ id: row.id, name: row.name }));
    host.innerHTML = verifiedEntry === entry ? renderComfyPools(view) : `<div role="status">${escape(view.error || '正在读取候选方案')}${view.error ? '<button type="button" class="sd-btn" data-pool-action="refresh">重试</button>' : ''}</div>`;
    bind(); onIcons(host); restore();
  };
  const resetAccount = value => { namespace = value; view.rows = []; view.usage = null; view.draft = null; view.checks.clear(); view.openMembers.clear(); scrolls.list = scrolls.draft = 0; };
  async function run(work) {
    if (!visible() || view.busy) return; if (verifiedEntry === entry) remember(); const token = entry, scope = getScopeKey(); view.busy = true; view.error = '';
    const originalDraft = view.draft, active = host.contains(globalThis.document?.activeElement) ? globalThis.document.activeElement : null;
    const focus = active ? { action: active.dataset.poolAction, field: active.dataset.poolMemberField, member: active.closest('[data-pool-member]')?.dataset.poolMember } : null;
    // Disable in place so focus and native controls do not disappear when an operation starts.
    const fieldset = host.querySelector('fieldset'); if (fieldset) fieldset.disabled = true; host.querySelector('.sd-comfy-pools')?.setAttribute('aria-busy', 'true');
    const live = () => visible() && token === entry && scope === getScopeKey();
    const guard = async () => {
      if (!live()) throw Error('页面已切换，操作未继续'); const value = await resolveNamespace(); if (!live()) throw Error('页面已切换，操作未继续');
      if (namespace && namespace !== value) { resetAccount(value); verifiedEntry = -1; throw Error('账户已切换，请刷新候选方案'); }
      namespace = value; verifiedEntry = entry; return value;
    };
    try { await guard(); await work(guard); }
    catch (error) { if (live()) { view.error = error.message || '候选方案操作失败'; notify(view.error, 'warning'); } }
    finally {
      view.busy = false;
      if (visible()) {
        const departed = token !== entry || scope !== getScopeKey(); if (departed) verifiedEntry = -1;
        render();
        if (!departed && originalDraft === view.draft && focus && (focus.action || focus.field)) {
          const node = [...host.querySelectorAll('[data-pool-action],[data-pool-member-field]')].find(node => node.dataset.poolAction === focus.action
            && node.dataset.poolMemberField === focus.field && node.closest('[data-pool-member]')?.dataset.poolMember === focus.member);
          node?.focus({ preventScroll: true });
        }
        if (departed) void run(loadList);
      }
    }
  }
  const loadList = async guard => {
    const account = namespace, rows = await store.list(account, { archived: view.archived }), usage = await store.usage(account); await guard();
    view.rows = rows; view.usage = usage;
  };
  const draftFrom = (value, versions = [], copy = false) => {
    remember(); view.draft = { id: copy ? '' : value.id || '', revision: copy ? '' : value.revision || '', version: copy ? 0 : value.version || 0,
      name: value.name, pool: clone(value.pool), versions: copy ? [] : versions, dirty: copy };
    view.openMembers.clear(); view.checks.clear(); scrolls.draft = 0;
  };
  const read = async (row, guard) => {
    const value = await store.load(namespace, row.id, row.revision); await guard(); if (!value) throw Error('此候选版本已不存在，请刷新列表'); return value;
  };
  const exportValue = value => {
    const data = exportComfyPoolDocument(value.name, value.pool, namespace);
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${data.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}.qianmu-candidates.json`);
  };
  const validateMembers = async (members, guard, collect = false) => {
    const connections = getConnections(), cache = new Map();
    const cachedRead = options => { const key = JSON.stringify(options.binding); if (!cache.has(key)) cache.set(key, readRecipe(options)); return cache.get(key); };
    for (const member of members) {
      try { const message = await verifyComfyPoolCandidate({ candidate: member, namespace, connections, guard, readRecipe: cachedRead }); view.checks.set(member.id, message); }
      catch (error) { await guard(); view.checks.set(member.id, error.message); if (!collect) throw error; }
    }
    await guard();
  };
  async function action(name, id, memberId) {
    if (name === 'import') { if (!view.busy && visible()) host.querySelector('[data-pool-file]')?.click(); return; }
    await run(async guard => {
      const row = view.rows.find(row => row.id === id), draft = view.draft, member = draft?.pool.candidates.find(item => item.id === memberId);
      if (name === 'library') { await guard(); onLibrary(); return; }
      if (name === 'refresh') { await loadList(guard); return; }
      if (name === 'archived') { view.archived = !view.archived; await loadList(guard); return; }
      if (name === 'new') { draftFrom({ name: '', pool: { schema: COMFY_SELECTION_SCHEMA, namespace, id: freshId(), revision: freshId(), enabled: false, styleLock: true, candidates: [] } }); return; }
      if (name === 'cancel') { if (draft?.dirty && !await confirm('放弃尚未保存的候选方案编辑？')) return; await guard(); view.draft = null; view.checks.clear(); await loadList(guard); return; }
      if (name === 'export-draft') { exportValue(draft); return; }
      if (name === 'style-lock') { draft.pool.styleLock = !draft.pool.styleLock; draft.dirty = true; return; }
      if (name === 'add-member' || name === 'replace-member') {
        if (!draft || name === 'replace-member' && !member) return;
        if (!member && draft.pool.candidates.length >= COMFY_SELECTION_LIMIT) throw Error('每个方案最多 32 个候选');
        const choice = await pickWorkflow({ namespace, previous: member ? clone(member) : null, guard }); await guard(); if (!choice) return;
        const next = createComfyPoolCandidate({ namespace, choice, previous: member });
        if (member) draft.pool.candidates[draft.pool.candidates.indexOf(member)] = next; else draft.pool.candidates.push(next);
        draft.dirty = true; view.checks.delete(next.id); view.openMembers.add(next.id); notify('候选已绑定，请核对后开启参与选择', 'success'); return;
      }
      if (name === 'remove-member' && member) { draft.pool.candidates = draft.pool.candidates.filter(item => item !== member); draft.dirty = true; view.openMembers.delete(member.id); view.checks.delete(member.id); return; }
      if (name === 'toggle-member' && member) { if (!member.enabled) await validateMembers([member], guard); await guard(); member.enabled = !member.enabled; draft.dirty = true; return; }
      if (name === 'toggle-roles' && member) { member.target.comfyCharacterEnabled = !member.target.comfyCharacterEnabled; draft.dirty = true; view.checks.delete(member.id); return; }
      if (name === 'clear-references' && member) { member.target.comfyReferences = null; draft.dirty = true; view.checks.delete(member.id); return; }
      if (name === 'check-members') { await validateMembers(draft.pool.candidates, guard, true); return; }
      if (name === 'save' || name === 'save-copy') {
        if (!draft) return; const captured = normalizeComfyAutoPool(draft.pool);
        await validateMembers(captured.candidates.filter(row => row.enabled), guard); await guard();
        await store.save(namespace, { id: name === 'save' ? draft.id : '', expectedRevision: name === 'save' ? draft.revision : '', name: draft.name, pool: captured }); await guard();
        view.draft = null; view.archived = false; view.checks.clear(); await loadList(guard); notify('候选方案已保存，未启用自动运行', 'success'); return;
      }
      if (!row) return;
      if (name === 'edit' || name === 'copy') { const value = await read(row, guard), versions = name === 'edit' ? await store.versions(namespace, row.id) : []; await guard(); draftFrom({ ...value, name: name === 'copy' ? `${value.name} 副本`.slice(0, 80) : value.name }, versions, name === 'copy'); return; }
      if (name === 'export') { exportValue(await read(row, guard)); return; }
      if (name === 'archive' || name === 'restore') { await store.archive(namespace, row.id, row.revision, name === 'archive'); await guard(); await loadList(guard); return; }
      if (name === 'purge') { if (!await confirm(`永久清理「${row.name}」全部 ${row.version} 个版本？无法撤回；需要保留请先导出。不会删除工作流或生成记录。`)) return;
        await guard(); await store.purge(namespace, row.id, row.revision); await guard(); await loadList(guard); notify('候选方案的全部版本已清理，无法撤回', 'success'); }
    });
  }
  function bind() {
    host.querySelectorAll('[data-pool-action]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); void action(button.dataset.poolAction, button.closest('[data-pool-id]')?.dataset.poolId, button.closest('[data-pool-member]')?.dataset.poolMember); }));
    host.querySelector('[data-pool-search]')?.addEventListener('input', event => { view.search = event.target.value; host.querySelectorAll('[data-pool-search-name]').forEach(row => { row.hidden = !row.dataset.poolSearchName.includes(view.search.toLocaleLowerCase()); }); });
    host.querySelector('[data-pool-name]')?.addEventListener('input', event => { if (view.busy || !view.draft) return; view.draft.name = event.target.value; view.draft.dirty = true; });
    host.querySelectorAll('[data-pool-member]').forEach(node => node.addEventListener('toggle', () => { if (!node.isConnected) return; node.open ? view.openMembers.add(node.dataset.poolMember) : view.openMembers.delete(node.dataset.poolMember); }));
    host.querySelectorAll('[data-pool-member-field]').forEach(field => field.addEventListener('input', () => {
      if (view.busy || !view.draft || !visible()) return; const member = view.draft.pool.candidates.find(row => row.id === field.closest('[data-pool-member]').dataset.poolMember); if (!member) return;
      if (field.dataset.poolMemberField === 'priority') member.priority = field.validity.badInput || field.value === '' ? NaN : Number(field.value);
      else member.target.connectionPresetId = field.value;
      view.draft.dirty = true; view.checks.delete(member.id);
    }));
    host.querySelector('[data-pool-version]')?.addEventListener('change', event => { const revision = event.target.value; void run(async guard => {
      const draft = view.draft; if (draft.dirty && !await confirm('切换版本会放弃未保存的编辑，继续？')) return; await guard();
      const row = draft.versions.find(item => item.revision === revision); if (!row) return; draftFrom(await read(row, guard), draft.versions);
    }); });
    host.querySelector('[data-pool-file]')?.addEventListener('change', event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      void run(async guard => { if (file.size > 1024 * 1024) throw Error('候选方案文件须小于 1 MB');
        const contents = await file.text(); await guard(); const value = importComfyPoolDocument(contents, namespace);
        if (view.draft?.dirty && !await confirm('导入会替换未保存的编辑，继续？')) return; await guard(); draftFrom(value, [], true);
        notify('已导入草稿，候选均保持关闭，请逐项核对', 'success');
      });
    });
  }
  return Object.freeze({
    mount(element) { const previous = host; host = element; if (previous !== element) entry++; render(); if (previous !== element || verifiedEntry !== entry) void run(loadList); },
    detach() { remember(); host = null; entry++; },
    dispose() { disposed = true; host = null; entry++; view.draft = null; view.checks.clear(); store.close(); },
  });
}
