// 「微醺记录」面板：现实里在酒馆待了多久。上面一张热力格（一列一周，越深待得越久），紧跟着最近聊过的那位（点进去是常客名单），
// 下面是一格一格的计数。经典与极简是微微内发光的卡片；纸间是书页式（界行、朱砂）。颜色全取当前主题的变量，不自带配色。
import { usageSummary, heatCells, quarterRange, compactTime, durationText, dayKey, zoneShift, normalizeUsage, tokenSummary, tokenTotals, compactTokens, tokenText } from './qianmu-usage-tracker.js?v=1.59.631';

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
/* 时长 / token：标题旁一对小胶囊。 */
#${ROOT_ID} .qm-usage-mode { display: flex; flex: none; padding: 2px; border-radius: 999px; background: color-mix(in srgb, var(--u-ink) 8%, transparent); }
#${ROOT_ID} .qm-usage-mode button { height: 24px; padding: 0 10px; line-height: 24px; border-radius: 999px; font-size: 12px; color: var(--u-mute); transition: background .2s, color .2s; }
#${ROOT_ID} .qm-usage-mode button:hover { color: var(--u-ink); }
#${ROOT_ID} .qm-usage-mode button[aria-pressed="true"] { background: var(--u-card); color: var(--u-accent); box-shadow: 0 1px 3px color-mix(in srgb, #000 22%, transparent); }
/* ---- 热力格 ---- */
#${ROOT_ID} .qm-usage-heat { position: relative; padding: 16px 16px 12px; border-radius: 22px; background: linear-gradient(color-mix(in srgb, var(--u-accent) 22%, var(--u-card)), color-mix(in srgb, var(--u-accent) 9%, var(--u-card))); }
#${ROOT_ID} .qm-usage-grid { display: grid; grid-template-columns: 14px repeat(var(--weeks), minmax(0, 1fr)); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: clamp(1px, calc(60px / var(--weeks)), 4px); align-items: center; }
#${ROOT_ID} .qm-usage-grid b { font-weight: 500; font-size: 10px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-grid i { position: relative; aspect-ratio: 1; border-radius: 28%; background: color-mix(in srgb, var(--u-ink) 9%, transparent); cursor: pointer; transition: filter .25s;
  animation: qm-usage-pop .5s cubic-bezier(.3,1.5,.5,1) both; animation-delay: calc(var(--c) * 22ms + var(--r) * 14ms); }
@keyframes qm-usage-pop { from { opacity: 0; transform: scale(.2); } }
#${ROOT_ID} .qm-usage-grid i[data-level="-1"] { visibility: hidden; }
#${ROOT_ID} :is(.qm-usage-grid, .qm-usage-day) i[data-level="1"] { background: color-mix(in srgb, var(--u-accent) 30%, transparent); }
#${ROOT_ID} :is(.qm-usage-grid, .qm-usage-day) i[data-level="2"] { background: color-mix(in srgb, var(--u-accent) 52%, transparent); }
#${ROOT_ID} :is(.qm-usage-grid, .qm-usage-day) i[data-level="3"] { background: color-mix(in srgb, var(--u-accent) 76%, transparent); }
#${ROOT_ID} :is(.qm-usage-grid, .qm-usage-day) i[data-level="4"] { background: var(--u-accent); box-shadow: 0 0 8px color-mix(in srgb, var(--u-accent) 60%, transparent); }
/* 悬停与点中：弹一下（放大再缩回），不停在放大的样子。弹动叠在入场动画后面，名字不同、互不重播；点中的那格靠一圈描边认出来。 */
#${ROOT_ID} .qm-usage-grid i:is(:hover, .on) { z-index: 2; animation: qm-usage-pop .5s cubic-bezier(.3,1.5,.5,1) both, qm-usage-tap .42s cubic-bezier(.3,1.4,.5,1); animation-delay: calc(var(--c) * 22ms + var(--r) * 14ms), 0s; }
@keyframes qm-usage-tap { 0%, 100% { scale: 1; } 40% { scale: 1.5; } }
#${ROOT_ID} .qm-usage-grid i.on { filter: brightness(1.15); outline: 1.5px solid var(--u-ink); outline-offset: 1px; }
/* 点中的那一天：格子下面一行写着日期和时长（触屏没有悬停，靠这一行看）。 */
#${ROOT_ID} .qm-usage-day { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 18px; margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--u-mute); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-day i { flex: none; width: 9px; height: 9px; border-radius: 28%; background: color-mix(in srgb, var(--u-ink) 9%, transparent); }
#${ROOT_ID} .qm-usage-day b { font-weight: 600; color: var(--u-ink); }
#${ROOT_ID} .qm-usage-day.is-swap { animation: qm-usage-day-in .35s ease both; }
@keyframes qm-usage-day-in { from { opacity: 0; transform: translateY(3px); } }
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
/* ---- 宿缘：按时长或按楼层排的名单 ---- */
#${ROOT_ID} .qm-usage-bar { height: 5px; border-radius: 999px; background: color-mix(in srgb, var(--u-ink) 12%, transparent); overflow: hidden; }
#${ROOT_ID} .qm-usage-bar > span { display: block; height: 100%; width: var(--p, 0%); border-radius: inherit; background: var(--u-accent); transform-origin: left; animation: qm-usage-grow .8s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--n, 0) * 60ms + 150ms); }
@keyframes qm-usage-grow { from { transform: scaleX(0); } }
#${ROOT_ID} .qm-usage-char { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 4px 12px; align-items: center; padding: 12px 6px; border-top: 1px solid color-mix(in srgb, var(--u-line) 70%, transparent); animation: qm-usage-rise .45s both; animation-delay: calc(var(--n) * 50ms); }
#${ROOT_ID} .qm-usage-char:first-of-type { border-top: 0; }
#${ROOT_ID} .qm-usage-char { position: relative; }
/* 第一位：名字与头像圈用强调色。 */
#${ROOT_ID} { --u-fate: color-mix(in srgb, #e3364e 84%, var(--u-accent)); --u-fate-pale: color-mix(in srgb, var(--u-fate) 50%, #fff); --u-fate-deep: color-mix(in srgb, var(--u-fate) 74%, #2a0008); }
/* 第一位：名字用强调色，头像外一根细线。 */
#${ROOT_ID} .qm-usage-char.is-top .who span:first-child { color: var(--u-accent); font-weight: 600; }
#${ROOT_ID} .qm-usage-char.is-top .qm-usage-face { box-shadow: 0 0 0 2px var(--u-bg-solid, var(--u-card)), 0 0 0 2.7px var(--u-accent); }
/* 两种排法的第一位是同一位：换成红线的颜色；进度条是红色一色、由浅入深。 */
#${ROOT_ID} .qm-usage-char.is-fated .who span { color: var(--u-fate-deep); font-weight: 600; }
#${ROOT_ID} .qm-usage-char.is-fated .qm-usage-face { box-shadow: 0 0 0 2px var(--u-bg-solid, var(--u-card)), 0 0 0 2.7px color-mix(in srgb, var(--u-fate) 82%, transparent); }
#${ROOT_ID} .qm-usage-char.is-fated .qm-usage-bar > span { background: linear-gradient(90deg, var(--u-fate-pale), var(--u-fate-deep)); }
/* 红线：一笔有粗细的飘带，浮在这一行之上。从面板左缘出来，掠过头像下沿，打一个小卷，沿进度条向右去；由浅入深。 */
#${ROOT_ID} .qm-usage-thread { position: absolute; inset: 0; z-index: 2; pointer-events: none; transition: transform .6s cubic-bezier(.2,.7,.2,1); }
#${ROOT_ID} .qm-usage-thread svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; animation: qm-usage-thread-sway 8s ease-in-out infinite alternate; }
@keyframes qm-usage-thread-sway { from { translate: -1.4px .7px; } to { translate: 1.6px -.9px; } }
#${ROOT_ID} .qm-usage-silk { filter: drop-shadow(0 3px 2.5px color-mix(in srgb, var(--u-fate-deep) 30%, transparent)); }
#${ROOT_ID} .qm-usage-reveal { fill: none; stroke: #fff; stroke-width: 9; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: qm-usage-thread-draw 4.4s cubic-bezier(.5,.05,.25,1) .4s forwards; }
@keyframes qm-usage-thread-draw { to { stroke-dashoffset: 0; } }
/* 光点：大小不一，散在线的上下，各自缓缓地浮、缓缓地明暗。 */
#${ROOT_ID} .qm-usage-mote { fill: #fff; opacity: 0; filter: drop-shadow(0 0 2px var(--u-fate)) drop-shadow(0 0 5px color-mix(in srgb, var(--u-fate) 70%, transparent)); animation: qm-usage-mote-in 2.4s ease var(--delay) forwards, qm-usage-mote-float var(--dur) cubic-bezier(.45,0,.55,1) var(--delay) infinite alternate; }
@keyframes qm-usage-mote-in { to { opacity: var(--o); } }
@keyframes qm-usage-mote-float { from { translate: 0 calc(var(--dy) * -1); scale: .8; } to { translate: var(--dx) var(--dy); scale: 1.1; } }
/* 莫比乌斯环：单线，在头像框左上角。像写一个横着的 8，从无到有一笔写出，停一停，淡去，再写。 */
#${ROOT_ID} .qm-usage-mobius { position: absolute; left: -5px; top: 6.5px; z-index: 3; width: 26px; height: 15px; overflow: visible; pointer-events: none; filter: drop-shadow(0 0 2.5px color-mix(in srgb, var(--u-fate) 60%, transparent)); }
#${ROOT_ID} .qm-usage-mobius path { fill: none; stroke: var(--u-fate); stroke-width: 1; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: qm-usage-mobius-write 6.5s cubic-bezier(.5,.05,.3,1) .8s infinite; }
@keyframes qm-usage-mobius-write { 0% { stroke-dashoffset: 1; opacity: 1; } 55% { stroke-dashoffset: 0; opacity: 1; } 82% { stroke-dashoffset: 0; opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
#${ROOT_ID} .qm-usage-char .qm-usage-face { grid-row: 1 / span 3; }
#${ROOT_ID} .qm-usage-char .who { display: flex; justify-content: space-between; gap: 10px; }
#${ROOT_ID} .qm-usage-char .who span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${ROOT_ID} .qm-usage-char .who span:last-child { flex: none; color: var(--u-accent); font-variant-numeric: tabular-nums; }
#${ROOT_ID} .qm-usage-char small { font-size: 12px; color: var(--u-mute); }
#${ROOT_ID} .qm-usage-empty { margin: 0; padding: 40px 10px; text-align: center; color: var(--u-mute); }
#${ROOT_ID} [hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} * { animation: none !important; transition: none !important; } #${ROOT_ID} :is(.qm-usage-reveal, .qm-usage-mobius path) { stroke-dashoffset: 0; } #${ROOT_ID} .qm-usage-mote { opacity: var(--o); } }
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
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-grid i.on { outline: 1.5px solid var(--u-ink); outline-offset: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-mode { border-radius: 0; background: none; padding: 0; gap: 6px; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-mode button { border-radius: 0; padding: 0 2px; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-mode button[aria-pressed="true"] { background: none; box-shadow: inset 0 -1px 0 var(--u-accent); }
#${ROOT_ID}[data-qm-theme="editorial"] :is(.qm-usage-range button, .qm-usage-icon, .qm-usage-pick input, .qm-usage-bar, .qm-usage-face, .qm-usage-grid i::after) { border-radius: 0; }
#${ROOT_ID}[data-qm-theme="editorial"] .qm-usage-mobius { left: -8px; top: 3px; }
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
// ---- 红线 ----
// 只有「相处最久」与「聊得最多」是同一位时才出现。线的形状要按这一行实际的尺寸来画，所以名单画好之后才量、才画（drawThread）。
const fix = point => `${point[0].toFixed(2)},${point[1].toFixed(2)}`;
/** 莫比乌斯环：一个横着的 8，从交叉点起笔，先绕右圈、再绕左圈。 */
const MOBIUS = (() => {
    const points = [];
    for (let i = 0; i <= 96; i++) { const t = Math.PI / 2 - Math.PI * 2 * i / 96, d = 1 + Math.sin(t) ** 2; points.push([13 + 11.5 * Math.cos(t) / d, 7.5 - 13.5 * Math.sin(t) * Math.cos(t) / d]); }
    return `<svg class="qm-usage-mobius" viewBox="0 0 26 15" aria-hidden="true"><path pathLength="1" d="M${points.map(fix).join('L')}"/></svg>`;
})();
/** 过一串点的平滑曲线，密密取样。 */
function sampleCurve(points, steps = 16) {
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        for (let s = i ? 1 : 0; s <= steps; s++) { const t = s / steps, u = 1 - t; out.push([0, 1].map(k => u * u * u * p1[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p2[k])); }
    }
    return out;
}
/** 这一行的红线。尺寸都以这一行的左上角为原点：left／right 是面板的左右缘，face 是头像（圆心与半径），nameY／barY 是名字与进度条的中线。 */
export function threadMarkup({ left = 0, right = 320, face = { cx: 29, cy: 35, r: 23 }, nameY = 22, barY = 37 } = {}) {
    const span = right - left, bx = face.cx + face.r + 12; // 进度条的起点
    // 一个舒展的小卷：边绕边往右走
    const curl = Array.from({ length: 8 }, (_, i) => { const t = i / 7, u = (.1 + 1.8 * t) * Math.PI; return [bx + 34 + 20 * (t - .5) + 9.5 * Math.sin(u), barY - 1 + 8.5 * Math.cos(u)]; });
    const points = [[left - 12, face.cy + 24], [face.cx - face.r * .5, face.cy + 19], [face.cx + face.r * .7, face.cy + 12], [bx + 4, barY + 9], ...curl,
        [left + span * .54, barY - 8], [left + span * .76, barY + 6], [right - 34, barY - 5], [right + 12, Math.min(barY - 22, nameY - 6)]];
    const curve = sampleCurve(points), n = curve.length, upper = [], lower = [], widths = [], normals = [];
    // 像斜着的笔尖写出来的一笔：走向与笔尖垂直时粗，顺着笔尖时细；两头收成尖
    for (let i = 0; i < n; i++) {
        const a = curve[Math.max(0, i - 1)], b = curve[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
        normals.push([-dy / length, dx / length]);
        const pen = Math.abs(Math.sin(Math.atan2(dy, dx) + 38 * Math.PI / 180)) ** 1.5, t = i / (n - 1), tip = Math.min(1, t / .1, (1 - t) / .14);
        widths.push((.5 + 2.1 * pen) * tip * tip * (3 - 2 * tip));
    }
    for (let i = 0; i < n; i++) {
        let sum = 0, count = 0; for (let k = -6; k <= 6; k++) if (widths[i + k] !== undefined) { sum += widths[i + k]; count++; }
        const half = sum / count / 2, [x, y] = curve[i], [nx, ny] = normals[i];
        upper.push([x + nx * half, y + ny * half]); lower.push([x - nx * half, y - ny * half]);
    }
    // 光点：位置固定（每次打开都一样），大小、快慢各不相同
    let seed = 77, motes = ''; const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    for (let i = 0; i < 20; i++) {
        const at = Math.floor(10 + (n - 20) * (i + random() * .8) / 20), [x, y] = curve[at], [nx, ny] = normals[at], off = (random() < .5 ? -1 : 1) * (3 + random() * 12), big = random();
        motes += `<circle class="qm-usage-mote" cx="${(x + nx * off).toFixed(1)}" cy="${(y + ny * off).toFixed(1)}" r="${(.45 + big * big * 1.9).toFixed(2)}" style="--o:${(.45 + random() * .55).toFixed(2)};--delay:${(1 + at / n * 2.8 + random() * .8).toFixed(2)}s;--dur:${(5 + random() * 5).toFixed(1)}s;--dx:${((random() - .5) * 4).toFixed(1)}px;--dy:${(1.5 + random() * 3).toFixed(1)}px"/>`;
    }
    return `<svg aria-hidden="true"><defs><linearGradient id="qm-usage-silk-ink" gradientUnits="userSpaceOnUse" x1="${left.toFixed(1)}" y1="0" x2="${right.toFixed(1)}" y2="0"><stop offset="0" style="stop-color:var(--u-fate-pale)"/><stop offset=".22" style="stop-color:var(--u-fate-pale)"/><stop offset=".6" style="stop-color:var(--u-fate)"/><stop offset="1" style="stop-color:var(--u-fate-deep)"/></linearGradient>`
        + `<mask id="qm-usage-silk-mask" maskUnits="userSpaceOnUse" x="${(left - 40).toFixed(1)}" y="-60" width="${(span + 80).toFixed(1)}" height="240"><path class="qm-usage-reveal" pathLength="1" d="M${curve.map(fix).join('L')}"/></mask></defs>`
        + `<polygon class="qm-usage-silk" points="${[...upper, ...lower.reverse()].map(fix).join(' ')}" fill="url(#qm-usage-silk-ink)" mask="url(#qm-usage-silk-mask)"/>${motes}</svg>`;
}
/** 名单画好后：量出系红线那一行的尺寸，把线画进去。量不出来（环境不支持）就不画，名单照常。 */
function drawThread(panel) {
    const holder = panel.querySelector?.('.qm-usage-thread'), row = holder?.parentElement;
    if (!row || typeof row.getBoundingClientRect !== 'function') return;
    const box = row.getBoundingClientRect(), frame = panel.getBoundingClientRect(), middle = selector => { const rect = row.querySelector(selector)?.getBoundingClientRect(); return rect ? { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2, r: rect.width / 2 } : null; };
    const face = middle('.qm-usage-face'), name = middle('.who'), bar = middle('.qm-usage-bar');
    if (!face || !name || !bar || !(box.width > 0)) return;
    holder.innerHTML = threadMarkup({ left: frame.left - box.left, right: frame.right - box.left, face: { cx: face.x, cy: face.y, r: face.r }, nameY: name.y, barY: bar.y });
}
const ICON = body => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_TIME = ICON('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'), ICON_FLOORS = ICON('<path d="M12 4 3.5 8.5 12 13l8.5-4.5L12 4Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>');
const face = (item, avatarUrl) => `<span class="qm-usage-face"><span>${esc(Array.from(item.name || '？')[0])}</span><img alt="" loading="lazy" src="${esc(item.avatar || avatarUrl(item.key))}" hidden></span>`;
const nameOf = item => item.name || item.key.replace(/\.[^.]+$/, '');
const big = ms => { const { value, unit } = compactTime(ms); return `<i data-count="${esc(value)}">${esc(value)}</i><span>${unit}</span>`; };
const bigTokens = n => { const { value, unit } = compactTokens(n); return `<i data-count="${esc(value)}">${esc(value)}</i><span>${unit}</span>`; };
const splitText = item => `发出 ${tokenText(item?.sent)} · 收到 ${tokenText(item?.received)}`;
const modeSwitch = mode => `<div class="qm-usage-mode" role="group" aria-label="统计口径">${[['time', '时长'], ['tokens', 'token']].map(([id, label]) => `<button type="button" data-usage-mode="${id}" aria-pressed="${mode === id}">${label}</button>`).join('')}</div>`;

/** range：{ from, to, custom }；custom 为真时显示两个日期框。drink：这次打开抽到的酒名。mode：time 按时长，tokens 按正文聊天的 token。
 * floors：按楼层数排好的角色 [{ key, name, floors }]；rank：名单按时长（time）还是按楼层（floors）排。 */
export function usageMarkup(data, { now: real = Date.now(), range = null, page = 'home', mode = 'time', drink = DRINKS[0], zones = timeZones(), floors = [], rank = 'time', avatarUrl = key => `/characters/${String(key).split('/').map(encodeURIComponent).join('/')}` } = {}) {
    // 按所选时区的钟面来看：今天是哪天、几点聊的，都以它为准。
    const picked = typeof data?.zone === 'string' ? data.zone : '', wall = at => at + zoneShift(at, picked), now = wall(real);
    const tokens = mode === 'tokens';
    const summary = usageSummary(data, now);
    if (page === 'chars' && !tokens) {
        // 两种排法：相处的时长、聊过的楼层。各自的第一位高亮；两边第一是同一位时，那一位系上红线。
        const known = new Map(summary.chars.map(item => [item.key, item])), ranked = (Array.isArray(floors) ? floors : []).filter(item => item?.key && item.floors > 0);
        const mode = rank === 'floors' && ranked.length ? 'floors' : 'time';
        const timeTop = summary.chars[0]?.ms > 0 ? summary.chars[0].key : '', fated = timeTop && timeTop === ranked[0]?.key ? timeTop : '';
        const list = mode === 'floors' ? ranked.map(item => ({ key: item.key, ms: 0, last: 0, ...known.get(item.key), name: known.get(item.key)?.name || item.name, floors: item.floors })) : summary.chars;
        const most = mode === 'floors' ? ranked[0].floors : summary.top;
        const rows = list.length ? list.map((item, index) => { const value = mode === 'floors' ? item.floors : item.ms; return `<article class="qm-usage-char${index === 0 ? ' is-top' : ''}${item.key === fated ? ' is-fated' : ''}" style="--n:${index}">${item.key === fated ? `<span class="qm-usage-thread" aria-hidden="true"></span>${MOBIUS}` : ''}${face(item, avatarUrl)}
        <div class="who"><span>${esc(nameOf(item))}</span><span>${mode === 'floors' ? `${item.floors} 层` : esc(durationText(item.ms))}</span></div>
        <div class="qm-usage-bar"><span style="--p:${most ? Math.max(2, Math.round(value / most * 100)) : 0}%;--n:${index}"></span></div>
        <small>最后一次聊天：${esc(lastChatText(item.last ? wall(item.last) : 0, now))}</small></article>`; }).join('') : '<p class="qm-usage-empty">还没有和谁聊过。</p>';
        const toggle = ranked.length ? `<button type="button" class="qm-usage-icon" data-usage-rank="${mode === 'floors' ? 'time' : 'floors'}" aria-label="${mode === 'floors' ? '按时长排' : '按楼层排'}" title="${mode === 'floors' ? '按时长排' : '按楼层排'}">${mode === 'floors' ? ICON_TIME : ICON_FLOORS}</button>` : '';
        return `<header><button type="button" class="qm-usage-icon" data-usage-page="home" aria-label="返回">‹</button><h3>宿缘</h3>${toggle}<button type="button" class="qm-usage-icon" data-usage-close aria-label="关闭">✕</button></header>${rows}`;
    }
    const span = range || { ...quarterRange(now), custom: false }, heat = heatCells(data, span.from, span.to, now, tokens ? tokenTotals(data) : null);
    const ledger = tokens ? tokenSummary(data, now) : null, tokenDays = tokens ? normalizeUsage(data).tokens?.days || {} : null;
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    // 每一格带着自己那天的日期与时长（token 模式是那天发出与收到的数）；点一下，格子下面那一行就换成这一天。默认停在今天（今天不在范围里就空着）。
    const spentText = cell => !cell.ms ? '没喝' : tokens ? splitText(tokenDays[dayKey(cell.time)]) : durationText(cell.ms);
    const dayText = cell => `<i data-level="${cell.level}"></i><span>${md(cell.time)}</span><b>${esc(spentText(cell))}</b>`;
    const today = heat.cells.find(cell => cell.today && cell.ms !== null);
    const cells = heat.cells.map(cell => `<i data-level="${cell.level}" style="--c:${cell.column};--r:${cell.row}"${cell.today ? ' data-today' : ''}${cell.ms === null ? '' : ` title="${md(cell.time)} · ${esc(spentText(cell))}"`}${cell === today ? ' class="on"' : ''}${cell.ms === null ? '' : ` data-day="${esc(md(cell.time))}" data-spent="${esc(spentText(cell))}"`}></i>`).join('');
    const earlier = (tokens ? ledger.firstDay : summary.firstDay) && (tokens ? ledger.firstDay : summary.firstDay) < heat.from, later = quarterRange(now).to > heat.to;
    const recent = tokens ? null : summary.recent;
    const card = (index, title, body, small = '') => `<section class="qm-usage-card" style="--n:${index}"><em>${title}</em><strong>${body}</strong>${small ? `<small>${small}</small>` : ''}</section>`;
    const peakWord = summary.peak === null ? '' : summary.peak < 6 ? '深夜' : summary.peak < 12 ? '上午' : summary.peak < 18 ? '下午' : '夜里';
    // token 模式：前五格是总数，下面一行分出发出与收到；后三格是日均、记了几天、最多的一天。没有角色名单。
    const counters = tokens ? `
        ${[['今日', ledger.today], ['本周', ledger.week], ['本月', ledger.month], ['今年', ledger.year], ['累计', ledger.all]].map(([title, item], index) => card(index, title, bigTokens(item.total), esc(splitText(item)))).join('\n        ')}
        ${card(5, '日均', bigTokens(ledger.average))}
        ${card(6, '记录天数', `<i data-count="${ledger.activeDays}">${ledger.activeDays}</i><span>days</span>`, ledger.since ? `始于 <b>${md(wall(ledger.since))}</b>` : '今天开始记')}
        ${card(7, '最多一天', ledger.peak ? bigTokens(ledger.peak.total) : '—', ledger.peak ? `<b>${md(ledger.peak.day)}</b>` : '')}` : `
        ${card(0, '今日', big(summary.today))}
        ${card(1, '本周', big(summary.week))}
        ${card(2, '本月', big(summary.month))}
        ${card(3, '今年', big(summary.year))}
        ${card(4, '累计', big(summary.all))}
        ${card(5, '连续', `<i data-count="${summary.streak}">${summary.streak}</i><span>days</span>`, `最长 <b>${summary.longest} 天</b>`)}
        ${card(6, `今日来杯 ${esc(drink)}`, `<i data-count="${summary.activeDays}">${summary.activeDays}</i><span>days</span>`, summary.since ? `始于 <b>${md(wall(summary.since))}</b>` : '今天开始记')}
        ${card(7, '最常在', summary.peak === null ? '—' : `<span>${peakWord}</span><i>${pad(summary.peak)}:00</i>`, `<span class="qm-usage-zone">${esc(timeZoneText(new Date(real), picked))}<select data-usage-zone aria-label="时区"><option value=""${picked ? '' : ' selected'}>跟随系统</option>${zones.map(name => `<option value="${esc(name)}"${name === picked ? ' selected' : ''}>${esc(name.replace(/_/g, ' '))}</option>`).join('')}</select></span>`)}`;
    return `<header><h3>微醺记录</h3>${modeSwitch(tokens ? 'tokens' : 'time')}<button type="button" class="qm-usage-icon" data-usage-close aria-label="关闭">✕</button></header>
      <section class="qm-usage-heat"><div class="qm-usage-grid" style="--weeks:${heat.weeks}">${labels.map(name => `<b>${name}</b>`).join('')}${cells}</div>
        <p class="qm-usage-day" aria-live="polite">${today ? dayText(today) : ''}</p>
        <div class="qm-usage-range"><button type="button" data-usage-shift="-1" aria-label="往前"${!span.custom && !earlier ? ' disabled' : ''}>‹</button><button type="button" class="qm-usage-span" data-usage-custom aria-label="自选范围" aria-expanded="${span.custom ? 'true' : 'false'}">${dotted(heat.from)} — ${dotted(heat.to)}</button><button type="button" data-usage-shift="1" aria-label="往后"${!span.custom && !later ? ' disabled' : ''}>›</button></div>
        <div class="qm-usage-pick"${span.custom ? '' : ' hidden'}><input type="date" data-usage-from aria-label="开始日期" value="${dayKey(heat.from)}"><span>至</span><input type="date" data-usage-to aria-label="结束日期" value="${dayKey(heat.to)}"></div></section>
      ${recent ? `<button type="button" class="qm-usage-last" data-usage-page="chars" aria-label="宿缘">${face(recent, avatarUrl)}<strong>${esc(nameOf(recent))}</strong><em>${esc(durationText(recent.ms))} ›</em><small>${esc(recent.last ? `${lastChatText(wall(recent.last), now)} 聊过` : lastChatText(0, now))}</small></button>` : ''}
      <div class="qm-usage-cards">${counters}
      </div>`;
}

/** 上次看的是时长还是 token：本次打开酒馆期间记着，下次打开面板接着看。 */
let lastMode = 'time';
/** 打开面板。mount：把根节点交给主题系统（跟随千幕当前主题）。返回关闭函数。 */
export function openUsagePanel({ document = globalThis.document, getData = () => null, getFloors = () => [], setZone = () => {}, themeClass = '', mount = () => {}, now: clock = () => Date.now(), random = Math.random } = {}) {
    document.getElementById(ROOT_ID)?.remove();
    const view = document.defaultView || globalThis;
    let style = document.getElementById(`${ROOT_ID}-style`);
    if (!style) { style = document.createElement('style'); style.id = `${ROOT_ID}-style`; document.head.append(style); }
    if (style.textContent !== STYLE) style.textContent = STYLE;
    const root = document.createElement('div'); root.id = ROOT_ID; if (themeClass) root.className = themeClass;
    root.innerHTML = '<div class="qm-usage-backdrop"></div><section class="qm-usage-panel" role="dialog" aria-modal="true" aria-label="微醺记录"></section>';
    const panel = root.querySelector('.qm-usage-panel'), drink = DRINKS[Math.floor(random() * DRINKS.length) % DRINKS.length];
    let page = 'home', range = null, quarter = 0, rank = 'time', mode = lastMode;
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
        panel.innerHTML = usageMarkup(getData(), { now: clock(), range, page, mode, drink, rank, floors: page === 'chars' ? getFloors() : [] });
        // 头像取得到才显示；取不到（角色已删）就留着名字的第一个字。
        for (const image of panel.querySelectorAll('.qm-usage-face img')) { const show = () => { image.hidden = false; }; image.addEventListener('load', show); if (image.complete && image.naturalWidth) show(); }
        panel.scrollTop = 0; if (animate) countUp();
        try { drawThread(panel); } catch (error) { console.warn('[微醺记录] 红线没画出来', error); }
    };
    // 视差：红线浮在上面，指针一动它错开得比内容多。
    root.addEventListener('pointermove', event => {
        const thread = panel.querySelector('.qm-usage-thread'); if (!thread?.style || typeof panel.getBoundingClientRect !== 'function') return;
        const frame = panel.getBoundingClientRect(); if (!(frame.width > 0)) return;
        thread.style.transform = `translate(${(-((event.clientX - frame.left) / frame.width - .5) * 10).toFixed(1)}px, ${(-((event.clientY - frame.top) / frame.height - .5) * 7).toFixed(1)}px)`;
    });
    root.addEventListener('click', event => {
        event.stopPropagation();
        // 点热力格里的一天：这一格弹一下并描上边，下面那一行换成它的日期与时长。只换这一行，格子不重画。
        const cell = event.target.closest?.('.qm-usage-grid i[data-day]');
        if (cell) {
            const line = panel.querySelector('.qm-usage-day'); if (!line) return;
            for (const other of panel.querySelectorAll('.qm-usage-grid i.on')) other.classList.remove('on');
            void cell.offsetWidth; // 再点同一格也重新弹一下
            cell.classList.add('on');
            const swatch = document.createElement('i'), day = document.createElement('span'), spent = document.createElement('b');
            swatch.dataset.level = cell.dataset.level; day.textContent = cell.dataset.day; spent.textContent = cell.dataset.spent;
            line.replaceChildren(swatch, day, spent);
            line.classList.remove('is-swap'); void line.offsetWidth; line.classList.add('is-swap');
            return;
        }
        const hit = event.target.closest?.('button, .qm-usage-backdrop');
        if (!hit) return;
        if (hit.matches('.qm-usage-backdrop') || hit.hasAttribute('data-usage-close')) return close();
        if (hit.dataset.usageMode) { if (hit.dataset.usageMode !== mode) { mode = lastMode = hit.dataset.usageMode === 'tokens' ? 'tokens' : 'time'; page = 'home'; paint(); } }
        else if (hit.dataset.usageRank) { rank = hit.dataset.usageRank; paint(); }
        else if (hit.dataset.usagePage) { page = hit.dataset.usagePage; paint(); }
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
