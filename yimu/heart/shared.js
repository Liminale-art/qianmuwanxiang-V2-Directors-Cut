// 各套主题共用的部分：把数据里的文字转义、退出与换主题、删除单条、日期筛选（日／周，前后翻，月历）。
// 主题页面只需提供 window.yimuPaint(D, raw)：D 是按所选日期筛过、已转义的数据，可以反复调用。
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safe = value => Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) : typeof value === 'string' ? esc(value) : value;
const tell = type => parent.postMessage({ yimuHeart: type }, '*');
document.getElementById('ym-exit').addEventListener('click', () => tell('exit'));
document.getElementById('ym-theme').addEventListener('click', () => tell('theme'));
document.getElementById('ym-export').addEventListener('click', () => tell('export'));
addEventListener('keydown', event => { if (event.key === 'Escape') { if (YM.open) { YM.open = false; drawDate(); } else tell('exit'); } });

// 删除单条：主题在每条印象、心迹、年表条目里放 rm(kind, id) 给出的小「×」，点一下直接删。
// 「待凝定的印象」用 rmq：平时不显，鼠标移上去（触屏点一下那一条）才出现；它旁边的小笔也一样。
// 在捕获阶段接住点击，条目自己的展开不会跟着触发。
// 删、存、清空之后，那一条（或那一栏）先进入「处理中」：变淡、不能再点，小叉换成一个小转圈。
// 面板做完会把数据重新交来（没做成也会原样重交一次），页面整页重画，处理中自然消失。
const rmq = (kind, id) => id ? `<button type="button" class="ym-rm ym-rmq" data-rm-kind="${kind}" data-rm-id="${id}" aria-label="删除">×</button>` : '';
const rm = (kind, id) => id ? `<button type="button" class="ym-rm" data-rm-kind="${kind}" data-rm-id="${id}" aria-label="删除">×</button>` : '';
// 一键清空：顶栏「返回」后面的小字钮，把存照、心迹、年表连同待凝定的印象一起清掉。量大，所以点一下变「再点清空」，几秒内再点才清。
const clearButton = (() => {
    const exit = document.getElementById('ym-exit');
    if (!exit || typeof exit.before !== 'function' || typeof document.createElement !== 'function') return null;
    const left = document.createElement('span'), button = document.createElement('button');
    left.className = 'ymbar-l'; button.type = 'button'; button.id = 'ym-clear'; button.textContent = '清空'; button.setAttribute('aria-label', '清空存照、心迹与年表');
    exit.before(left); left.append(exit, button);
    return button;
})();
let clearTimer = 0;
const clearDisarm = () => { clearTimeout(clearTimer); if (clearButton?.hasAttribute('data-armed')) { clearButton.removeAttribute('data-armed'); clearButton.textContent = '清空'; } };
const clearSync = () => {
    if (!clearButton) return; const raw = YM.raw;
    clearButton.disabled = YM.busyAll || !(raw.impressions.length || raw.loose.length || raw.thoughts.length || raw.events.length);
    if (YM.busyAll) clearButton.textContent = '清空中'; else if (clearButton.textContent === '清空中') clearButton.textContent = '清空';
    if (clearButton.disabled && !YM.busyAll) clearDisarm();
};
clearButton?.addEventListener('click', event => {
    event.stopPropagation();
    if (!clearButton.hasAttribute('data-armed')) { clearButton.setAttribute('data-armed', 'true'); clearButton.textContent = '再点清空'; clearTimer = setTimeout(clearDisarm, 4000); return; }
    clearDisarm(); YM.busyAll = true; busyNow();
    parent.postMessage({ yimuHeart: 'clear' }, '*');
});
// 「待凝定的印象」一栏自己的清空（小标题后面）：只清这一栏，同样点一下变「再点清空」。按钮随重画重建，待确认与否记在这里。
let looseArmed = false, looseTimer = 0;
const looseDisarm = () => {
    clearTimeout(looseTimer); if (!looseArmed) return; looseArmed = false;
    for (const node of document.querySelectorAll?.('.ym-clear-loose') || []) { node.removeAttribute('data-armed'); if (!node.disabled) node.textContent = '清空'; }
};
// —— 处理中 ——
const busyKey = (kind, id) => `${kind}:${id}`;
let busyTimer = 0;
function busyEntry(entry) {
    if (typeof entry?.setAttribute !== 'function') return;
    entry.setAttribute('data-ym-busy', ''); entry.setAttribute('aria-busy', 'true');
    for (const node of entry.querySelectorAll?.('button') || []) node.disabled = true;
}
function busyMark(rmButton) {
    rmButton.disabled = true; rmButton.setAttribute?.('data-busy', ''); rmButton.setAttribute?.('aria-label', '处理中');
    const box = rmButton.parentElement;
    busyEntry(box?.classList?.contains('ym-acts') ? box.parentElement : box);
}
function busyPaint() {
    if (typeof document.querySelectorAll !== 'function') return;
    for (const node of document.querySelectorAll('.ym-rm')) {
        if (YM.busyAll || YM.busy.has(busyKey(node.dataset?.rmKind, node.dataset?.rmId)) || YM.busyLoose && node.classList?.contains('ym-rmq')) busyMark(node);
    }
    if (YM.busyAll || YM.busyLoose) for (const node of document.querySelectorAll('.ym-loose')) busyEntry(node);
}
function busyReset() { clearTimeout(busyTimer); YM.busy.clear(); YM.busyAll = YM.busyLoose = false; }
// 正常情况下面板很快就重交数据；万一一直没回音，过一会儿也恢复成可点，不让页面一直卡在处理中。
function busyNow() {
    clearTimeout(busyTimer); busyTimer = setTimeout(() => { busyReset(); repaint(); }, 20000);
    clearSync(); decorate(); busyPaint();
}
document.addEventListener('click', event => {
    const button = event.target.closest?.('.ym-rm');
    // 触屏没有悬停：点一下「待凝定的印象」那一条，它的小笔小叉才出来；再点别处收回。
    const loose = event.target.closest?.('.ym-loose');
    for (const node of document.querySelectorAll?.('.ym-loose[data-pick]') || []) if (node !== loose) node.removeAttribute('data-pick');
    if (loose && !event.target.closest?.('.ym-acts')) loose.toggleAttribute('data-pick');
    if (event.target !== clearButton) clearDisarm();
    if (!event.target.closest?.('.ym-clear-loose')) looseDisarm();
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    if (button.disabled) return;
    YM.busy.add(busyKey(button.dataset.rmKind, button.dataset.rmId)); busyMark(button); busyNow();
    parent.postMessage({ yimuHeart: 'remove', kind: button.dataset.rmKind, id: button.dataset.rmId }, '*');
}, true);

// 日期按「记下的那一刻」（系统时间）算。默认停在最新有记录的那一天。
const DAY = 86400000, WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weekStart = ms => { const d = new Date(dayStart(ms)); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }; // 周一起
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const YM = { raw: { impressions: [], loose: [], thoughts: [], events: [] }, mode: 'day', anchor: 0, month: 0, open: false, pick: false,
    busy: new Set(), busyAll: false, busyLoose: false }; // busy：处理中的单条（「类别:标识」）；busyAll／busyLoose：整页／待凝定一栏在清空
const stamps = raw => [...raw.loose.map(item => item.at), ...raw.thoughts.map(item => item.at), ...raw.impressions.flatMap(item => [item.at, ...(item.stamps || [])])].filter(Number.isFinite);
const recordDays = () => [...new Set(stamps(YM.raw).map(dayStart))].sort((a, b) => a - b);
const span = () => { const from = YM.mode === 'week' ? weekStart(YM.anchor) : YM.anchor; return [from, addDays(from, YM.mode === 'week' ? 7 : 1)]; };
const within = at => { const [from, to] = span(); return at >= from && at < to; };
const md = ms => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日`; };
// 带上年份：按周看时，跨年才在后一头再写一次年份。
const ymd = ms => `${new Date(ms).getFullYear()}年${md(ms)}`;
const spanLabel = () => { const [from, to] = span(), last = addDays(to, -1); return YM.mode === 'week' ? `${ymd(from)} – ${new Date(last).getFullYear() === new Date(from).getFullYear() ? md(last) : ymd(last)}` : `${ymd(from)} 周${WEEKDAYS[new Date(from).getDay()]}`; };
function picked(raw) {
    return { ...raw, impressions: raw.impressions.filter(item => within(item.at) || (item.stamps || []).some(within)), loose: raw.loose.filter(item => within(item.at)),
        thoughts: raw.thoughts.filter(item => within(item.at)), events: raw.events.map(item => ({ ...item, now: within(item.at) })), period: spanLabel() };
}
function drawDate() {
    const host = document.getElementById('ym-date');
    if (!host) return;
    const days = recordDays(), [from, to] = span(), before = days.filter(day => day < from).at(-1), after = days.find(day => day >= to);
    const first = new Date(YM.month); first.setDate(1); first.setHours(0, 0, 0, 0);
    const lead = (first.getDay() + 6) % 7, count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), has = new Set(days), today = dayStart(Date.now());
    const months = new Set(days.map(day => { const d = new Date(day); return `${d.getFullYear()}-${d.getMonth()}`; }));
    const cells = Array.from({ length: lead }, () => '<i></i>').concat(Array.from({ length: count }, (_, index) => {
        const at = new Date(first.getFullYear(), first.getMonth(), index + 1).getTime();
        return `<button type="button" data-day="${at}" class="${[has.has(at) ? 'has' : '', at >= from && at < to ? 'on' : '', at === today ? 'today' : ''].join(' ').trim()}">${index + 1}</button>`;
    }));
    host.innerHTML = `<button type="button" data-go="${before ?? ''}" aria-label="往前" ${before === undefined ? 'disabled' : ''}>‹</button>
      <button type="button" id="ym-date-label" aria-haspopup="dialog" aria-expanded="${YM.open}">${spanLabel()}</button>
      <button type="button" data-go="${after ?? ''}" aria-label="往后" ${after === undefined ? 'disabled' : ''}>›</button>
      <span class="ym-date-mode"><button type="button" data-mode="day" aria-pressed="${YM.mode === 'day'}">日</button><button type="button" data-mode="week" aria-pressed="${YM.mode === 'week'}">周</button></span>
      <div class="ym-cal" role="dialog" aria-label="选日期" ${YM.open ? '' : 'hidden'}>${YM.pick
        ? `<div class="ym-cal-head"><button type="button" data-year="-1" aria-label="上一年">‹</button><button type="button" data-pick="0" class="ym-cal-title">${first.getFullYear()} 年</button><button type="button" data-year="1" aria-label="下一年">›</button></div>
      <div class="ym-cal-months">${Array.from({ length: 12 }, (_, month) => `<button type="button" data-pick-month="${month}" class="${[months.has(`${first.getFullYear()}-${month}`) ? 'has' : '', month === first.getMonth() ? 'on' : ''].join(' ').trim()}">${month + 1} 月</button>`).join('')}</div>`
        : `<div class="ym-cal-head"><button type="button" data-month="-1" aria-label="上个月">‹</button><button type="button" data-pick="1" class="ym-cal-title" aria-label="选年月">${first.getFullYear()} 年 ${first.getMonth() + 1} 月</button><button type="button" data-month="1" aria-label="下个月">›</button></div>
      <div class="ym-cal-grid">${['一', '二', '三', '四', '五', '六', '日'].map(name => `<span>${name}</span>`).join('')}${cells.join('')}</div>`}</div>`;
}
// 楼层计数：日期条下面一行小字。只有数字，数字不进筛选。
function drawFloors() {
    const host = document.getElementById('ym-date'); if (!host) return;
    let node = document.getElementById('ym-floors');
    const floors = YM.raw?.floors, total = Number(floors?.total) || 0;
    if (!(total > 0)) { node?.remove(); return; }
    if (!node) { node = document.createElement('p'); node.id = 'ym-floors'; host.after(node); }
    // 一整句放在同一个 span 里：「本卷同叙 N 节・共织故事 M 章」，数字两侧各一个空格。
    const count = value => { const b = document.createElement('b'); b.textContent = String(Math.max(0, Math.floor(Number(value) || 0))); return b; };
    const line = document.createElement('span'); line.append('本卷同叙 ', count(floors.chat), ' 节・共织故事 ', count(total), ' 章');
    node.replaceChildren(line);
}
function repaint() { drawDate(); drawFloors(); drawTools(); clearSync(); window.yimuPaint?.(safe(picked(YM.raw)), YM.raw); decorate(); busyPaint(); roam(); }

// —— 「待凝定的印象」换位置 ——
// 每一条淡出到看不见的那一刻换到另一处（尽量不压着别的条），再淡入。只在会飘的主题里（.drift）；
// 「减少动态效果」下不动，仍是一条一行往下排。
const ROAM_DRIFT = 26, ROAM_GAP = 12;
function roamPlace(box, node) {
    const top = Number(box.dataset.roamTop) || 0, width = node.offsetWidth, height = node.offsetHeight;
    const spanX = Math.max(0, box.clientWidth - width - ROAM_DRIFT), spanY = Math.max(0, box.clientHeight - top - height - ROAM_GAP);
    const others = [...box.querySelectorAll('.ym-loose')].filter(other => other !== node && other.dataset.roamX)
        .map(other => ({ x: Number(other.dataset.roamX), y: Number(other.dataset.roamY), w: other.offsetWidth, h: other.offsetHeight }));
    let best = null;
    for (let turn = 0; turn < 28; turn++) {
        const x = Math.random() * spanX, y = top + Math.random() * spanY;
        const hit = others.reduce((sum, other) => sum + Math.max(0, Math.min(x + width, other.x + other.w) + ROAM_DRIFT - Math.max(x, other.x))
            * Math.max(0, Math.min(y + height, other.y + other.h) + ROAM_GAP - Math.max(y, other.y)), 0);
        if (!best || hit < best.hit) best = { x, y, hit };
        if (!hit) break;
    }
    node.dataset.roamX = String(Math.round(best.x)); node.dataset.roamY = String(Math.round(best.y));
    node.style.left = `${node.dataset.roamX}px`; node.style.top = `${node.dataset.roamY}px`;
}
function roam() {
    if (typeof document.querySelectorAll !== 'function' || typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const box of document.querySelectorAll('.drift')) {
        const items = [...box.querySelectorAll('.ym-loose')]; if (!items.length || !box.clientWidth) continue;
        // 先按一条一行量出各条的高，再留出一倍多的空，好有地方换。
        box.removeAttribute('data-roam'); box.style.height = '';
        for (const node of items) { node.style.left = node.style.top = ''; delete node.dataset.roamX; delete node.dataset.roamY; }
        const head = box.querySelector('h4'), top = head ? head.offsetTop + head.offsetHeight + 14 : 14;
        const need = items.reduce((sum, node) => sum + node.offsetHeight + ROAM_GAP, 0);
        box.dataset.roamTop = String(top); box.dataset.roam = '1';
        box.style.height = `${Math.round(top + Math.max(150, need * 1.6) + ROAM_GAP)}px`;
        for (const node of items) roamPlace(box, node);
    }
}
document.addEventListener('animationiteration', event => {
    const node = event.target, box = node?.parentElement;
    if (node?.classList?.contains('ym-loose') && box?.dataset?.roam) roamPlace(box, node);
}, true);
let roamTimer = 0;
addEventListener('resize', () => { clearTimeout(roamTimer); roamTimer = setTimeout(roam, 200); });

// —— 修改、补记、补全 ——
// 修改：每条日记、心迹、年表的小「×」左边再放一支小笔，不用主题各自去摆。
function decorate() {
    if (document.body?.dataset?.standalone || typeof document.querySelectorAll !== 'function') return;
    // 合订：放在「待凝定的印象」这行小标题后面；有还没合订的留意、忆幕开着才出现。
    // 清空：跟在合订后面，这一栏有条目才出现。
    const tools = YM.raw?.tools || {};
    for (const title of document.querySelectorAll('.drift h4, .strip-label')) {
        title.querySelector('.ym-bind')?.remove(); title.querySelector('.ym-clear-loose')?.remove();
        if (title.hidden) continue;
        if (tools.ready && tools.pending > 0) {
            const bind = document.createElement('button');
            bind.type = 'button'; bind.className = 'ym-bind'; bind.textContent = bindBusy ? '合订中' : '合订'; bind.disabled = bindBusy || YM.busyLoose || YM.busyAll; bind.title = '把这些合订成日记';
            title.append(bind);
        }
        if (!YM.raw?.loose?.length) continue;
        const wipe = document.createElement('button');
        wipe.type = 'button'; wipe.className = 'ym-clear-loose'; wipe.setAttribute('aria-label', '清空待凝定的印象');
        wipe.textContent = YM.busyLoose ? '清空中' : looseArmed ? '再点清空' : '清空'; wipe.disabled = YM.busyLoose || YM.busyAll;
        if (looseArmed && !wipe.disabled) wipe.setAttribute('data-armed', 'true');
        title.append(wipe);
    }
    // 笔和叉一起放进一个小框（.ym-acts），由小框占住条目的右上角，两个钮在框里并排。
    // 不能按小叉量出来的宽去摆笔：没切到的版块是隐藏的，量出来是 0，笔就压在叉上。
    for (const rmButton of document.querySelectorAll('.ym-rm:not(.ym-rmq)')) actsAround(rmButton, 'ym-acts');
    // 「待凝定的印象」：小框跟在那一条的字后面（.ym-actsq），平时不显。
    for (const rmButton of document.querySelectorAll('.ym-rmq')) actsAround(rmButton, 'ym-acts ym-actsq');
}
function actsAround(rmButton, className) {
    if (rmButton.parentElement?.classList?.contains('ym-acts')) return;
    const acts = document.createElement('span'), pen = document.createElement('button');
    acts.className = className;
    pen.type = 'button'; pen.className = 'ym-ed'; pen.textContent = '✎'; pen.setAttribute('aria-label', '修改');
    pen.dataset.edKind = rmButton.dataset.rmKind; pen.dataset.edId = rmButton.dataset.rmId;
    rmButton.before(acts); acts.append(pen, rmButton);
}
// 补记、补全：放在日期条里「日／周」的左边。补全点开一张小纸条：选楼层范围，按钮上写着大约几次请求。
function drawTools() {
    const host = document.getElementById('ym-date'); if (!host || document.body?.dataset?.standalone || typeof host.querySelector !== 'function') return;
    const tools = YM.raw?.tools || {}, mode = host.querySelector('.ym-date-mode'); if (!mode) return;
    const box = document.createElement('span'); box.className = 'ym-tools';
    const add = document.createElement('button'); add.type = 'button'; add.id = 'ym-add'; add.textContent = '补记'; add.title = '自己写一条日记、心迹或年表';
    const fill = document.createElement('button'); fill.type = 'button'; fill.id = 'ym-fill';
    if (tools.fill) { fill.textContent = `补全中 ${tools.fill.done}／${tools.fill.total} · 停`; fill.dataset.running = '1'; }
    else { fill.textContent = '补全'; fill.title = '把已有的正文再过一遍，补上当时没记下的印象与年表'; }
    if (!tools.ready || !tools.fill && !(tools.batches > 0)) fill.disabled = true;
    box.append(add, fill); mode.before(box);
}
const fillCount = (from, to, per) => Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.max(1, Math.ceil((to - from + 1) / Math.max(1, per || 20))) : 0;
function openFill() {
    closeSheet();
    const tools = YM.raw?.tools || {}, sheet = document.createElement('div'); sheet.id = 'ym-sheet';
    sheet.innerHTML = `<form class="ym-sheet-card" role="dialog" aria-label="补全">
        <div class="ym-sheet-head"><b>从正文补全</b></div>
        <p class="ym-sheet-note">把这一段正文再过一遍，补上当时没记下的印象与年表；记忆切片不动。</p>
        <div class="ym-sheet-range"><label><span>从第几层</span><input name="start" inputmode="numeric" value="${Number(tools.first) || 0}"></label><label><span>到第几层</span><input name="end" inputmode="numeric" value="${Number(tools.last) || 0}"></label><label><span>每批几层</span><input name="per" inputmode="numeric" value="${Number(tools.per) || 20}"></label></div>
        <div class="ym-sheet-foot"><button type="button" data-sheet-close>算了</button><button type="submit"></button></div></form>`;
    const start = sheet.querySelector('[name="start"]'), end = sheet.querySelector('[name="end"]'), per = sheet.querySelector('[name="per"]'), go = sheet.querySelector('[type="submit"]');
    const perOk = () => read(per) >= 1 && read(per) <= 200;
    const read = node => /^\d+$/.test(node.value.trim()) ? Number(node.value) : NaN;
    const sync = () => { const count = perOk() ? fillCount(Math.max(read(start), Number(tools.first) || 0), Math.min(read(end), Number(tools.last) || 0), read(per)) : 0; go.textContent = count ? `约 ${count} 次请求 · 确认补全` : perOk() ? '楼层没填对' : '每批填 1–200'; go.disabled = !count; };
    sync(); document.body.append(sheet);
    sheet.addEventListener('input', sync);
    sheet.addEventListener('click', event => { if (event.target === sheet || event.target.closest?.('[data-sheet-close]')) closeSheet(); });
    sheet.addEventListener('submit', event => {
        event.preventDefault(); if (go.disabled) return;
        parent.postMessage({ yimuHeart: 'fill', start: Math.max(read(start), Number(tools.first) || 0), end: Math.min(read(end), Number(tools.last) || 0), per: read(per) }, '*');
        closeSheet();
    });
}
let bindBusy = false;
document.addEventListener('click', event => {
    const bind = event.target.closest?.('.ym-bind');
    if (bind) { event.preventDefault(); event.stopPropagation(); if (bindBusy || bind.disabled) return; bindBusy = true; decorate(); parent.postMessage({ yimuHeart: 'bind' }, '*'); return; }
    const wipe = event.target.closest?.('.ym-clear-loose');
    if (wipe) {
        event.preventDefault(); event.stopPropagation(); if (wipe.disabled) return;
        if (!looseArmed) { looseArmed = true; wipe.setAttribute('data-armed', 'true'); wipe.textContent = '再点清空'; looseTimer = setTimeout(looseDisarm, 4000); return; }
        looseDisarm(); YM.busyLoose = true; busyNow();
        parent.postMessage({ yimuHeart: 'clearLoose' }, '*'); return;
    }
    const pen = event.target.closest?.('.ym-ed');
    if (pen) { event.preventDefault(); event.stopPropagation(); openSheet(pen.dataset.edKind, pen.dataset.edId); return; }
    if (event.target.closest?.('#ym-add')) { event.stopPropagation(); openSheet('impression', ''); return; }
    const fill = event.target.closest?.('#ym-fill');
    if (!fill) return;
    event.stopPropagation();
    if (fill.dataset.running) parent.postMessage({ yimuHeart: 'fillStop' }, '*'); else openFill();
}, true);
// 一张小纸条：改一条，或补记一条。补记时先选是哪一种。
const SHEET_KINDS = [['impression', '日记'], ['thought', '心迹'], ['event', '年表']];
function sheetFields(kind, item) {
    const field = (name, label, value, { area = false, hint = '' } = {}) => `<label><span>${label}</span>${area
        ? `<textarea name="${name}" rows="4" placeholder="${hint}">${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" placeholder="${hint}">`}</label>`;
    if (kind === 'event') return field('title', '标题', item?.title || '', { hint: '不超过十二字的短名' }) + field('text', '内容', item?.text || '', { area: true })
        + field('date', '日期', item?.date || '', { hint: '故事里的日子，可不填' }) + field('floor', '楼层', item ? Math.max(0, (item.floor || 1) - 1) : '', { hint: '发生在第几层，可不填' });
    if (kind === 'thought') return field('about', '写的是谁', item?.who || '', { hint: '对方、自己，或书名' }) + field('text', '内容', item?.say || '', { area: true })
        + (item ? '' : field('floor', '楼层', '', { hint: '写在第几层之后，可不填' }));
    return field('about', '写的是谁', item?.about || '', { hint: '人名' }) + field('text', '内容', item?.say || '', { area: true });
}
// 要改的那一条。「待凝定的印象」里的痕迹（trace）和还没凝定的印象（impression）在 loose 里，字段名换成小纸条认的样子。
function sheetItem(kind, id) {
    const loose = (kind === 'trace' || kind === 'impression') && YM.raw.loose.find(entry => entry.kind === kind && entry.id === id);
    if (loose) return { item: { about: loose.about, say: loose.text }, name: '印象' };
    const item = ({ impression: YM.raw.impressions, thought: YM.raw.thoughts, event: YM.raw.events }[kind] || []).find(entry => entry.id === id);
    return item ? { item, name: SHEET_KINDS.find(([key]) => key === kind)[1] } : null;
}
function openSheet(kind, id) {
    closeSheet();
    const found = id ? sheetItem(kind, id) : null, item = found?.item || null;
    if (id && !found) return;
    const sheet = document.createElement('div'); sheet.id = 'ym-sheet'; sheet.dataset.kind = kind; sheet.dataset.id = id || '';
    const draw = () => { sheet.innerHTML = `<form class="ym-sheet-card" role="dialog" aria-label="${id ? '修改' : '补记'}">
        <div class="ym-sheet-head">${id ? `<b>修改这一条${found.name}</b>` : SHEET_KINDS.map(([key, name]) => `<button type="button" data-sheet-kind="${key}" aria-pressed="${key === sheet.dataset.kind}">${name}</button>`).join('')}</div>
        ${sheetFields(sheet.dataset.kind, item)}
        <div class="ym-sheet-foot"><button type="button" data-sheet-close>算了</button><button type="submit">存下</button></div></form>`; };
    draw(); document.body.append(sheet);
    const read = () => Object.fromEntries([...sheet.querySelectorAll('input[name], textarea[name]')].map(node => [node.name, node.value]));
    const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => String(a[key]).trim() === String(b[key] ?? '').trim());
    const initial = read();
    sheet.addEventListener('click', event => {
        const pick = event.target.closest?.('[data-sheet-kind]');
        if (pick) { sheet.dataset.kind = pick.dataset.sheetKind; draw(); sheet.querySelector('input, textarea')?.focus(); return; }
        if (event.target === sheet || event.target.closest?.('[data-sheet-close]')) closeSheet();
    });
    sheet.addEventListener('submit', event => {
        event.preventDefault();
        const fields = read();
        const main = sheet.dataset.kind === 'event' ? fields.title : fields.about;
        if (!String(fields.text || '').trim() || !String(main || '').trim()) { sheet.querySelector('.ym-sheet-card').dataset.shake = '1'; return; }
        // 一个字没改：面板那边数据不变就不会重交，那一条会一直处理中，所以直接收起。
        if (id && same(fields, initial)) { closeSheet(); return; }
        closeSheet();
        if (id) { YM.busy.add(busyKey(sheet.dataset.kind, id)); busyNow(); }
        parent.postMessage({ yimuHeart: id ? 'edit' : 'add', kind: sheet.dataset.kind, id: id || undefined, fields }, '*');
    });
    sheet.querySelector('input, textarea')?.focus();
}
function closeSheet() { document.getElementById('ym-sheet')?.remove(); }
addEventListener('keydown', event => { if (event.key === 'Escape' && document.getElementById('ym-sheet')) { event.stopImmediatePropagation(); closeSheet(); } }, true);
document.addEventListener('click', event => {
    const target = event.target.closest?.('#ym-date button');
    if (!target) { if (YM.open && !event.target.closest?.('.ym-cal')) { YM.open = false; drawDate(); } return; }
    if (target.id === 'ym-date-label') { YM.open = !YM.open; YM.pick = false; YM.month = YM.anchor; drawDate(); return; }
    // 点月历顶上的年月：换成十二个月的格子，可翻年；点某个月回到那个月的日子。
    if (target.dataset.pick) { YM.pick = target.dataset.pick === '1'; drawDate(); return; }
    if (target.dataset.year) { const d = new Date(YM.month); d.setDate(1); d.setFullYear(d.getFullYear() + Number(target.dataset.year)); YM.month = d.getTime(); drawDate(); return; }
    if (target.dataset.pickMonth) { const d = new Date(YM.month); d.setDate(1); d.setMonth(Number(target.dataset.pickMonth)); YM.month = d.getTime(); YM.pick = false; drawDate(); return; }
    if (target.dataset.month) { const d = new Date(YM.month); d.setDate(1); d.setMonth(d.getMonth() + Number(target.dataset.month)); YM.month = d.getTime(); drawDate(); return; }
    if (target.dataset.mode) YM.mode = target.dataset.mode;
    else if (target.dataset.go) YM.anchor = Number(target.dataset.go);
    else if (target.dataset.day) { YM.anchor = Number(target.dataset.day); YM.open = false; }
    else return;
    YM.month = YM.anchor; repaint();
});
window.yimuRender = raw => {
    bindBusy = false; busyReset(); // 新数据到了：合订、删、存、清空都已经有了结果；没做成的条目重画后照常可点
    const data = raw && typeof raw === 'object' ? raw : {};
    YM.raw = { ...data, impressions: data.impressions || [], loose: data.loose || [], thoughts: data.thoughts || [], events: data.events || [] };
    if (!YM.anchor) { YM.anchor = recordDays().at(-1) ?? dayStart(Date.now()); YM.month = YM.anchor; }
    repaint();
};
