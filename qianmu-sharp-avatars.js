// 头像清晰化：酒馆显示头像时取的是压缩过的缩略图（/thumbnail?type=avatar…），放大一点就糊。
// 这里把页面上的角色头像与用户头像换成原图地址；装了千幕就生效，没有开关。
// 只换头像：背景缩略图只出现在背景挑选列表里，换成原图会一次加载整库的大图，不值当。
// 原图取不到（文件被删、路径不同）时退回缩略图，且不再反复尝试同一张。

const FOLDERS = Object.freeze({ avatar: 'characters', persona: 'User Avatars' });

/** 缩略图地址 → 原图地址；不是头像缩略图就返回空串。 */
export function sharpImageUrl(value, base = 'http://localhost/') {
  if (typeof value !== 'string' || !value.includes('thumbnail')) return '';
  let url, origin;
  try { url = new URL(value, base); origin = new URL(base).origin; } catch { return ''; }
  if (url.origin !== origin || !/(^|\/)thumbnail$/.test(url.pathname)) return '';
  const folder = FOLDERS[url.searchParams.get('type')], file = url.searchParams.get('file');
  if (!folder || !file || file.split(/[\\/]/).includes('..')) return '';
  const stamp = url.searchParams.get('t');
  return `${url.pathname.replace(/thumbnail$/, '')}${encodeURI(folder)}/${file.split('/').map(encodeURIComponent).join('/')}${stamp ? `?t=${encodeURIComponent(stamp)}` : ''}`;
}

/** 内联样式里的背景图（酒馆有几处用它放头像）：把其中的头像缩略图换掉；没有可换的返回空串。 */
export function sharpBackground(value, base, failed = new Set()) {
  if (typeof value !== 'string' || !value.includes('thumbnail')) return '';
  let changed = false;
  const next = value.replace(/url\((["']?)([^"')]+)\1\)/g, (whole, quote, inner) => {
    const sharp = sharpImageUrl(inner, base);
    if (!sharp || failed.has(sharp)) return whole;
    changed = true; return `url("${sharp}")`;
  });
  return changed ? next : '';
}

/** 开始替换：先扫一遍现有的，再盯着之后插入或改了地址的。返回停止函数。 */
export function startSharpAvatars({ document = globalThis.document, window = globalThis } = {}) {
  if (!document?.documentElement || typeof window.MutationObserver !== 'function') return () => {};
  const base = document.baseURI || window.location?.href, failed = new Set();
  const fixImage = image => {
    const src = image.getAttribute?.('src'), sharp = sharpImageUrl(src, base);
    if (!sharp || failed.has(sharp)) return;
    image.addEventListener('error', () => { failed.add(sharp); if (image.getAttribute('src') === sharp) image.setAttribute('src', src); }, { once: true });
    image.setAttribute('src', sharp);
  };
  const fixStyle = node => {
    const sharp = sharpBackground(node.style?.backgroundImage, base, failed);
    if (sharp) node.style.backgroundImage = sharp;
  };
  const fix = node => {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') fixImage(node); else fixStyle(node);
  };
  const scan = root => {
    if (root.nodeType !== 1) return;
    fix(root);
    for (const image of root.querySelectorAll?.('img[src*="thumbnail"]') || []) fixImage(image);
    for (const node of root.querySelectorAll?.('[style*="thumbnail"]') || []) fixStyle(node);
  };
  scan(document.documentElement);
  const observer = new window.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') fix(record.target);
      else for (const node of record.addedNodes) scan(node);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
  return () => observer.disconnect();
}
