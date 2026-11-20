// 「时长」面板：现实里用了多久。上面一张热力格（一列一周），下面几张大数字卡；另有一页按角色排的聊天交互时长。
// 经典与极简是卡片式；纸间是书页式（界行、朱砂）。颜色全取当前主题的变量，不自带配色。
import { usageSummary, durationText, clockText } from './qianmu-usage-tracker.js?v=1.59.582';

const ROOT_ID = 'qianmu-usage';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const md = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const ymd = at => { const d = new Date(at); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
export function lastChatText(at, now = Date.now()) {
    if (!at) return '还没有聊过';
    const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000), d = new Date(at);
    const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return days <= 0 ? `今天 ${clock}` : days === 1 ? `昨天 ${clock}` : days < 7 ? `${days} 天前` : ymd(at);
}

const STYLE = `
#${ROOT_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100dvh; z-index: 10030; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  --u-ink: var(--sd-text, #ececf1); --u-mute: var(--sd-muted, #9a9aa6); --u-bg: var(--sd-window-bg, #0f0f12); --u-card: var(--sd-card, #1b1b20); --u-line: var(--sd-border, #2c2c34); --u-accent: var(--sd-accent, #ff5c7a); }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .qm-usage-backdrop { position: absolute; inset: 0; background: #0008; }
#${ROOT_ID} .qm-usage-panel { position: relative; width: min(430px, 100%); max-height: min(760px, calc(100dvh - 32px)); overflow: auto; overscroll-behavior: contain; scrollbar-width: none; padding: 14px; border-radius: 26px; background: var(--u-bg); color: var(--u-ink); border: 1px solid var(--u-line); box-shadow: 0 24px 70px #0007; font-size: 14px; }
#${ROOT_ID} header { display: flex; align-items: center; gap: 8px; padding: 2px 4px 12px; }
#${ROOT_ID} header h3 { margin: 0; flex: 1; font-size: 17px; font-weight: 600; letter-spacing: .12em; }
#${ROOT_ID} button { all: unset; cursor: pointer; box-sizing: border-box; }
#${ROOT_ID} button:focus-visible { outline: 2px solid var(--u-accent); outline-offset: 2px; }
#${ROOT_ID} .qm-usage-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; color: var(--u-mute); font-size: 18px; }
#${ROOT_ID} .qm-usage-icon:hover { color: var(--u-ink); }
#${ROOT_ID} .qm-usage-heat { padding: 16px 16px 14px; border-radius: 22px; background: linear-gradient(color-mix(in srgb, var(--u-accent) 22%, var(--u-card)), color-mix(in srgb, var(--u-accent) 9%, var(--u-card))); }
#${ROOT_ID} .qm-usage-grid { display: grid; grid-template-columns: 14px repeat(var(--weeks), minmax(0, 1fr)); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: 4px; align-items: center; }
#${ROOT_ID} .qm-usage-grid b { font-weight: 500; font-size: 10px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-grid i { aspect-ratio: 1; border-radius: 28%; background: color-mix(in srgb, var(--u-ink) 9%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="-1"] { visibility: hidden; }
#${ROOT_ID} .qm-usage-grid i[data-level="1"] { background: color-mix(in srgb, var(--u-accent) 34%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="2"] { background: color-mix(in srgb, var(--u-accent) 56%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="3"] { background: color-mix(in srgb, var(--u-accent) 78%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="4"] { background: var(--u-accent); }
#${ROOT_ID} .qm-usage-range { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 13px; }
#${ROOT_ID} .qm-usage-range span { flex: 1; text-align: center; }
#${ROOT_ID} .qm-usage-range button { width: 40px; height: 28px; display: grid; place-items: center; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--u-ink) 22%, transparent); }
#${ROOT_ID} .qm-usage-range button[disabled] { opacity: .3; cursor: default; }
#${ROOT_ID} .qm-usage-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
#${ROOT_ID} .qm-usage-card { display: flex; flex-direction: column; min-height: 132px; padding: 14px 16px; border-radius: 22px; background: var(--u-card); border: 1px solid color-mix(in srgb, var(--u-line) 60%, transparent); }
#${ROOT_ID} .qm-usage-card em { font-style: normal; font-size: 13px; color: var(--u-ink); }
#${ROOT_ID} .qm-usage-card strong { margin: auto 0; font-size: clamp(30px, 10vw, 42px); line-height: 1; font-weight: 700; letter-spacing: .01em; color: var(--u-accent); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-card small { font-size: 12px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-card small b { font-weight: 500; color: var(--u-ink); }
#${ROOT_ID} .qm-usage-bar { height: 5px; border-radius: 999px; background: color-mix(in srgb, var(--u-ink) 12%, transparent); overflow: hidden; }
#${ROOT_ID} .qm-usage-bar > span { display: block; height: 100%; width: var(--p, 0%); border-radius: inherit; background: var(--u-accent); }
#${ROOT_ID} .qm-usage-link { display: flex; width: 100%; align-items: center; justify-content: space-between; margin-top: 10px; padding: 14px 16px; border-radius: 22px; background: var(--u-card); border: 1px solid color-mix(in srgb, var(--u-line) 60%, transparent); }
#${ROOT_ID} .qm-usage-link span:last-child { color: var(--u-mute); }
#${ROOT_ID} .qm-usage-char { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 4px 12px; align-items: center; padding: 12px 6px; border-top: 1px solid color-mix(in srgb, var(--u-line) 70%, transparent); }
#${ROOT_ID} .qm-usage-char:first-of-type { border-top: 0; }
#${ROOT_ID} .qm-usage-face { grid-row: 1 / span 3; width: 46px; height: 46px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; background: color-mix(in srgb, var(--u-accent) 22%, var(--u-card)); color: var(--u-accent); font-size: 18px; }
#${ROOT_ID} .qm-usage-face img { width: 100%; height: 100%; object-fit: cover; }
#${ROOT_ID} .qm-usage-char .who { display: flex; justify-content: space-between; gap: 10px; }
#${ROOT_ID} .qm-usage-char .who span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .qm-usage-char .who span:last-child { flex: none; color: var(--u-accent); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-char small { font-size: 12px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-empty { margin: 0; padding: 40px 10px; text-align: center; color: var(--u-mute); }
#${ROOT_ID} [hidden] { display: none !important; }
/* 纸间：一页书。直角、文武线、界行；数字是朱砂。 */
#${ROOT_ID}[data-qm-theme="editorial"] { --u-ink: var(--qm-ink); --u-mute: var(--qm-muted); --u-bg: var(--qm-bg); --u-card: transparent; --u-line: color-mix(in srgb, var(--qm-ink) 18%, transparent); --u-accent: var(--qm-accent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-panel { border-radius: 0; border: 2px solid var(--u-ink); outline: 1px solid color-mix(in srgb, var(--u-ink) 70%, transparent); outline-offset: -6px; padding: 20px; font-family: var(--qm-editorial-font, serif); }
#${ROOT_ID}[data-qm-theme="editorial"] header { border-bottom: 1px solid var(--u-ink); margin-bottom: 14px; }
#${ROOT_ID}[data-qm-theme="editorial"] header h3 { color: var(--u-accent); font-weight: 400; letter-spacing: .3em; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-heat { background: none; border-radius: 0; padding: 4px 2px 14px; border-bottom: 1px solid var(--u-line); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i { border-radius: 0; background: transparent; outline: 1px solid color-mix(in srgb, var(--u-ink) 14%, transparent); outline-offset: -1px; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-range button, #${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-icon { border-radius: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-cards { gap: 0; margin-top: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card { border-radius: 0; border: 0; border-bottom: 1px solid var(--u-line); min-height: 112px; padding: 14px 10px; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card:nth-child(odd) { border-right: 1px solid var(--u-line); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card strong { font-weight: 400; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-bar, #${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-face { border-radius: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-link { border-radius: 0; border: 0; border-bottom: 1px solid var(--u-ink); margin-top: 0; padding-inline: 10px; }
#${ROOT_ID}[data-qm-theme="glass"] .qm-usage-panel, #${ROOT_ID}[data-qm-theme="glass"] .qm-usage-card, #${ROOT_ID}[data-qm-theme="glass"] .qm-usage-link { backdrop-filter: blur(22px) saturate(1.12); -webkit-backdrop-filter: blur(22px) saturate(1.12); }
`;

export function usageMarkup(data, { now = Date.now(), offset = 0, weeks = 20, page = 'home', avatarUrl = key => `/thumbnail?type=avatar&file=${encodeURIComponent(key)}` } = {}) {
    const shifted = now - offset * weeks * 7 * 86400000, summary = usageSummary(data, now, { weeks }), heat = offset ? usageSummary(data, shifted, { weeks }) : summary;
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const cells = heat.cells.map(cell => `<i data-level="${cell.level}"${cell.ms ? ` title="${md(cell.time)} · ${esc(durationText(cell.ms))}"` : ''}></i>`).join('');
    const older = Object.keys(data?.days || {}).sort()[0], hasOlder = older ? new Date(`${older}T00:00:00`).getTime() < heat.from : false;
    const card = (title, big, small, bar = null) => `<section class="qm-usage-card"><em>${title}</em><strong>${big}</strong>${bar === null ? `<small>${small}</small>` : `<small>${small}</small><div class="qm-usage-bar" style="margin-top:6px"><span style="--p:${Math.max(0, Math.min(100, Math.round(bar * 100)))}%"></span></div>`}</section>`;
    const home = `<section class="qm-usage-heat"><div class="qm-usage-grid" style="--weeks:${weeks}">${labels.map(name => `<b>${name}</b>`).join('')}${cells}</div>
      <div class="qm-usage-range"><button type="button" data-usage-shift="1" aria-label="更早"${hasOlder ? '' : ' disabled'}>‹</button><span>${ymd(heat.from)} — ${ymd(heat.to)}</span><button type="button" data-usage-shift="-1" aria-label="更近"${offset ? '' : ' disabled'}>›</button></div></section>
      <div class="qm-usage-cards">
        ${card('今日', clockText(summary.today), `日均 <b>${esc(durationText(summary.average))}</b>`, summary.average ? summary.today / summary.average : 0)}
        ${card('本周', clockText(summary.week), `本月 <b>${esc(durationText(summary.month))}</b>`)}
        ${card('今年', clockText(summary.year), `累计 <b>${esc(durationText(summary.all))}</b>`)}
        ${card('连续', `${summary.streak}<span style="font-size:.4em;margin-left:.3em">天</span>`, `最长 <b>${summary.longest} 天</b>`)}
        ${card('用过的日子', `${summary.activeDays}<span style="font-size:.4em;margin-left:.3em">天</span>`, summary.since ? `始于 <b>${md(summary.since)}</b>` : '今天开始记')}
        ${card('最常在', summary.peak === null ? '—' : `${String(summary.peak).padStart(2, '0')}<span style="font-size:.4em;margin-left:.3em">时</span>`, summary.peak === null ? '还没有记录' : summary.peak < 6 ? '深夜' : summary.peak < 12 ? '上午' : summary.peak < 18 ? '下午' : '夜里')}
      </div>
      <button type="button" class="qm-usage-link" data-usage-page="chars"><span>角色时长</span><span>${summary.chars.length} 位 ›</span></button>`;
    const chars = summary.chars.length ? summary.chars.map(item => `<article class="qm-usage-char"><span class="qm-usage-face"><span>${esc(Array.from(item.name || '？')[0])}</span><img alt="" loading="lazy" src="${esc(item.avatar || avatarUrl(item.key))}" hidden></span>
        <div class="who"><span>${esc(item.name || item.key.replace(/\.[^.]+$/, ''))}</span><span>${esc(durationText(item.ms))}</span></div>
        <div class="qm-usage-bar"><span style="--p:${summary.top ? Math.max(2, Math.round(item.ms / summary.top * 100)) : 0}%"></span></div>
        <small>最后一次聊天：${esc(lastChatText(item.last, now))}</small></article>`).join('') : '<p class="qm-usage-empty">还没有和谁聊过。</p>';
    return `<header>${page === 'chars' ? '<button type="button" class="qm-usage-icon" data-usage-page="home" aria-label="返回">‹</button>' : ''}<h3>${page === 'chars' ? '角色时长' : '时长'}</h3><button type="button" class="qm-usage-icon" data-usage-close aria-label="关闭">✕</button></header>${page === 'chars' ? chars : home}`;
}

/** 打开面板。mount：把根节点交给主题系统（跟随千幕当前主题）。返回关闭函数。 */
export function openUsagePanel({ document = globalThis.document, getData = () => null, themeClass = '', mount = () => {}, now = () => Date.now() } = {}) {
    document.getElementById(ROOT_ID)?.remove();
    if (!document.getElementById(`${ROOT_ID}-style`)) { const style = document.createElement('style'); style.id = `${ROOT_ID}-style`; style.textContent = STYLE; document.head.append(style); }
    const root = document.createElement('div'); root.id = ROOT_ID; if (themeClass) root.className = themeClass;
    root.innerHTML = '<div class="qm-usage-backdrop"></div><section class="qm-usage-panel" role="dialog" aria-modal="true" aria-label="时长"></section>';
    const panel = root.querySelector('.qm-usage-panel');
    let page = 'home', offset = 0;
    const close = () => { document.removeEventListener('keydown', onKey, true); root.remove(); };
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    const paint = () => {
        panel.innerHTML = usageMarkup(getData(), { now: now(), offset, page });
        // 头像取得到才显示；取不到（角色已删）就留着名字的第一个字。
        for (const image of panel.querySelectorAll('.qm-usage-face img')) { image.addEventListener('load', () => { image.hidden = false; image.previousElementSibling.hidden = true; }); if (image.complete && image.naturalWidth) { image.hidden = false; image.previousElementSibling.hidden = true; } }
        panel.scrollTop = 0;
    };
    root.addEventListener('click', event => {
        event.stopPropagation();
        const hit = event.target.closest?.('button, .qm-usage-backdrop');
        if (!hit) return;
        if (hit.matches('.qm-usage-backdrop') || hit.hasAttribute('data-usage-close')) return close();
        if (hit.dataset.usagePage) { page = hit.dataset.usagePage; paint(); }
        else if (hit.dataset.usageShift && !hit.disabled) { offset = Math.max(0, offset + Number(hit.dataset.usageShift)); paint(); }
    });
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'touchstart']) root.addEventListener(name, event => event.stopPropagation());
    document.addEventListener('keydown', onKey, true);
    document.body.append(root); mount(root); paint();
    return close;
}
