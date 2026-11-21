// 数据管理卡：占用总览（按类别分色块）＋「备份：导出／导入」＋「清理：扫描并清理／按聊天清理」。
// 只负责生成标记与就地更新；按钮由入口文件绑定。卡片主体是静态的，扫描进度与占用只改写顶部两块，不整卡重画。
import { STORAGE_CATEGORY_LABELS, STORAGE_CATEGORY_COLORS } from './qianmu-storage-backup-view.js?v=1.59.592';

// 扫描各步的名称，顺序与入口文件 collectStorageInventory 的任务表一致；只用于进度文字。
export const STORAGE_SCAN_LABELS = Object.freeze(['浏览器空间', '本机资料', '伴读插图', '生图记录', '连接记录', '领取记录', 'Comfy 记录', 'Comfy 资料', 'Vibe 素材', '恢复记录',
  '角色资料', '迁移凭据', '来源记录', '专注语音', '便笺', '图库目录', '图片配置', '场外特助', '正文收藏', '汇总']);

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
  const { blocks } = storageCategoryBlocks(data.categories);
  const origin = data.origin?.available ? `${format(data.origin.usage)} / ${format(data.origin.quota)}` : '浏览器未提供配额信息';
  const head = `<div class="sd-dm-total"><span>千幕资料已盘点</span><b>${escape(format(data.trackedBytes))}</b></div>`;
  const site = `<p class="sd-dm-site">本设备 ST 站点已用 / 配额<b>${escape(origin)}</b></p>`;
  if (!blocks.length) return `${head}<p class="sd-muted">暂未发现千幕本地数据。</p>${site}`;
  return `${head}
    <div class="sd-dm-bar" role="img" aria-label="千幕资料按类别占用">${blocks.map(item => `<i style="flex-grow:${Math.max(item.share, 0.012).toFixed(4)};--sd-dm-color:${item.color}" title="${escape(item.label)} ${escape(format(item.bytes))}"></i>`).join('')}</div>
    <div class="sd-dm-legend">${blocks.map(item => `<div class="sd-dm-legend-item" style="--sd-dm-color:${item.color}"><em>${escape(item.label)}</em><b>${escape(format(item.bytes))}</b><span>${percent(item.share)}</span></div>`).join('')}</div>
    ${site}`;
}

// 扫描进度：「3/20项 角色资料 15%」。
export function storageScanText(progress = {}) {
  const total = Number(progress.total) || 0, done = Math.min(total, Number(progress.done) || 0);
  if (!total) return '准备扫描…';
  return `${done}/${total}项 ${STORAGE_SCAN_LABELS[Math.min(done, STORAGE_SCAN_LABELS.length - 1)]} ${Math.floor(done / total * 100)}%`;
}

// state: { status, data, error, progress }。service: 后端服务状态的现成标记。pressure(data) 返回浏览器空间压力。
export function renderStorageCard({ state, format, escape, service = '', pressure = () => ({ level: 'normal' }) }) {
  const { status, data, error } = state, scanning = status === 'loading';
  const progress = state.progress || { done: 0, total: 0 };
  const done = progress.total ? Math.min(100, Math.max(0, progress.done / progress.total * 100)) : 0;
  const bar = scanning ? `<div class="sd-dm-scan" style="--sd-dm-done:${done.toFixed(1)}%"><p role="status">${escape(storageScanText(progress))}</p><progress max="${Math.max(1, progress.total)}" value="${progress.done}" aria-label="资料扫描进度"></progress></div>` : '';
  let top = bar;
  if (data) {
    const level = pressure(data), used = Math.min(999, Math.max(0, Math.round(Number(level.ratio || 0) * 100)));
    const warn = ['critical', 'warning'].includes(level.level)
      ? `<p class="sd-storage-pressure is-${level.level}" role="status">浏览器空间已用 ${used}% · 剩余约 ${escape(format(level.freeBytes))}，建议先导出备份再清理。</p>` : '';
    top += `<div class="sd-dm-overview">${overview(data, format, escape)}</div>${warn}`;
  } else if (status === 'error') top += `<p class="sd-muted" role="status">扫描未完成：${escape(error || '当前环境不可用')}</p>`;
  const head = `<h3>数据管理</h3>${scanning ? '' : '<button type="button" class="sd-icon-btn sd-storage-refresh" title="重新扫描" aria-label="重新扫描"><i class="fa-solid fa-rotate"></i></button>'}`;
  const row = (label, actions) => `<div class="sd-dm-row"><span>${label}</span><div class="sd-dm-actions">${actions}</div></div>`;
  return `<section class="sd-card sd-storage-card sd-dm">
    <div class="sd-card-title-row sd-dm-head">${head}</div>
    <div class="sd-dm-top">${top}</div>
    <div class="sd-storage-backup-section sd-dm-body">
      ${row('备份', '<button type="button" class="sd-btn sd-storage-export">导出</button><button type="button" class="sd-btn sd-storage-import">导入</button><input type="file" class="sd-storage-import-file" multiple accept=".zip,application/zip,.json,application/json" hidden><input type="file" class="sd-storage-import-slot" hidden>')}
      <button type="button" class="sd-btn sd-undo-config" hidden>撤回本次恢复</button>
      ${row('清理', '<button type="button" class="sd-btn sd-storage-clean">扫描并清理</button><button type="button" class="sd-btn sd-storage-chat-clean">按聊天清理</button>')}
    </div>
    ${service}
  </section>`;
}

// 就地更新：只改写内容变了的标题行、顶部总览、后端服务三块；主体（按钮与文件输入）始终不动，所以扫描过程不闪。
const LIVE_PARTS = ['.sd-dm-head', '.sd-dm-top', '.sd-storage-service'];
export function paintStorageCard(current, html, { icons = () => {}, bind = () => {} } = {}) {
  const template = current.ownerDocument.createElement('template');
  template.innerHTML = html.trim();
  const next = template.content.firstElementChild;
  if (!next) return false;
  for (const selector of LIVE_PARTS) {
    const live = current.querySelector(`:scope > ${selector}`), fresh = next.querySelector(`:scope > ${selector}`);
    if (!live || !fresh) continue;
    const raw = fresh.innerHTML;
    if (live._qmRaw === raw) continue;
    const refocus = live.contains(current.ownerDocument.activeElement) && current.ownerDocument.activeElement.className;
    live.replaceChildren(...fresh.childNodes);
    live._qmRaw = raw;
    for (const name of ['data-status', 'hidden']) fresh.hasAttribute(name) ? live.setAttribute(name, fresh.getAttribute(name)) : live.removeAttribute(name);
    icons(live);
    if (refocus) [...live.querySelectorAll('button')].find(button => button.className === refocus)?.focus({ preventScroll: true });
  }
  bind(current);
  return true;
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
