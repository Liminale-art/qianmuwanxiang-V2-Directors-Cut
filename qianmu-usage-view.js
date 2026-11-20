// 「微醺记录」面板：现实里在酒馆待了多久。上面一张热力格（一列一周，越深待得越久），紧跟着最近聊过的那位（点进去是常客名单），
// 下面是一格一格的计数。经典与极简是微微内发光的卡片；纸间是书页式（界行、朱砂）。颜色全取当前主题的变量，不自带配色。
import { usageSummary, heatCells, quarterRange, compactTime, durationText, dayKey, zoneShift } from './qianmu-usage-tracker.js?v=1.59.585';

const ROOT_ID = 'qianmu-usage';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pad = value => String(value).padStart(2, '0');
const md = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日`; };
/** 范围条用的短写法：窄屏上也要一行放得下。 */
const dotted = at => { const d = new Date(at); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; };
const ymd = at => { const d = new Date(at); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
export function lastChatText(at, now = Date.now()) {
    if (!at) return '还没有聊过';
    const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000), d = new Date(at);
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return days <= 0 ? `今天 ${clock}` : days === 1 ? `昨天 ${clock}` : days < 7 ? `${days} 天前` : ymd(at);
}
/** 「今日来杯 ××」：名字最多九个字母，最窄的屏上也放得进半宽的格子。 */
export const DRINKS = Object.freeze(['Martini', 'Negroni', 'Mojito', 'Margarita', 'Daiquiri', 'Gimlet', 'Manhattan', 'Sidecar', 'Paloma', 'Bellini', 'Spritz', 'Highball', 'Sazerac', 'Mai Tai', 'Bramble',
    'Americano', 'Gin Fizz', 'Aviation', 'Vesper', 'Last Word', 'Mimosa', 'Sangria', 'Tequila', 'Whisky', 'Sake', 'Umeshu', 'Gin Tonic', 'Rob Roy', 'Old Pal', 'Bijou',
    'Bronx', 'Stinger', 'Bamboo', 'Adonis', 'Martinez', 'Cosmo', 'Zombie', 'Kir', 'Rickey', 'Bourbon', 'Sherry', 'Absinthe', 'Soju', 'Cognac', 'Vermouth']);
export function timeZoneText(date = new Date(), picked = '') {
    let zone = picked; if (!zone) { try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { zone = ''; } }
    const minutes = -date.getTimezoneOffset() + Math.round(zoneShift(date.getTime(), picked) / 60000), sign = minutes < 0 ? '-' : '+', abs = Math.abs(minutes);
    const offset = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
    // 只留城市名：「Asia/Shanghai」写成「Shanghai」，窄屏上一行放得下。
    const city = zone.split('/').pop().replace(/_/g, ' ');
    return city ? `${city} · ${offset}` : offset;
}

const STYLE = `
#${ROOT_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100dvh; z-index: 10030; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  --u-ink: var(--sd-text, #ececf1); --u-mute: var(--sd-muted, #9a9aa6); --u-bg: var(--sd-window-bg, #0f0f12); --u-card: var(--sd-card, #1b1b20); --u-line: var(--sd-border, #2c2c34); --u-accent: var(--sd-accent, #ff5c7a); }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .qm-usage-backdrop { position: absolute; inset: 0; background: #0008; animation: qm-usage-fade .25s both; }
#${ROOT_ID} .qm-usage-panel { position: relative; width: min(430px, 100%); max-height: min(780px, calc(100dvh - 32px)); overflow: auto; overscroll-behavior: contain; scrollbar-width: none; padding: 14px; border-radius: 26px; background: var(--u-bg); color: var(--u-ink); border: 1px solid var(--u-line); box-shadow: 0 24px 70px #0007; font-size: 14px; container-type: inline-size; animation: qm-usage-rise .36s cubic-bezier(.2,.8,.2,1) both; }
/* 经典主题的窗体底色是半透明的：垫一层随日夜变的底再加毛玻璃，后面的聊天才不会透上来妨碍阅读。（这个底色本身是一段渐变，只能直接叠，不能再套进别的渐变里。）
   酒馆关了模糊效果时（手机上默认如此）毛玻璃不生效，那层底就换成不透的。 */
#${ROOT_ID}:not([data-qm-theme]) { --u-base: #15151a; }
#${ROOT_ID}:not([data-qm-theme]).sd-theme-light { --u-base: #f2f2f5; }
#${ROOT_ID}:not([data-qm-theme]) .qm-usage-panel { background: var(--u-bg), color-mix(in srgb, var(--u-base) 72%, transparent); backdrop-filter: blur(26px) saturate(1.25); -webkit-backdrop-filter: blur(26px) saturate(1.25); }
body.no-blur #${ROOT_ID}:not([data-qm-theme]) .qm-usage-panel { background: var(--u-bg), var(--u-base); }
@keyframes qm-usage-fade { from { opacity: 0; } }
@keyframes qm-usage-rise { from { opacity: 0; transform: translateY(14px) scale(.98); } }
#${ROOT_ID} header { display: flex; align-items: center; gap: 8px; padding: 2px 4px 12px; }
#${ROOT_ID} header h3 { margin: 0; flex: 1; font-size: 17px; font-weight: 600; letter-spacing: .12em; }
#${ROOT_ID} button { all: unset; cursor: pointer; box-sizing: border-box; }
#${ROOT_ID} button:focus-visible, #${ROOT_ID} input:focus-visible { outline: 2px solid var(--u-accent); outline-offset: 2px; }
#${ROOT_ID} .qm-usage-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%; color: var(--u-mute); font-size: 18px; }
#${ROOT_ID} .qm-usage-icon:hover { color: var(--u-ink); }
/* ---- 热力格 ---- */
#${ROOT_ID} .qm-usage-heat { position: relative; padding: 16px 16px 12px; border-radius: 22px; background: linear-gradient(color-mix(in srgb, var(--u-accent) 22%, var(--u-card)), color-mix(in srgb, var(--u-accent) 9%, var(--u-card))); }
#${ROOT_ID} .qm-usage-grid { display: grid; grid-template-columns: 14px repeat(var(--weeks), minmax(0, 1fr)); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: clamp(1px, calc(60px / var(--weeks)), 4px); align-items: center; }
#${ROOT_ID} .qm-usage-grid b { font-weight: 500; font-size: 10px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-grid i { position: relative; aspect-ratio: 1; border-radius: 28%; background: color-mix(in srgb, var(--u-ink) 9%, transparent); cursor: pointer; transition: transform .25s cubic-bezier(.3,1.7,.5,1), filter .25s;
  animation: qm-usage-pop .5s cubic-bezier(.3,1.5,.5,1) both; animation-delay: calc(var(--c) * 22ms + var(--r) * 14ms); }
@keyframes qm-usage-pop { from { opacity: 0; transform: scale(.2); } }
#${ROOT_ID} .qm-usage-grid i[data-level="-1"] { visibility: hidden; }
#${ROOT_ID} .qm-usage-grid i[data-level="1"] { background: color-mix(in srgb, var(--u-accent) 30%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="2"] { background: color-mix(in srgb, var(--u-accent) 52%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="3"] { background: color-mix(in srgb, var(--u-accent) 76%, transparent); }
#${ROOT_ID} .qm-usage-grid i[data-level="4"] { background: var(--u-accent); box-shadow: 0 0 8px color-mix(in srgb, var(--u-accent) 60%, transparent); }
#${ROOT_ID} .qm-usage-grid i:hover, #${ROOT_ID} .qm-usage-grid i.on { transform: scale(1.45); filter: brightness(1.2); z-index: 2; }
/* 今天这一格在呼吸 */
#${ROOT_ID} .qm-usage-grid i[data-today]::after { content: ''; position: absolute; inset: -3px; border-radius: inherit; border: 1.5px solid var(--u-accent); animation: qm-usage-breathe 2.4s ease-in-out infinite; }
@keyframes qm-usage-breathe { 0%, 100% { opacity: .25; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.12); } }
#${ROOT_ID} .qm-usage-range { display: flex; align-items: center; gap: clamp(4px, 1.6cqw, 8px); margin-top: 12px; }
/* 日期区间本身就是「自选范围」的开关：点一下展开两个日期框，再点收起。 */
#${ROOT_ID} .qm-usage-range > .qm-usage-span { flex: 1; min-width: 0; height: 28px; line-height: 28px; text-align: center; white-space: nowrap; font-size: clamp(9px, 3.6cqw, 13.5px); font-variant-numeric: tabular-nums; border-radius: 999px; transition: background .2s; }
#${ROOT_ID} .qm-usage-range > .qm-usage-span:hover, #${ROOT_ID} .qm-usage-range > .qm-usage-span[aria-expanded="true"] { background: color-mix(in srgb, var(--u-ink) 9%, transparent); }
#${ROOT_ID} .qm-usage-range button[data-usage-shift] { flex: none; min-width: clamp(26px, 8cqw, 34px); height: 28px; padding: 0 clamp(5px, 2cqw, 9px); display: grid; place-items: center; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--u-ink) 22%, transparent); font-size: 12px; }
#${ROOT_ID} .qm-usage-range button[disabled] { opacity: .3; cursor: default; }
#${ROOT_ID} .qm-usage-pick { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-pick input { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--u-ink) 22%, transparent); background: transparent; color: var(--u-ink); font: inherit; font-size: 12px; color-scheme: inherit; }
/* ---- 最近聊过的那位 ---- */
#${ROOT_ID} .qm-usage-last { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; width: 100%; margin-top: 10px; padding: 12px 14px; border-radius: 22px; background: var(--u-card); box-shadow: inset 0 0 26px color-mix(in srgb, var(--u-accent) 10%, transparent), inset 0 1px 0 color-mix(in srgb, var(--u-ink) 8%, transparent); transition: box-shadow .3s, transform .2s; }
#${ROOT_ID} .qm-usage-last:hover { box-shadow: inset 0 0 34px color-mix(in srgb, var(--u-accent) 22%, transparent), inset 0 1px 0 color-mix(in srgb, var(--u-ink) 12%, transparent); }
#${ROOT_ID} .qm-usage-last:active { transform: scale(.985); }
#${ROOT_ID} .qm-usage-last .qm-usage-face { grid-row: 1 / span 2; }
#${ROOT_ID} .qm-usage-last strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .qm-usage-last small { grid-column: 2; font-size: 12px; color: var(--u-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .qm-usage-last em { grid-row: 1 / span 2; grid-column: 3; font-style: normal; color: var(--u-accent); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-face { position: relative; width: 46px; height: 46px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; background: color-mix(in srgb, var(--u-accent) 22%, var(--u-card)); color: var(--u-accent); font-size: 18px; }
#${ROOT_ID} .qm-usage-face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* ---- 计数格：微微内发光 ---- */
#${ROOT_ID} .qm-usage-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
#${ROOT_ID} .qm-usage-card { position: relative; display: flex; flex-direction: column; min-width: 0; height: 112px; padding: 13px 15px; border-radius: 22px; background: var(--u-card); overflow: hidden;
  box-shadow: inset 0 0 28px color-mix(in srgb, var(--u-accent) 12%, transparent), inset 0 1px 0 color-mix(in srgb, var(--u-ink) 8%, transparent); transition: box-shadow .35s, transform .25s; animation: qm-usage-rise .5s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--n) * 45ms + 120ms); }
#${ROOT_ID} .qm-usage-card::before { content: ''; position: absolute; left: -30%; top: -60%; width: 90%; height: 120%; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--u-accent) 16%, transparent), transparent); opacity: .7; transition: transform .6s cubic-bezier(.2,.8,.2,1), opacity .4s; pointer-events: none; }
#${ROOT_ID} .qm-usage-card:hover, #${ROOT_ID} .qm-usage-card:active { box-shadow: inset 0 0 40px color-mix(in srgb, var(--u-accent) 26%, transparent), inset 0 1px 0 color-mix(in srgb, var(--u-ink) 14%, transparent); transform: translateY(-2px); }
#${ROOT_ID} .qm-usage-card:hover::before, #${ROOT_ID} .qm-usage-card:active::before { transform: translate(55%, 45%); opacity: 1; }
#${ROOT_ID} .qm-usage-card em { position: relative; font-style: normal; font-size: clamp(10px, 3.6cqw, 13px); color: var(--u-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .qm-usage-card strong { position: relative; margin: auto 0; display: flex; align-items: baseline; gap: 5px; white-space: nowrap; font-size: clamp(22px, 8.4cqw, 38px); line-height: 1; font-weight: 700; color: var(--u-accent); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-card strong i { font-style: normal; }
#${ROOT_ID} .qm-usage-card strong span { font-size: 12px; font-weight: 500; letter-spacing: .06em; opacity: .85; }
#${ROOT_ID} .qm-usage-card small { position: relative; font-size: clamp(9.5px, 3.3cqw, 11.5px); color: var(--u-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .qm-usage-card small b { font-weight: 500; color: var(--u-ink); }
/* 时区：点这行小字换。原生下拉透明地盖在字上，点到的就是它。 */
#${ROOT_ID} .qm-usage-zone { position: relative; display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; text-decoration: underline dotted; text-underline-offset: 3px; cursor: pointer; }
#${ROOT_ID} .qm-usage-zone select { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; font: inherit; font-size: 16px; }
/* ---- 常客名单 ---- */
#${ROOT_ID} .qm-usage-bar { height: 5px; border-radius: 999px; background: color-mix(in srgb, var(--u-ink) 12%, transparent); overflow: hidden; }
#${ROOT_ID} .qm-usage-bar > span { display: block; height: 100%; width: var(--p, 0%); border-radius: inherit; background: var(--u-accent); transform-origin: left; animation: qm-usage-grow .8s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--n, 0) * 60ms + 150ms); }
@keyframes qm-usage-grow { from { transform: scaleX(0); } }
#${ROOT_ID} .qm-usage-char { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 4px 12px; align-items: center; padding: 12px 6px; border-top: 1px solid color-mix(in srgb, var(--u-line) 70%, transparent); animation: qm-usage-rise .45s both; animation-delay: calc(var(--n) * 50ms); }
#${ROOT_ID} .qm-usage-char:first-of-type { border-top: 0; }
#${ROOT_ID} .qm-usage-char .qm-usage-face { grid-row: 1 / span 3; }
#${ROOT_ID} .qm-usage-char .who { display: flex; justify-content: space-between; gap: 10px; }
#${ROOT_ID} .qm-usage-char .who span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .qm-usage-char .who span:last-child { flex: none; color: var(--u-accent); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-char small { font-size: 12px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-empty { margin: 0; padding: 40px 10px; text-align: center; color: var(--u-mute); }
#${ROOT_ID} [hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} * { animation: none !important; transition: none !important; } }
/* 纸间：一页书。直角、文武线、界行；数字是朱砂，不发光。 */
#${ROOT_ID}[data-qm-theme="editorial"] { --u-ink: var(--qm-ink); --u-mute: var(--qm-muted); --u-bg: var(--qm-bg); --u-card: transparent; --u-line: color-mix(in srgb, var(--qm-ink) 18%, transparent); --u-accent: var(--qm-accent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-panel { border-radius: 0; border: 2px solid var(--u-ink); outline: 1px solid color-mix(in srgb, var(--u-ink) 70%, transparent); outline-offset: -6px; padding: 20px; font-family: var(--qm-editorial-font, serif); }
#${ROOT_ID}[data-qm-theme="editorial"] header { border-bottom: 1px solid var(--u-ink); margin-bottom: 14px; }
#${ROOT_ID}[data-qm-theme="editorial"] header h3 { color: var(--u-accent); font-weight: 400; letter-spacing: .3em; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-heat { background: none; border-radius: 0; padding: 4px 2px 12px; border-bottom: 1px solid var(--u-line); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i { border-radius: 0; background: transparent; outline: 1px solid color-mix(in srgb, var(--u-ink) 14%, transparent); outline-offset: -1px; box-shadow: none; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i[data-level="1"] { background: color-mix(in srgb, var(--u-accent) 30%, transparent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i[data-level="2"] { background: color-mix(in srgb, var(--u-accent) 52%, transparent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i[data-level="3"] { background: color-mix(in srgb, var(--u-accent) 76%, transparent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i[data-level="4"] { background: var(--u-accent); }
#${ROOT_ID}[data-qm-theme="editorial"] :is(.qm-usage-range button, .qm-usage-icon, .qm-usage-pick input, .qm-usage-bar, .qm-usage-face, .qm-usage-grid i::after) { border-radius: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-last { border-radius: 0; box-shadow: none; margin-top: 0; padding-inline: 8px; border-bottom: 1px solid var(--u-ink); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-last:hover { background: color-mix(in srgb, var(--u-accent) 8%, transparent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-cards { gap: 0; margin-top: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card { border-radius: 0; box-shadow: none; border-bottom: 1px solid var(--u-line); height: 100px; padding: 12px 10px; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card::before { display: none; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card:hover { transform: none; background: color-mix(in srgb, var(--u-accent) 7%, transparent); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card:nth-child(odd) { border-right: 1px solid var(--u-line); }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-card strong { font-weight: 400; }
#${ROOT_ID}[data-qm-theme="glass"] :is(.qm-usage-panel, .qm-usage-card, .qm-usage-last) { backdrop-filter: blur(22px) saturate(1.12); -webkit-backdrop-filter: blur(22px) saturate(1.12); }
`;

/** 可选的时区：浏览器认识的全部；老浏览器给不出清单时只留几个常用的。 */
let zoneNames = null;
export function timeZones() {
    if (zoneNames) return zoneNames;
    try { zoneNames = Intl.supportedValuesOf('timeZone'); } catch { zoneNames = null; }
    if (!zoneNames?.length) zoneNames = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/Moscow', 'Europe/Berlin', 'Europe/Paris', 'Europe/London', 'UTC', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'Australia/Sydney', 'Pacific/Auckland'];
    return zoneNames;
}
const face = (item, avatarUrl) => `<span class="qm-usage-face"><span>${esc(Array.from(item.name || '？')[0])}</span><img alt="" loading="lazy" src="${esc(item.avatar || avatarUrl(item.key))}" hidden></span>`;
const nameOf = item => item.name || item.key.replace(/\.[^.]+$/, '');
const big = ms => { const { value, unit } = compactTime(ms); return `<i data-count="${esc(value)}">${esc(value)}</i><span>${unit}</span>`; };

/** range：{ from, to, custom }；custom 为真时显示两个日期框。drink：这次打开抽到的酒名。 */
export function usageMarkup(data, { now: real = Date.now(), range = null, page = 'home', drink = DRINKS[0], zones = timeZones(), avatarUrl = key => `/thumbnail?type=avatar&file=${encodeURIComponent(key)}` } = {}) {
    // 按所选时区的钟面来看：今天是哪天、几点聊的，都以它为准。
    const picked = typeof data?.zone === 'string' ? data.zone : '', wall = at => at + zoneShift(at, picked), now = wall(real);
    const summary = usageSummary(data, now);
    if (page === 'chars') {
        const rows = summary.chars.length ? summary.chars.map((item, index) => `<article class="qm-usage-char" style="--n:${index}">${face(item, avatarUrl)}
        <div class="who"><span>${esc(nameOf(item))}</span><span>${esc(durationText(item.ms))}</span></div>
        <div class="qm-usage-bar"><span style="--p:${summary.top ? Math.max(2, Math.round(item.ms / summary.top * 100)) : 0}%;--n:${index}"></span></div>
        <small>最后一次聊天：${esc(lastChatText(item.last ? wall(item.last) : 0, now))}</small></article>`).join('') : '<p class="qm-usage-empty">还没有和谁聊过。</p>';
        return `<header><button type="button" class="qm-usage-icon" data-usage-page="home" aria-label="返回">‹</button><h3>常客</h3><button type="button" class="qm-usage-icon" data-usage-close aria-label="关闭">✕</button></header>${rows}`;
    }
    const span = range || { ...quarterRange(now), custom: false }, heat = heatCells(data, span.from, span.to, now);
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const cells = heat.cells.map(cell => `<i data-level="${cell.level}" style="--c:${cell.column};--r:${cell.row}"${cell.today ? ' data-today' : ''}${cell.ms === null ? '' : ` title="${md(cell.time)} · ${cell.ms ? esc(durationText(cell.ms)) : '没喝'}"`}></i>`).join('');
    const earlier = summary.firstDay && summary.firstDay < heat.from, later = quarterRange(now).to > heat.to;
    const recent = summary.recent;
    const card = (index, title, body, small = '') => `<section class="qm-usage-card" style="--n:${index}"><em>${title}</em><strong>${body}</strong>${small ? `<small>${small}</small>` : ''}</section>`;
    const peakWord = summary.peak === null ? '' : summary.peak < 6 ? '深夜' : summary.peak < 12 ? '上午' : summary.peak < 18 ? '下午' : '夜里';
    return `<header><h3>微醺记录</h3><button type="button" class="qm-usage-icon" data-usage-close aria-label="关闭">✕</button></header>
      <section class="qm-usage-heat"><div class="qm-usage-grid" style="--weeks:${heat.weeks}">${labels.map(name => `<b>${name}</b>`).join('')}${cells}</div>
        <div class="qm-usage-range"><button type="button" data-usage-shift="-1" aria-label="往前"${!span.custom && !earlier ? ' disabled' : ''}>‹</button><button type="button" class="qm-usage-span" data-usage-custom aria-label="自选范围" aria-expanded="${span.custom ? 'true' : 'false'}">${dotted(heat.from)} — ${dotted(heat.to)}</button><button type="button" data-usage-shift="1" aria-label="往后"${!span.custom && !later ? ' disabled' : ''}>›</button></div>
        <div class="qm-usage-pick"${span.custom ? '' : ' hidden'}><input type="date" data-usage-from aria-label="开始日期" value="${dayKey(heat.from)}"><span>至</span><input type="date" data-usage-to aria-label="结束日期" value="${dayKey(heat.to)}"></div></section>
      ${recent ? `<button type="button" class="qm-usage-last" data-usage-page="chars" aria-label="常客名单">${face(recent, avatarUrl)}<strong>${esc(nameOf(recent))}</strong><em>${esc(durationText(recent.ms))} ›</em><small>${esc(recent.last ? `${lastChatText(wall(recent.last), now)} 聊过` : lastChatText(0, now))}</small></button>` : ''}
      <div class="qm-usage-cards">
        ${card(0, '今日', big(summary.today))}
        ${card(1, '本周', big(summary.week))}
        ${card(2, '本月', big(summary.month))}
        ${card(3, '今年', big(summary.year))}
        ${card(4, '累计', big(summary.all))}
        ${card(5, '连续', `<i data-count="${summary.streak}">${summary.streak}</i><span>days</span>`, `最长 <b>${summary.longest} 天</b>`)}
        ${card(6, `今日来杯 ${esc(drink)}`, `<i data-count="${summary.activeDays}">${summary.activeDays}</i><span>days</span>`, summary.since ? `始于 <b>${md(wall(summary.since))}</b>` : '今天开始记')}
        ${card(7, '最常在', summary.peak === null ? '—' : `<span>${peakWord}</span><i>${pad(summary.peak)}:00</i>`, `<span class="qm-usage-zone">${esc(timeZoneText(new Date(real), picked))}<select data-usage-zone aria-label="时区"><option value=""${picked ? '' : ' selected'}>跟随系统</option>${zones.map(name => `<option value="${esc(name)}"${name === picked ? ' selected' : ''}>${esc(name.replace(/_/g, ' '))}</option>`).join('')}</select></span>`)}
      </div>`;
}

/** 打开面板。mount：把根节点交给主题系统（跟随千幕当前主题）。返回关闭函数。 */
export function openUsagePanel({ document = globalThis.document, getData = () => null, setZone = () => {}, themeClass = '', mount = () => {}, now: clock = () => Date.now(), random = Math.random } = {}) {
    document.getElementById(ROOT_ID)?.remove();
    const view = document.defaultView || globalThis;
    let style = document.getElementById(`${ROOT_ID}-style`);
    if (!style) { style = document.createElement('style'); style.id = `${ROOT_ID}-style`; document.head.append(style); }
    if (style.textContent !== STYLE) style.textContent = STYLE;
    const root = document.createElement('div'); root.id = ROOT_ID; if (themeClass) root.className = themeClass;
    root.innerHTML = '<div class="qm-usage-backdrop"></div><section class="qm-usage-panel" role="dialog" aria-modal="true" aria-label="微醺记录"></section>';
    const panel = root.querySelector('.qm-usage-panel'), drink = DRINKS[Math.floor(random() * DRINKS.length) % DRINKS.length];
    let page = 'home', range = null, quarter = 0;
    // 翻页与自选都按所选时区的「今天」来算。
    const now = () => { const at = clock(), zone = getData()?.zone; return at + zoneShift(at, typeof zone === 'string' ? zone : ''); };
    const close = () => { document.removeEventListener('keydown', onKey, true); root.remove(); };
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    // 数字从 0 数上来（只数整数；带小数的直接显示）。
    const countUp = () => {
        if (view.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof view.requestAnimationFrame !== 'function') return;
        for (const node of panel.querySelectorAll('[data-count]')) {
            const target = Number(node.dataset.count); if (!Number.isInteger(target) || target < 2) continue;
            const began = view.performance.now(), run = at => { const t = Math.min(1, (at - began) / 700), eased = 1 - (1 - t) ** 3; node.textContent = String(Math.round(target * eased)); if (t < 1 && node.isConnected) view.requestAnimationFrame(run); };
            node.textContent = '0'; view.requestAnimationFrame(run);
        }
    };
    const paint = ({ animate = true } = {}) => {
        panel.innerHTML = usageMarkup(getData(), { now: clock(), range, page, drink });
        // 头像取得到才显示；取不到（角色已删）就留着名字的第一个字。
        for (const image of panel.querySelectorAll('.qm-usage-face img')) { const show = () => { image.hidden = false; }; image.addEventListener('load', show); if (image.complete && image.naturalWidth) show(); }
        panel.scrollTop = 0; if (animate) countUp();
    };
    root.addEventListener('click', event => {
        event.stopPropagation();
        const hit = event.target.closest?.('button, .qm-usage-backdrop');
        if (!hit) return;
        if (hit.matches('.qm-usage-backdrop') || hit.hasAttribute('data-usage-close')) return close();
        if (hit.dataset.usagePage) { page = hit.dataset.usagePage; paint(); }
        else if (hit.hasAttribute('data-usage-custom')) {
            if (range?.custom) { range = null; quarter = 0; } else range = { ...(range || quarterRange(now(), quarter)), custom: true };
            paint({ animate: false });
        } else if (hit.dataset.usageShift && !hit.disabled) {
            const step = Number(hit.dataset.usageShift);
            if (range?.custom) { const span = range.to - range.from + 86400000; range = { from: range.from + step * span, to: range.to + step * span, custom: true }; }
            else { quarter += step; range = quarter ? { ...quarterRange(now(), quarter), custom: false } : null; }
            paint({ animate: false });
        }
    });
    root.addEventListener('change', event => {
        const zone = event.target.closest?.('[data-usage-zone]');
        if (zone) { setZone(zone.value); range = null; quarter = 0; paint({ animate: false }); return; }
        const input = event.target.closest?.('[data-usage-from], [data-usage-to]'); if (!input) return;
        const read = selector => { const value = panel.querySelector(selector)?.value; const time = value ? new Date(`${value}T00:00:00`).getTime() : NaN; return Number.isFinite(time) ? time : null; };
        let from = read('[data-usage-from]'), to = read('[data-usage-to]'); if (from === null || to === null) return;
        if (to < from) [from, to] = [to, from];
        to = Math.min(to, from + 731 * 86400000); // 最多两年：再长格子就小得看不清了
        range = { from, to, custom: true }; paint({ animate: false });
    });
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'touchstart']) root.addEventListener(name, event => event.stopPropagation());
    document.addEventListener('keydown', onKey, true);
    document.body.append(root); mount(root); paint();
    return close;
}
