// 三套主题共用的部分：把数据里的文字转义、退出与换主题、删除单条、日期筛选（日／周，前后翻，月历）。
// 主题页面只需提供 window.yimuPaint(D, raw)：D 是按所选日期筛过、已转义的数据，可以反复调用。
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safe = value => Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) : typeof value === 'string' ? esc(value) : value;
const tell = type => parent.postMessage({ yimuHeart: type }, '*');
document.getElementById('ym-exit').addEventListener('click', () => tell('exit'));
document.getElementById('ym-theme').addEventListener('click', () => tell('theme'));
document.getElementById('ym-export').addEventListener('click', () => tell('export'));
addEventListener('keydown', event => { if (event.key === 'Escape') { if (YM.open) { YM.open = false; drawDate(); } else tell('exit'); } });

// 删除单条：主题在每条印象、心迹、年表条目里放 rm(kind, id) 给出的小「×」。点一下变「再点删除」，几秒内再点才删。
// 「待凝定的印象」用 rmq：平时不显，鼠标移上去（触屏点一下那一条）才出现，点一下直接删、不留底。
// 在捕获阶段接住点击，条目自己的展开不会跟着触发。
const rmq = (kind, id) => id ? `<button type="button" class="ym-rm ym-rmq" data-rm-kind="${kind}" data-rm-id="${id}" aria-label="删除">×</button>` : '';
const rm = (kind, id) => id ? `<button type="button" class="ym-rm" data-rm-kind="${kind}" data-rm-id="${id}" aria-label="删除">×</button>` : '';
let rmArmed = null, rmTimer = 0;
const rmDisarm = () => { clearTimeout(rmTimer); if (rmArmed) { rmArmed.removeAttribute('data-armed'); rmArmed.textContent = '×'; rmArmed.setAttribute('aria-label', '删除'); } rmArmed = null; };
document.addEventListener('click', event => {
    const button = event.target.closest?.('.ym-rm');
    // 触屏没有悬停：点一下「待凝定的印象」那一条，它的小叉才出来；再点别处收回。
    const loose = event.target.closest?.('.ym-loose');
    for (const node of document.querySelectorAll?.('.ym-loose[data-pick]') || []) if (node !== loose) node.removeAttribute('data-pick');
    if (loose && !button) loose.toggleAttribute('data-pick');
    if (!button) { rmDisarm(); return; }
    event.preventDefault(); event.stopPropagation();
    if (button.classList?.contains('ym-rmq')) {
        rmDisarm(); button.disabled = true;
        parent.postMessage({ yimuHeart: 'remove', kind: button.dataset.rmKind, id: button.dataset.rmId }, '*');
        return;
    }
    if (rmArmed !== button) {
        rmDisarm(); rmArmed = button; button.setAttribute('data-armed', 'true'); button.textContent = '再点删除'; button.setAttribute('aria-label', '再点删除');
        rmTimer = setTimeout(rmDisarm, 4000);
        return;
    }
    rmDisarm(); button.disabled = true;
    parent.postMessage({ yimuHeart: 'remove', kind: button.dataset.rmKind, id: button.dataset.rmId }, '*');
}, true);

// 日期按「记下的那一刻」（系统时间）算。默认停在最新有记录的那一天。
const DAY = 86400000, WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weekStart = ms => { const d = new Date(dayStart(ms)); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }; // 周一起
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const YM = { raw: { impressions: [], loose: [], thoughts: [], events: [] }, mode: 'day', anchor: 0, month: 0, open: false, pick: false };
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
function repaint() { drawDate(); drawFloors(); drawTools(); window.yimuPaint?.(safe(picked(YM.raw)), YM.raw); decorate(); }

// —— 修改、补记、补全 ——
// 修改：每条日记、心迹、年表的小「×」旁边再放一支小笔，不用主题各自去摆。
function decorate() {
    if (document.body?.dataset?.standalone || typeof document.querySelectorAll !== 'function') return;
    // 合订：放在「待凝定的印象」这行小标题后面；有还没合订的留意、忆幕开着才出现。
    const tools = YM.raw?.tools || {};
    for (const title of document.querySelectorAll('.drift h4, .loose h4, .strip-label')) {
        title.querySelector('.ym-bind')?.remove();
        if (!tools.ready || !(tools.pending > 0) || title.hidden) continue;
        const bind = document.createElement('button');
        bind.type = 'button'; bind.className = 'ym-bind'; bind.textContent = bindBusy ? '合订中' : '合订'; bind.disabled = bindBusy; bind.title = '把这些合订成日记';
        title.append(bind);
    }
    for (const rmButton of document.querySelectorAll('.ym-rm:not(.ym-rmq)')) {
        if (rmButton.previousElementSibling?.classList?.contains('ym-ed')) continue;
        const pen = document.createElement('button');
        pen.type = 'button'; pen.className = 'ym-ed'; pen.textContent = '✎'; pen.setAttribute('aria-label', '修改');
        pen.dataset.edKind = rmButton.dataset.rmKind; pen.dataset.edId = rmButton.dataset.rmId;
        rmButton.before(pen);
        try { const at = getComputedStyle(rmButton); pen.style.top = at.top; pen.style.right = `${(parseFloat(at.right) || 0) + rmButton.offsetWidth + 2}px`; } catch { /* keep the stylesheet position */ }
    }
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
        <div class="ym-sheet-range"><label><span>从第几层</span><input name="start" inputmode="numeric" value="${Number(tools.first) || 0}"></label><label><span>到第几层</span><input name="end" inputmode="numeric" value="${Number(tools.last) || 0}"></label></div>
        <div class="ym-sheet-foot"><button type="button" data-sheet-close>算了</button><button type="submit"></button></div></form>`;
    const start = sheet.querySelector('[name="start"]'), end = sheet.querySelector('[name="end"]'), go = sheet.querySelector('[type="submit"]');
    const read = node => /^\d+$/.test(node.value.trim()) ? Number(node.value) : NaN;
    const sync = () => { const count = fillCount(Math.max(read(start), Number(tools.first) || 0), Math.min(read(end), Number(tools.last) || 0), tools.per); go.textContent = count ? `约 ${count} 次请求 · 确认补全` : '楼层没填对'; go.disabled = !count; };
    sync(); document.body.append(sheet);
    sheet.addEventListener('input', sync);
    sheet.addEventListener('click', event => { if (event.target === sheet || event.target.closest?.('[data-sheet-close]')) closeSheet(); });
    sheet.addEventListener('submit', event => {
        event.preventDefault(); if (go.disabled) return;
        parent.postMessage({ yimuHeart: 'fill', start: Math.max(read(start), Number(tools.first) || 0), end: Math.min(read(end), Number(tools.last) || 0) }, '*');
        closeSheet();
    });
}
let bindBusy = false;
document.addEventListener('click', event => {
    const bind = event.target.closest?.('.ym-bind');
    if (bind) { event.preventDefault(); event.stopPropagation(); if (bindBusy) return; bindBusy = true; decorate(); parent.postMessage({ yimuHeart: 'bind' }, '*'); return; }
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
function openSheet(kind, id) {
    closeSheet();
    const list = { impression: YM.raw.impressions, thought: YM.raw.thoughts, event: YM.raw.events }[kind] || [];
    const item = id ? list.find(entry => entry.id === id) : null;
    if (id && !item) return;
    const sheet = document.createElement('div'); sheet.id = 'ym-sheet'; sheet.dataset.kind = kind; sheet.dataset.id = id || '';
    const draw = () => { sheet.innerHTML = `<form class="ym-sheet-card" role="dialog" aria-label="${id ? '修改' : '补记'}">
        <div class="ym-sheet-head">${id ? `<b>修改这一条${SHEET_KINDS.find(([key]) => key === sheet.dataset.kind)[1]}</b>` : SHEET_KINDS.map(([key, name]) => `<button type="button" data-sheet-kind="${key}" aria-pressed="${key === sheet.dataset.kind}">${name}</button>`).join('')}</div>
        ${sheetFields(sheet.dataset.kind, item)}
        <div class="ym-sheet-foot"><button type="button" data-sheet-close>算了</button><button type="submit">存下</button></div></form>`; };
    draw(); document.body.append(sheet);
    sheet.addEventListener('click', event => {
        const pick = event.target.closest?.('[data-sheet-kind]');
        if (pick) { sheet.dataset.kind = pick.dataset.sheetKind; draw(); sheet.querySelector('input, textarea')?.focus(); return; }
        if (event.target === sheet || event.target.closest?.('[data-sheet-close]')) closeSheet();
    });
    sheet.addEventListener('submit', event => {
        event.preventDefault();
        const fields = Object.fromEntries([...sheet.querySelectorAll('input[name], textarea[name]')].map(node => [node.name, node.value]));
        const main = sheet.dataset.kind === 'event' ? fields.title : fields.about;
        if (!String(fields.text || '').trim() || !String(main || '').trim()) { sheet.querySelector('.ym-sheet-card').dataset.shake = '1'; return; }
        parent.postMessage({ yimuHeart: id ? 'edit' : 'add', kind: sheet.dataset.kind, id: id || undefined, fields }, '*');
        closeSheet();
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
    bindBusy = false; // 新数据到了：合订那一下已经有了结果
    const data = raw && typeof raw === 'object' ? raw : {};
    YM.raw = { ...data, impressions: data.impressions || [], loose: data.loose || [], thoughts: data.thoughts || [], events: data.events || [] };
    if (!YM.anchor) { YM.anchor = recordDays().at(-1) ?? dayStart(Date.now()); YM.month = YM.anchor; }
    repaint();
};
