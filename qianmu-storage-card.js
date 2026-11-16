// 数据管理卡（C-13①）：占用总览（按类别分色块）＋分组的备份／恢复入口＋清理。
// 只负责生成标记；各按钮沿用原有类名与 data 属性，由入口文件里既有的处理函数绑定。
import { STORAGE_CATEGORY_LABELS, STORAGE_CATEGORY_COLORS, storageCleanupOptions } from './qianmu-storage-backup-view.js?v=1.59.538';

// 类别占用：按字节降序；占比不足 1.5% 的并入「其他」，免得色条碎成一排细线。
export function storageCategoryBlocks(categories = []) {
  const rows = categories.map(item => ({ key: String(item.category), bytes: Math.max(0, Number(item.bytes) || 0) })).filter(item => item.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((sum, item) => sum + item.bytes, 0);
  if (!total) return { total: 0, blocks: [] };
  const blocks = [], minor = { key: 'other', bytes: 0 };
  for (const item of rows) (item.key === 'other' || item.bytes / total < 0.015 ? (minor.bytes += item.bytes) : blocks.push(item));
  if (minor.bytes) blocks.push(minor);
  return { total, blocks: blocks.map(item => ({ ...item, label: STORAGE_CATEGORY_LABELS[item.key] || item.key, color: STORAGE_CATEGORY_COLORS[item.key] || STORAGE_CATEGORY_COLORS.other, share: item.bytes / total })) };
}

const percent = share => `${(share * 100).toFixed(share < 0.1 ? 2 : 1)} %`;

function overview(data, format, escape) {
  const { total, blocks } = storageCategoryBlocks(data.categories);
  const origin = data.origin?.available ? `${format(data.origin.usage)} / ${format(data.origin.quota)}` : '浏览器未提供配额信息';
  const head = `<div class="sd-dm-total"><span>千幕资料已盘点</span><b>${escape(format(data.trackedBytes))}</b></div>`;
  const site = `<p class="sd-dm-site">本设备 ST 站点已用 / 配额<b>${escape(origin)}</b></p>`;
  if (!blocks.length) return `${head}<p class="sd-muted">暂未发现千幕本地数据。</p>${site}`;
  return `${head}
    <div class="sd-dm-bar" role="img" aria-label="千幕资料按类别占用">${blocks.map(item => `<i style="flex-grow:${Math.max(item.share, 0.012).toFixed(4)};--sd-dm-color:${item.color}" title="${escape(item.label)} ${escape(format(item.bytes))}"></i>`).join('')}</div>
    <div class="sd-dm-legend">${blocks.map(item => `<div class="sd-dm-legend-item" style="--sd-dm-color:${item.color}"><em>${escape(item.label)}</em><b>${escape(format(item.bytes))}</b><span>${percent(item.share)}</span></div>`).join('')}</div>
    ${site}`;
}

const row = (label, actions, extra = '') => `<div class="sd-dm-row${extra}"><span>${label}</span><div class="sd-dm-actions">${actions}</div></div>`;
const transfer = (key, label, accept = 'application/json,.json', more = '') => row(label,
  `<button type="button" class="sd-btn" data-storage-export="${key}" aria-label="导出${label}">导出</button><button type="button" class="sd-btn" data-storage-pick="${key}" aria-label="导入${label}">导入</button>${more}<input type="file" data-storage-import="${key}" accept="${accept}" hidden>`,
  key === 'storyboard' ? ' sd-storage-backup-storyboard' : '');
const jump = (label, attrs, text = '管理') => row(label, `<button type="button" class="sd-btn" ${attrs}>${text}</button>`);
const group = (title, body, note = '', extra = '') => `<div class="sd-dm-group${extra}"><h4>${title}</h4>${note ? `<p class="sd-dm-note">${note}</p>` : ''}${body}</div>`;

function sizes(data, format, escape) {
  const known = (record, value) => record?.status === 'ready' && Number.isFinite(value) ? escape(format(value)) : '暂未读取';
  const rows = [
    ['角色资料', known(data.characterStorage, data.characterStorage?.documents?.bytes)],
    ['Vibe 素材', known(data.vibeStorage, (data.vibeStorage?.assets?.bytes ?? NaN) + (data.vibeStorage?.previews?.bytes ?? NaN))],
    ['工作流', known(data.comfyStorage?.workflows, data.comfyStorage?.workflows?.bytes)],
    ['工作流方案', known(data.comfyStorage?.pools, data.comfyStorage?.pools?.bytes)],
    ['场外特助', known(data.assistantStorage?.native, data.assistantStorage?.native?.total?.bytes)],
    ['正文收藏', known(data.collectionStorage, data.collectionStorage?.bytes)],
    ['图片配置', known(data.recipeStorage, data.recipeStorage?.bytes)],
  ];
  const recipe = data.recipeStorage, full = recipe?.status === 'ready' && (recipe.bytes >= recipe.limitBytes || recipe.files >= recipe.limitFiles);
  return `<details class="sd-dm-fold" data-storage-section="sizes"><summary>各资料库占用</summary>${rows.map(([label, value]) => `<div class="sd-dm-row"><span>${label}</span><span>${value}</span></div>`).join('')}${full ? '<p class="sd-dm-note" role="status">图片配置存储已满，请先备份再清理。</p>' : ''}</details>`;
}

// state: { status, data, error, progress }。service: 后端服务状态的现成标记。pressure(data) 返回浏览器空间压力。
export function renderStorageCard({ state, format, escape, service = '', pressure = () => ({ level: 'normal' }) }) {
  const { status, data, error } = state, scanning = status === 'loading', ready = status === 'ready';
  const progress = state.progress || { done: 0, total: 0 };
  const scanText = progress.total ? `已检查 ${progress.done}/${progress.total} 项 · ${Math.floor(progress.done / progress.total * 100)}%` : '准备扫描…';
  const bar = scanning ? `<p class="sd-muted" role="status">${scanText}</p><progress max="${Math.max(1, progress.total)}" value="${progress.done}" aria-label="资料扫描进度"></progress>` : '';
  let head, top;
  if (!data) {
    head = `<h3>数据管理</h3><button type="button" class="sd-btn sd-storage-refresh" ${scanning ? 'disabled' : ''}>${scanning ? '扫描中' : '扫描资料'}</button>`;
    top = scanning ? bar : `<p class="sd-muted" role="status">${status === 'error' ? `扫描未完成：${escape(error || '当前环境不可用')}` : '备份可直接使用；扫描后查看资料占用与清理项目。'}</p>`;
  } else {
    const level = pressure(data), used = Math.min(999, Math.max(0, Math.round(Number(level.ratio || 0) * 100)));
    const warn = level.level === 'critical'
      ? `<p class="sd-storage-pressure is-critical" role="status">浏览器来源空间已使用 ${used}% · 剩余约 ${escape(format(level.freeBytes))}。建议先备份再按模块整理；千幕不会自动清理。</p>`
      : level.level === 'warning' ? `<p class="sd-storage-pressure is-warning" role="status">浏览器来源空间已使用 ${used}% · 剩余约 ${escape(format(level.freeBytes))}。可按需整理，千幕不会自动清理。</p>` : '';
    const incomplete = [data.vibeStorage, data.restoreStorage, data.characterStorage, data.comfyStorage, data.mappingStorage, data.carrierStorage, data.focusLibrary, data.notesStorage, data.galleryCatalogStorage, data.assistantStorage, data.collectionStorage].some(item => ['unavailable', 'partial'].includes(item?.status))
      || [data.imageAttempts, data.imageChannels, data.serviceReceipts, data.comfyReceipts].some(item => item?.error);
    head = `<div><h3>数据管理</h3><p class="sd-summary-note">${escape(new Date(data.sampledAt).toLocaleTimeString())}</p></div><button type="button" class="sd-icon-btn sd-storage-refresh" title="重新扫描" aria-label="重新扫描" ${scanning ? 'disabled' : ''}><i class="fa-solid fa-rotate${scanning ? ' fa-spin' : ''}"></i></button>`;
    top = `${bar}<div class="sd-dm-overview">${overview(data, format, escape)}</div>${warn}${incomplete ? '<p class="sd-storage-pressure is-warning" role="status">部分数据暂不可读取，请稍后刷新；未读取的部分不会按零占用处理。</p>' : ''}
      <p class="sd-dm-note">浏览器额度不含 ST 服务器上的聊天和资料；千幕盘点包含不同存储位置的已知项目，不代表 VPS 总容量，两者不可相加。</p>${sizes(data, format, escape)}`;
  }
  const canClean = ready && data && (data.manageableBytes > 0 || storageCleanupOptions(data).some(item => item.bytes > 0));
  const backups = group('备份与恢复',
    row('配置', '<button type="button" class="sd-btn sd-export-config">导出</button><button type="button" class="sd-btn sd-import-config">导入</button><input type="file" class="sd-import-config-file" accept="application/json,.json" hidden>')
    + '<button type="button" class="sd-btn sd-undo-config" hidden>撤回本次恢复</button>'
    + transfer('notes', '便笺') + transfer('collection', '正文收藏') + transfer('favorites', '语音收藏') + transfer('audio', '音频缓存')
    + transfer('storyboard', '分镜资源', '.qmb,application/json,.json', '<button type="button" class="sd-icon-btn sd-storage-storyboard-recover" title="核对导入" aria-label="核对分镜导入"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></button>')
    + transfer('reader', '伴读资料')
    + row('场外特助会话', '<button type="button" class="sd-btn sd-storage-assistant-library">备份 / 恢复</button>')
    + row('全部导出', '<button type="button" class="sd-btn sd-storage-export-all">选择并导出</button>'));
  const presets = group('预设与提示词',
    transfer('templates', '剧本库') + transfer('theater', '剧札') + transfer('schemes', '台词指导方案') + row('伴读总结提示词', '<button type="button" class="sd-btn" data-storage-export="summary" aria-label="导出伴读总结提示词">导出</button><button type="button" class="sd-btn sd-storage-summary-import" aria-label="导入伴读总结提示词">导入</button>'),
    '这些也包含在「配置」导出里；这里可单独导出、导入某一类。取景预设随「分镜资源」一起备份。');
  const libraries = group('资料库',
    jump('角色库', 'data-storage-open="characters"') + jump('Vibe 库', 'data-storage-open="vibes"')
    + jump('Comfy 工作流', 'data-storage-comfy-library="workflows"') + jump('Comfy 候选方案', 'data-storage-comfy-library="pools"')
    + jump('字体库', 'data-storage-open="fonts"') + jump('专注语音库', 'data-storage-open="focus"'),
    '各库自带整库备份与恢复，点「管理」直达。');
  const elsewhere = group('其他位置',
    jump('聊天备份与找回', 'data-storage-open="recovery"', '打开') + jump('正则导入导出', 'data-storage-open="regex"', '打开') + jump('忆幕记忆备份', 'data-storage-open="yimu"', '说明'),
    '酒馆与忆幕自己的数据，在各自的面板里管理。');
  const advanced = `<details class="sd-dm-fold sd-dm-advanced" data-storage-section="advanced"><summary>高级</summary><p class="sd-dm-note">排查与迁移用，平时不需要。</p>
    ${jump('分镜恢复记录', 'data-storage-open="restores"')}${jump('迁移凭据', 'data-storage-open="mappings"')}${jump('图库目录保全', 'data-storage-open="catalog"')}${jump('Comfy 领取记录', 'data-storage-open="receipts"', '查看')}${row('图库来源核对', '<button type="button" class="sd-btn sd-storage-gallery-check">核对</button>')}
    <p class="sd-storage-scope sd-storage-gallery-check-status" role="status" hidden></p></details>`;
  const cleanup = group('清理', data || scanning
    ? `<div class="sd-dm-clean"><button type="button" class="sd-btn sd-primary sd-storage-clean" ${canClean ? '' : 'disabled'}>选择清理项目</button><button type="button" class="sd-btn sd-storage-chat-clean" ${ready && data?.idb?.chatScopes?.length ? '' : 'disabled'}>按聊天清理缓存</button></div>`
    : '<p class="sd-dm-note">扫描资料后可选择清理项目。</p>', '', ' sd-dm-cleanup');
  return `<section class="sd-card sd-storage-card sd-dm">
    <div class="sd-card-title-row">${head}</div>
    ${top}
    <div class="sd-storage-backup-section sd-dm-body">${backups}${presets}${libraries}${elsewhere}${advanced}${cleanup}</div>
    ${service}
  </section>`;
}

// 「全部导出」的可选项：只列能直接导出成文件的那些；各库的整库备份仍在各库的管理页。
export const STORAGE_EXPORT_ALL = Object.freeze([
  ['config', '配置'], ['templates', '剧本库'], ['theater', '剧札'], ['schemes', '台词指导方案'], ['summary', '伴读总结提示词'],
  ['notes', '便笺'], ['collection', '正文收藏'], ['favorites', '语音收藏'], ['audio', '音频缓存'], ['storyboard', '分镜资源'], ['reader', '伴读资料'],
]);

// 勾选要导出的项目。返回选中的键（取消则为空数组）。
// styleFrom／variables：把面板当前主题的变量抄到浮层上（浮层挂在 body 下，继承不到面板的变量）。
export function chooseStorageExports(document, { labels = STORAGE_EXPORT_ALL, themeClass = '', styleFrom = null, variables = [] } = {}) {
  return new Promise(resolve => {
    const layer = document.createElement('div');
    layer.className = `sd-dm-export-layer ${themeClass}`.trim();
    const source = styleFrom ? document.defaultView?.getComputedStyle?.(styleFrom) : null;
    for (const name of source ? variables : []) { const value = source.getPropertyValue(name); if (value) layer.style.setProperty(name, value); }
    layer.innerHTML = `<div class="sd-dm-export-dialog" role="dialog" aria-modal="true" aria-label="选择要导出的项目"><h4>选择要导出的项目</h4><p class="sd-dm-note">每一项各生成一个文件，浏览器可能会询问是否允许连续下载。体积大的项目（分镜资源、音频缓存）默认不选。</p>
      <div class="sd-dm-export-list">${labels.map(([key, label]) => `<label><input type="checkbox" value="${key}" ${['storyboard', 'audio'].includes(key) ? '' : 'checked'}><span>${label}</span></label>`).join('')}</div>
      <div class="sd-dm-export-actions"><button type="button" class="sd-btn" data-act="cancel">取消</button><button type="button" class="sd-btn sd-primary" data-act="go">导出所选</button></div></div>`;
    const finish = keys => { layer.remove(); resolve(keys); };
    layer.addEventListener('click', event => {
      if (event.target === layer || event.target.closest?.('[data-act="cancel"]')) return finish([]);
      if (event.target.closest?.('[data-act="go"]')) finish([...layer.querySelectorAll('input:checked')].map(input => input.value));
    });
    layer.addEventListener('keydown', event => { if (event.key === 'Escape') finish([]); });
    document.body.appendChild(layer);
    layer.querySelector('[data-act="go"]')?.focus();
  });
}

// 通用的「一组带 id 的条目」导出／导入（台词指导方案等没有专用格式的库）。
export function exportItemsFile(document, { type, items, name }) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ type, version: 1, items }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function readItemsFile(file, type) {
  const data = JSON.parse(await file.text());
  const items = Array.isArray(data) ? data : data?.type === type && Array.isArray(data.items) ? data.items : null;
  if (!items) throw new Error('文件里没有可导入的条目');
  return items.filter(item => item && typeof item === 'object' && !Array.isArray(item));
}
