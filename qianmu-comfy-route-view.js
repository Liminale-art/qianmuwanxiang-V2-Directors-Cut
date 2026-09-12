import { createComfyWorkflowStore } from './qianmu-comfy-library.js';
import { pinComfyRouteWorkflow } from './qianmu-comfy-route.js';
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderComfyRoutePicker({ heads, selectedId, versions = [], selectedRevision = '', useReferences = false, hasReferences = false, message = '' }) {
  return `<div class="sd-comfy-route-picker"><h3>固定工作流分工</h3>
    <label><span>工作流方案</span><select class="text_pole" data-comfy-route-pick="workflow"><option value="">选择工作流</option>${heads.map(row => `<option value="${escape(row.id)}" ${row.id === selectedId ? 'selected' : ''}>${escape(row.name)}</option>`).join('')}</select></label>
    <label><span>已保存版本</span><select class="text_pole" data-comfy-route-pick="revision"><option value="">选择版本</option>${versions.map(row => `<option value="${escape(row.revision)}" ${row.revision === selectedRevision ? 'selected' : ''}>v${row.version} · ${escape(row.name)}</option>`).join('')}</select></label>
    <label class="sd-comfy-route-check"><input type="checkbox" data-comfy-route-references ${useReferences ? 'checked' : ''} ${hasReferences ? '' : 'disabled'}><span>复制当前工作台参考图（须匹配此图）</span></label>
    <small>本分工使用该版本的工作流与参数，不改变当前工作台。保留本分工已绑参考图；换图不匹配时须先移除。本地核对不等于远端执行验证，确认不会生成。</small>
    <p role="status">${escape(message || (!heads.length ? '请先在 Comfy 工作流库保存方案。' : ''))}</p></div>`;
}

export async function openComfyRoutePicker({ context, namespace, binding, hasReferences = false, guard = async () => {}, createStore = createComfyWorkflowStore }) {
  if (!context?.Popup || !context.POPUP_TYPE) throw Error('当前 ST 不支持工作流选择面板');
  await guard(); const store = createStore();
  try {
    const heads = await store.list(namespace); await guard();
    let selectedId = heads.some(row => row.id === binding?.id) ? binding.id : '', selectedRevision = binding?.revision || '', useReferences = false, message = '';
    for (;;) {
      await guard();
      let versions = selectedId ? await store.versions(namespace, selectedId) : []; await guard();
      if (!versions.some(row => row.revision === selectedRevision)) selectedRevision = '';
      const wrap = document.createElement('div');
      wrap.innerHTML = renderComfyRoutePicker({ heads, selectedId, versions, selectedRevision, useReferences, hasReferences, message });
      const select = wrap.querySelector('[data-comfy-route-pick=workflow]'), revision = wrap.querySelector('[data-comfy-route-pick=revision]'), status = wrap.querySelector('[role=status]');
      let alive = true, request = 0, loadedId = selectedId, loading = false;
      select.addEventListener('change', async () => {
        const id = select.value, token = ++request; loading = true; loadedId = ''; revision.innerHTML = '<option value="">正在读取版本</option>'; revision.disabled = true;
        try {
          await guard(); const next = id ? await store.versions(namespace, id) : []; await guard();
          if (!alive || token !== request) return;
          versions = next; loadedId = id;
          revision.innerHTML = '<option value="">选择版本</option>' + versions.map(row => `<option value="${escape(row.revision)}">v${row.version} · ${escape(row.name)}</option>`).join('');
          status.textContent = '';
        } catch (error) { if (alive && token === request) status.textContent = error.message || '版本读取失败'; }
        finally { if (alive && token === request) { loading = false; revision.disabled = false; } }
      });
      let result;
      try { result = await new context.Popup(wrap, context.POPUP_TYPE.CONFIRM, '', { okButton: '绑定分工', cancelButton: '取消' }).show(); }
      finally { alive = false; request++; }
      await guard(); if (!result) return null;
      selectedId = select.value; selectedRevision = revision.value;
      useReferences = hasReferences && wrap.querySelector('[data-comfy-route-references]').checked;
      const row = !loading && loadedId === selectedId && versions.find(item => item.revision === selectedRevision && item.id === selectedId);
      if (!row) { message = '请选择已读取的工作流与具体版本'; continue; }
      const recipe = await pinComfyRouteWorkflow({ namespace, selection: row, guard, createStore }); await guard();
      return { recipe, roles:false, useReferences };
    }
  } finally { store.close(); }
}
