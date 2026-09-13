// Presentation-only, loaded on entry to the Comfy workbench. No network, storage or node execution.
import { normalizeComfyReferenceSelection } from './qianmu-comfy-reference-contract.js';
import { storyboardComfyPromptFormat } from './qianmu-comfy-workbench-binding.js';
import { resolveStoryboardComfyCloud, RUNNINGHUB_INSTANCE_TYPES } from './qianmu-comfy-cloud-protocol.js';
import { comfyWorkbenchConsoleLink } from './qianmu-comfy-console.js';
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fields = [
  ['width','Width','number','min="64" max="8192" step="64"'],
  ['height','Height','number','min="64" max="8192" step="64"'],
  ['steps','Steps','number','min="1" max="300"'],
  ['cfg','CFG','number','min="0" max="100" step="0.1"'],
  ['seed','Seed','number','min="-1"'],['sampler','Sampler','text',''],['scheduler','Scheduler','text',''],
];
export function renderRunningHubInstanceOptions(value = '') {
  return `${value && !RUNNINGHUB_INSTANCE_TYPES.includes(value) ? '<option value="[invalid]" selected>运行配置待核对</option>' : ''}<option value="" ${!value ? 'selected' : ''}>平台默认</option>`
    + RUNNINGHUB_INSTANCE_TYPES.map(tier => `<option value="${tier}" ${value === tier ? 'selected' : ''}>${{default:'标准',plus:'增强',ultra:'高显存'}[tier]}</option>`).join('');
}
export function renderComfyReferenceControls(profile, capabilities, collapsed = {}) {
  if (!capabilities.reference && !profile.comfyReferences) return '';
  let selection, error = '';
  try { selection = normalizeComfyReferenceSelection(profile.comfyReferences); } catch (cause) { error = cause.message; }
  const items = selection?.items || [];
  return `<details class="sd-card sd-comfy-reference-card" data-storyboard-card="comfy-references" ${collapsed['comfy-references'] ? '' : 'open'}>
    <summary><b>工作流参考图</b><span>${items.length || ''}</span></summary><div class="sd-storyboard-card-body">
      <div class="sd-comfy-reference-toolbar"><button type="button" class="sd-btn ${selection?.enabled ? 'active' : ''}" data-comfy-reference-action="toggle" aria-pressed="${Boolean(selection?.enabled)}" ${items.length ? '' : 'disabled'}>启用参考</button>
      <label class="sd-btn sd-comfy-reference-upload">选择图片<input type="file" class="sd-reader-native-file sd-comfy-reference-file" accept="image/png,image/jpeg,image/webp" multiple ${capabilities.reference ? '' : 'disabled'}></label>
      <button type="button" class="sd-btn" data-comfy-reference-action="bind" ${items.length && capabilities.reference ? '' : 'disabled'}>确认绑定</button></div>
      <small>按参考 1～N 顺序接入工作流；不自动关联角色。使用参考可能额外计费。</small>
      ${error || !capabilities.reference ? `<p role="alert">${escape(error || '当前工作流不支持参考图，请移除旧选择或切回原工作流')}</p>` : ''}
      <div class="sd-comfy-reference-items">${items.map((item,index) => `<article><img src="${escape(item.url)}" alt="参考 ${index+1}" loading="lazy"><div><b>参考 ${index+1}</b><span>${escape(item.name)}</span></div>
        <div class="sd-comfy-reference-actions"><button type="button" class="sd-icon-btn" data-comfy-reference-action="up" data-reference-index="${index}" aria-label="参考 ${index+1} 前移" ${index ? '' : 'disabled'}><i data-qm-icon="qm-regular-arrow-left"></i></button><button type="button" class="sd-icon-btn" data-comfy-reference-action="down" data-reference-index="${index}" aria-label="参考 ${index+1} 后移" ${index+1 < items.length ? '' : 'disabled'}><i data-qm-icon="qm-regular-arrow-right"></i></button><button type="button" class="sd-icon-btn" data-comfy-reference-action="remove" data-reference-index="${index}" aria-label="移除参考 ${index+1}"><i data-qm-icon="qm-regular-x"></i></button></div></article>`).join('')}</div>
      ${profile.comfyReferences ? '<button type="button" class="sd-btn" data-comfy-reference-action="clear">移除全部选择</button>' : ''}
      <div class="sd-comfy-reference-status" role="status"></div>
    </div></details>`;
}
export function renderComfyWorkbench({profile, capabilities, connection=null, collapsed={}, workflowNotice='', workflowNodes=0, librarySelection=null,autoEnabled=false,poolSelection=null}, shared={}) {
  const consoleLink=comfyWorkbenchConsoleLink(profile,connection);
  let runninghub = false; try { runninghub = resolveStoryboardComfyCloud(connection)?.provider === 'runninghub'; } catch (_) { /* Existing connection card shows the invalid URL. */ }
  const runtime = runninghub ? `<label><span>运行配置</span><select class="text_pole sd-storyboard-field" data-storyboard-field="comfyInstanceType" aria-label="RunningHub 运行配置">${renderRunningHubInstanceOptions(profile.comfyInstanceType)}</select></label>` : '';
  const controls=fields.filter(([key])=>capabilities[key]).map(([key,label,type,attrs])=>
    `<label><span>${label}</span><input class="text_pole sd-storyboard-field${['width','height'].includes(key)?` sd-storyboard-${key}`:''}" data-storyboard-field="${key}" type="${type}" ${attrs} value="${escape(profile[key])}"></label>`).join('');
  const workflow=typeof profile.comfyWorkflow==='string'&&profile.comfyWorkflow.trim().startsWith('{')?profile.comfyWorkflow:'';
  const formatLabel={tags:'标签',natural_language:'自然语言',character_blocks:'分角色文本','[invalid]':'分类待核对'}[storyboardComfyPromptFormat(profile)] || '';
  const modes=`<div class="sd-storyboard-engine-modes" role="group" aria-label="Comfy 工作流方式"><button type="button" data-comfy-auto="false" aria-pressed="${!autoEnabled}" class="${!autoEnabled?'active':''}">固定工作流</button><button type="button" data-comfy-auto="true" aria-pressed="${autoEnabled}" class="${autoEnabled?'active':''}">自动择流</button></div>`;
  const fixed=`
    <details class="sd-card sd-comfy-workflow-card" data-storyboard-card="comfy-workflow" ${!workflow||workflowNotice||collapsed['comfy-workflow']===false?'open':''}>
      <summary><span><b>工作流</b><small>${workflowNodes?`${workflowNodes} 个节点`:'API Workflow'}${formatLabel?` · ${formatLabel}`:''}</small></span><button type="button" class="sd-icon-btn sd-comfy-open-library" title="工作流库" aria-label="工作流库"><i data-qm-icon="qm-regular-folder"></i></button></summary>
      <div class="sd-storyboard-card-body">
        <button type="button" class="sd-btn sd-comfy-open-library">${librarySelection?.name?`基于 ${escape(librarySelection.name)} · v${Number(librarySelection.version)||1}`:workflow?'当前自定义工作流':'选择或导入工作流'}</button>
        <button type="button" class="sd-btn sd-comfy-check-workflow" ${workflow?'':'disabled'}>检查节点与模型</button>
        ${consoleLink?`<a class="sd-btn sd-comfy-console-link" href="${escape(consoleLink.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="打开线上编辑页；修改后重新导出并导入，本地保存版本不会自动改变">${escape(consoleLink.label)}</a>`:''}
        <div class="sd-comfy-readiness-result" role="status" hidden></div>
        <div class="sd-storyboard-workflow-warning sd-storyboard-connection-result failed" ${workflowNotice?'':'hidden'} role="status"><span>${escape(workflowNotice)}</span></div>
      </div>
    </details>
    <details class="sd-card sd-storyboard-params" data-storyboard-card="comfy-params" ${(collapsed['comfy-params'] ?? collapsed.params)?'':'open'}><summary><b>工作流设置</b></summary>
      <div class="sd-storyboard-card-body">${shared.parameterPresets||''}${controls||runtime?`<div class="sd-storyboard-grid sd-storyboard-grid-two">${runtime}${controls}</div>`:''}${shared.variants||''}</div>
    </details>
    ${renderComfyReferenceControls(profile, capabilities, collapsed)}`;
  const automatic=`<details class="sd-card" data-storyboard-card="comfy-auto" ${collapsed['comfy-auto']?'':'open'}><summary><b>候选工作流</b></summary><div class="sd-storyboard-card-body">
    <button type="button" class="sd-btn sd-comfy-open-pools">${poolSelection&&!poolSelection.invalid?`${escape(poolSelection.name)} · v${Number(poolSelection.version)}`:'选择候选方案'}</button>
    <small class="sd-comfy-library-note">固定分工优先 · 一镜一张</small>
    ${poolSelection?.invalid?'<p role="alert">候选方案来源待核对，请重新选择</p>':''}
    </div></details>`;
  return `<div class="sd-comfy-workbench">${shared.connection||''}${modes}${autoEnabled?automatic:fixed}
    <div class="sd-comfy-scene-actions">${autoEnabled?'<button type="button" class="sd-btn sd-comfy-link-toggle">关联前层风格</button>':''}<button type="button" class="sd-btn sd-comfy-scene-toggle">连续场景</button></div><div class="sd-comfy-link-list" hidden></div><div class="sd-comfy-scene-list" hidden></div></div>`;
}
