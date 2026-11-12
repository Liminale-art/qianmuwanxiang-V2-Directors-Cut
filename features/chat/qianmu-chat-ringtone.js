// Chat toolkit ringtone: one completion sound plus a background-tab title/favicon alert after a reply arrives.
// It never sounds for failed, stopped, quiet or dry-run generations, and it owns no chat data.
const PRESET_ROWS = [
  ['LINE', 'line-default', '默认铃声', 'mp3'], ['LINE', 'line-slow-chime', '慢连音', 'mp3'], ['LINE', 'line-dulcimer-1', '扬琴 1', 'mp3'],
  ['LINE', 'line-dulcimer-2', '扬琴 2', 'mp3'], ['LINE', 'line-crystal', '水晶', 'mp3'], ['LINE', 'line-droplet', '水滴', 'mp3'], ['LINE', 'line-bug', '调皮小虫', 'mp3'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13].map(n => ['消息提示短音', `short-notification-${n}`, `notification ${n}`, 'mp3']),
  ['消息提示短音', 'short-notification-14', 'notification 14', 'flac'],
  ['消息提示短音', 'short-clear-combo-1', 'clear combo 1', 'mp3'], ['消息提示短音', 'short-clear-combo-2', 'clear combo 2', 'mp3'],
  ['消息提示短音', 'short-combine-special', 'combine special', 'mp3'], ['消息提示短音', 'short-item-pick-up', 'item pick up', 'mp3'],
  ['消息提示短音', 'short-level-complete', 'level complete', 'mp3'],
  ['果壳铃', 'shell-bell-water', '水铃桐', 'mp3'], ['果壳铃', 'shell-bell-ethereal', '略带空灵的水铃', 'mp3'],
  ['塞尔达', 'zelda-yahaha', '呀哈哈', 'mp3'], ['塞尔达', 'zelda-complete', '完成', 'mp3'], ['塞尔达', 'zelda-sheikah', '希卡', 'mp3'],
  ['塞尔达', 'zelda-sheikah-update', '希卡更新', 'mp3'], ['塞尔达', 'zelda-get', '获取', 'mp3'],
  ['宝可梦', 'pokemon-item-found', '物品发现', 'mp3'], ['宝可梦', 'pokemon-pick-berry', '摘果子', 'mp3'], ['宝可梦', 'pokemon-heal', '治疗', 'mp3'],
  ['宝可梦', 'pokemon-forget-move', '技能遗忘', 'mp3'],
  ['星露谷', 'stardew-fish-bite', '钓鱼上钩', 'mp3'], ['星露谷', 'stardew-chicken', '鸡', 'mp3'], ['星露谷', 'stardew-cow', '牛', 'mp3'],
  ['chiikawa', 'chiikawa-usagi', 'usagi', 'mp3'], ['chiikawa', 'chiikawa-usagi-2', 'usagi 2', 'mp3'], ['chiikawa', 'chiikawa-car-honk', 'car honk', 'mp3'],
  ['其他', 'bubble-pop', 'Q 弹气泡', 'mp3'], ['其他', 'mario-coin', 'mario coin', 'mp3'], ['其他', 'bowl-432hz', '432Hz 钵', 'mp3'],
  ['其他', 'christmas-chimes', 'christmas chimes', 'mp3'], ['其他', 'jingle-bells', 'jingle bells', 'mp3'],
  ['其他', 'crisp-droplet-echo', '清脆回响水滴', 'mp3'], ['其他', 'crisp-wind-chime', '清脆风铃', 'mp3'],
];
export const RINGTONE_PRESETS = Object.freeze(PRESET_ROWS.map(([group, id, label, ext]) =>
  Object.freeze({ group, id, label, url: new URL(`../../assets/ringtones/${id}.${ext}`, import.meta.url).href })));
export const RINGTONE_TAB_ICONS = Object.freeze([1, 2].map(n => new URL(`../../assets/tab-icons/doro-${n}.ico`, import.meta.url).href));
export const RINGTONE_LIMITS = Object.freeze({ localSoundBytes: 5 * 1024 * 1024, localSoundCount: 20, iconInputBytes: 4 * 1024 * 1024, iconSize: 64, iconDataChars: 96 * 1024, flashText: 24, url: 2048 });
export const RINGTONE_DEFAULTS = Object.freeze({
  soundEnabled: false, soundSource: 'builtin', soundPreset: 'line-default', soundUrl: '', localSounds: [], localId: '',
  volume: 80, soundOnlyHidden: false, flashEnabled: false, flashText: '( •̀ .̫ •́ )✧叮咚，您有新订单啦~', iconSource: 'builtin', customIcons: [],
  toastSkin: false, toastStyle: 'default', toastFontSize: 'md', toastDuration: 4, toastStack: 3,
});
// ST notification skin. Placement stays ST's own top-centre; only the card is restyled.
// 'default' follows the Qianmu theme and day/night; 辉光 is a narrow glow-edge chamfered block that only
// follows day/night (edge tinted by status), with a left→right light sweep; 虹彩 is a soft iridescent liquid glass.
export const TOAST_STYLES = Object.freeze([['default', '默认'], ['glow', '辉光'], ['iris', '虹彩']]);
export const TOAST_FONT_SIZES = Object.freeze([['sm', '小'], ['md', '中'], ['lg', '大']]);
// 停留时间 1–10 s and 堆叠数量 1–8 are both picked on a horizontal wheel.
export const TOAST_DURATIONS = Object.freeze(Array.from({ length: 10 }, (_, i) => Object.freeze([i + 1, `${i + 1}s`])));
// How many notifications stay visible at once (newest first); default 3 keeps bursts from flooding the screen.
export const TOAST_STACK_MAX = 8;
export const TOAST_STACKS = Object.freeze(Array.from({ length: TOAST_STACK_MAX }, (_, i) => Object.freeze([i + 1, String(i + 1)])));
const TOAST_ATTR = 'data-qm-toast';
const TOAST_SIZE_ATTR = 'data-qm-toast-size';
const TOAST_MODE_ATTR = 'data-qm-toast-mode';
const TOAST_THEME_ATTR = 'data-qm-toast-theme';
const TOAST_STACK_ATTR = 'data-qm-toast-stack';
const TOAST_THEMES = ['light', 'dark', 'summer', 'candy', 'kraft', 'dream', 'editorial', 'glass'];
/**
 * Skins ST notifications purely through CSS keyed on <html> attributes. It never
 * observes, polls, wraps or rewrites the toast library or its nodes, so a busy burst
 * costs nothing extra and removing the attributes restores ST's own look.
 * `look` carries the current Qianmu theme so the default card follows it and day/night.
 */
export function applyToastSkin(document, s, look = null) {
  const root = document?.documentElement;
  if (!root?.setAttribute) return;
  if (s?.toastSkin) {
    root.setAttribute(TOAST_ATTR, s.toastStyle);
    root.setAttribute(TOAST_SIZE_ATTR, s.toastFontSize);
    root.setAttribute(TOAST_MODE_ATTR, look?.mode === 'dark' ? 'dark' : 'light');
    root.setAttribute(TOAST_THEME_ATTR, TOAST_THEMES.includes(look?.theme) ? look.theme : 'light');
    // Extra cards beyond the stack count are hidden by CSS only; the library keeps its own queue and timers.
    const stack = Number(s.toastStack);
    if (Number.isInteger(stack) && stack >= 1 && stack <= TOAST_STACK_MAX) root.setAttribute(TOAST_STACK_ATTR, String(stack));
    else root.removeAttribute(TOAST_STACK_ATTR);
  } else {
    for (const name of [TOAST_ATTR, TOAST_SIZE_ATTR, TOAST_MODE_ATTR, TOAST_THEME_ATTR, TOAST_STACK_ATTR]) root.removeAttribute(name);
  }
}
const SOURCES = ['builtin', 'url', 'local'];
const isIconData = value => typeof value === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= RINGTONE_LIMITS.iconDataChars;
const isLocalId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** Repairs the stored settings in place so the toolkit and the event path read one shape. */
export function normalizeRingtone(owner) {
  const raw = owner?.ringtone && typeof owner.ringtone === 'object' && !Array.isArray(owner.ringtone) ? owner.ringtone : {};
  const next = { ...RINGTONE_DEFAULTS, ...raw };
  next.soundEnabled = next.soundEnabled === true; next.flashEnabled = next.flashEnabled === true; next.soundOnlyHidden = next.soundOnlyHidden === true;
  if (!SOURCES.includes(next.soundSource)) next.soundSource = 'builtin';
  if (!RINGTONE_PRESETS.some(item => item.id === next.soundPreset)) next.soundPreset = RINGTONE_DEFAULTS.soundPreset;
  next.soundUrl = typeof next.soundUrl === 'string' ? next.soundUrl.trim().slice(0, RINGTONE_LIMITS.url) : '';
  // Multi-record local library: each entry is { id, name, size }. Migrate the legacy single local sound (keyed 'message').
  let sounds = Array.isArray(next.localSounds) ? next.localSounds : [];
  sounds = sounds.filter(item => item && typeof item === 'object' && isLocalId(item.id)).slice(0, RINGTONE_LIMITS.localSoundCount).map(item => ({
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.slice(0, 120) : '本地铃声',
    size: Number.isFinite(Number(item.size)) ? Math.max(0, Math.round(Number(item.size))) : 0,
  }));
  if (!sounds.length && typeof raw.localName === 'string' && raw.localName.trim()) {
    sounds = [{ id: 'message', name: raw.localName.slice(0, 120), size: Number.isFinite(Number(raw.localSize)) ? Math.max(0, Math.round(Number(raw.localSize))) : 0 }];
  }
  // Drop duplicate ids, keeping the first occurrence.
  const seen = new Set();
  next.localSounds = sounds.filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  next.localId = isLocalId(next.localId) && next.localSounds.some(item => item.id === next.localId)
    ? next.localId
    : (next.localSounds[0]?.id || '');
  delete next.localName; delete next.localSize;
  const volume = Number(next.volume);
  next.volume = Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : RINGTONE_DEFAULTS.volume;
  next.flashText = typeof next.flashText === 'string' ? [...next.flashText.trim()].slice(0, RINGTONE_LIMITS.flashText).join('') : RINGTONE_DEFAULTS.flashText;
  next.iconSource = next.iconSource === 'custom' ? 'custom' : 'builtin';
  next.toastSkin = next.toastSkin === true;
  if (next.toastStyle === 'arc' || next.toastStyle === 'splat') next.toastStyle = 'glow'; // 样式1 历次更名→辉光
  if (!TOAST_STYLES.some(([id]) => id === next.toastStyle)) next.toastStyle = RINGTONE_DEFAULTS.toastStyle;
  if (!TOAST_FONT_SIZES.some(([id]) => id === next.toastFontSize)) next.toastFontSize = RINGTONE_DEFAULTS.toastFontSize;
  if (!TOAST_DURATIONS.some(([seconds]) => seconds === next.toastDuration)) next.toastDuration = RINGTONE_DEFAULTS.toastDuration;
  const stack = Number(next.toastStack);
  next.toastStack = Number.isInteger(stack) && stack >= 1 && stack <= TOAST_STACK_MAX ? stack : RINGTONE_DEFAULTS.toastStack;
  delete next.toastPosition; // retired: placement is always ST's native top-centre
  next.customIcons = Array.isArray(next.customIcons) ? next.customIcons.slice(0, 2).map(item => (isIconData(item) ? item : '')) : [];
  if (owner && typeof owner === 'object') owner.ringtone = next;
  return next;
}

/**
 * Per-call display options for Qianmu's own notifications while the skin is on. Nothing in
 * the toast library is changed: the caller passes these as the third argument of one toast.
 */
export function toastCallOptions(s) {
  if (!s?.toastSkin) return null;
  const ms = Math.round((TOAST_DURATIONS.some(([seconds]) => seconds === s.toastDuration) ? s.toastDuration : RINGTONE_DEFAULTS.toastDuration) * 1000);
  return { timeOut: ms, extendedTimeOut: Math.max(ms, 1000) };
}

export const safeSoundUrl = value => /^https?:\/\/[^\s]+$/i.test(String(value || '').trim()) ? String(value).trim() : '';

/** Alternates the tab title and favicon until the page is visible again; restores exactly what it replaced. */
export function createTabAlert({ document, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval, period = 1000 }) {
  let timer = 0, tick = 0, base = '', frames = [], saved = [], created = null, marked = '', stopAt = 0, now = () => Date.now();
  const icons = () => [...document.querySelectorAll('link[rel~="icon"]')];
  function paint() {
    const on = tick % 2 === 0; tick += 1;
    // Another script may retitle the page mid-alert; adopt that as the new base instead of erasing it.
    if (document.title !== marked && document.title !== base) base = document.title;
    marked = on && frames.text ? `【${frames.text}】${base}` : base;
    document.title = marked;
    const href = frames.icons[on ? 0 : 1] || '';
    for (const [link, original] of saved) link.setAttribute('href', href || original || '');
    if (created) created.setAttribute('href', href || frames.icons[0] || '');
    if (stopAt && now() >= stopAt) stop();
  }
  function start({ text = '', icons: frameIcons = [], duration = 0 } = {}) {
    stop();
    base = document.title; frames = { text, icons: frameIcons.filter(Boolean) }; tick = 0; stopAt = duration ? now() + duration : 0;
    if (!frames.text && !frames.icons.length) return false;
    saved = icons().map(link => [link, link.getAttribute('href'), link.getAttribute('type')]);
    for (const [link] of saved) link.removeAttribute('type');
    if (!saved.length && frames.icons.length && document.head) {
      created = document.createElement('link'); created.setAttribute('rel', 'icon'); created.dataset.qianmuRingtone = '1';
      document.head.append(created);
    }
    paint(); timer = setInterval(paint, period);
    return true;
  }
  function stop() {
    if (timer) clearInterval(timer);
    const wasActive = Boolean(timer); timer = 0;
    if (wasActive && document.title === marked) document.title = base;
    for (const [link, href, type] of saved) {
      if (href === null) link.removeAttribute('href'); else link.setAttribute('href', href);
      if (type !== null) link.setAttribute('type', type);
    }
    saved = []; created?.remove(); created = null; marked = ''; stopAt = 0;
    return wasActive;
  }
  return Object.freeze({ start, stop, active: () => Boolean(timer), setClock(fn) { now = fn; } });
}

/**
 * A single reusable media element; volume is the stored percentage.
 * `onChange(state)` reports 'idle' | 'loading' | 'playing' (drives the list's audio bar), once per change.
 */
export function createRingPlayer({ Audio, onChange = () => {} }) {
  let media = null, source = '', sequence = 0, status = 'idle';
  const report = next => { if (next === status) return; status = next; try { onChange(next); } catch (_) {} };
  function stop() {
    sequence += 1;
    try { media?.pause(); if (media) media.currentTime = 0; } catch (_) {}
    report('idle');
  }
  async function play(url, volume) {
    if (!url) return false;
    if (!media || source !== url) {
      stop();
      try { media?.removeAttribute?.('src'); media?.load?.(); } catch (_) {}
      media = new Audio(url); media.preload = 'auto'; source = url;
      const own = media;
      const on = (names, next) => { for (const name of names) own.addEventListener?.(name, () => { if (own === media) report(next); }); };
      on(['ended', 'pause', 'error'], 'idle'); on(['waiting'], 'loading'); on(['playing'], 'playing');
    }
    const mine = ++sequence;
    report('loading');
    try {
      media.volume = Math.min(1, Math.max(0, Number(volume) / 100));
      media.currentTime = 0;
      await media.play();
      if (mine === sequence && !media.paused && !media.ended) report('playing');
      return mine === sequence;
    } catch (_) { if (mine === sequence) report('idle'); return false; }
  }
  const playing = () => Boolean(media && !media.paused && !media.ended);
  function dispose() { stop(); try { media?.removeAttribute?.('src'); media?.load?.(); } catch (_) {} media = null; source = ''; }
  return Object.freeze({ play, stop, playing, dispose, source: () => source, state: () => status });
}

/** The local sound lives in this browser only (one record per account), never in synced settings. */
export function createLocalSoundStore({ indexedDB = globalThis.indexedDB, resolveNamespace }) {
  async function withStore(mode, action) {
    const namespace = String(await resolveNamespace() || '').trim();
    if (!namespace) throw new Error('尚未确认当前账户，不能存取本地铃声');
    if (!indexedDB?.open) throw new Error('此浏览器不支持保存本地铃声，请改用链接');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`qianmu-ringtone:${encodeURIComponent(namespace)}`, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('sounds')) request.result.createObjectStore('sounds'); };
      request.onerror = () => reject(new Error('本地铃声库无法打开，请检查浏览器存储权限'));
      request.onblocked = () => reject(new Error('本地铃声库正被其他页面占用，请关闭旧页面后重试'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        let result = null;
        const tx = db.transaction('sounds', mode);
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(new Error(mode === 'readonly' ? '本地铃声读取失败' : '本地铃声未保存，请检查浏览器存储空间'));
        action(tx.objectStore('sounds'), value => { result = value; });
      });
    } finally { db.close(); }
  }
  return Object.freeze({
    get: id => withStore('readonly', (store, done) => { const request = store.get(String(id)); request.onsuccess = () => done(request.result || null); }),
    put: (id, blob) => withStore('readwrite', store => { store.put(blob, String(id)); }),
    delete: id => withStore('readwrite', store => { store.delete(String(id)); }),
  });
}

/** Any browser-decodable image (PNG/JPG/WebP/GIF/SVG/ICO/BMP) becomes a square PNG data URL a tab can show. */
export async function imageToFavicon(file, { document, URL: URLClass = globalThis.URL, Image: ImageClass = globalThis.Image, size = RINGTONE_LIMITS.iconSize } = {}) {
  if (!file || !file.size) throw new Error('图片为空');
  if (file.size > RINGTONE_LIMITS.iconInputBytes) throw new Error('图片超过 4 MB，请换一张小一些的图片');
  if (file.type && !/^image\//i.test(file.type) && !/\.(ico|cur|svg)$/i.test(file.name || '')) throw new Error('请选择图片文件');
  const url = URLClass.createObjectURL(file);
  try {
    const image = new ImageClass();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('无法读取这张图片，请换用 PNG、JPG 或 ICO')); image.src = url; });
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('无法读取这张图片的尺寸');
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d');
    const scale = Math.min(size / width, size / height), w = width * scale, h = height * scale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
    const data = canvas.toDataURL('image/png');
    if (!isIconData(data)) throw new Error('转换后的图标无效或过大');
    return data;
  } finally { URLClass.revokeObjectURL(url); }
}

export function createChatRingtone({ getOwner, save, getContext, resolveNamespace, notify = () => {}, isCurrent = () => true,
  document = globalThis.document, window = globalThis.window, Audio = globalThis.Audio, URL: URLClass = globalThis.URL,
  indexedDB = globalThis.indexedDB, getLook = () => null, loadView = () => import('./qianmu-chat-ringtone-view.js?v=1.59.495'), now = () => Date.now(), setInterval: setIntervalFn = globalThis.setInterval, clearInterval: clearIntervalFn = globalThis.clearInterval }) {
  // The list's audio bar mirrors the audition: idle (grey) / loading / playing (green).
  const player = createRingPlayer({ Audio, onChange: next => mounted?.view?.setAudio?.(next) });
  const alert = createTabAlert({ document, setInterval: setIntervalFn, clearInterval: clearIntervalFn });
  alert.setClock(now);
  const store = createLocalSoundStore({ indexedDB, resolveNamespace });
  let armed = false, lastRing = 0, mounted = null, disposed = false, listening = false, localSeq = 0, skinActive = false;
  const localUrls = new Map(); // id -> object URL cache for this session
  const state = () => normalizeRingtone(getOwner());
  const hidden = () => Boolean(document.hidden) || (typeof document.hasFocus === 'function' && !document.hasFocus());
  const refresh = () => mounted?.view.render(state());
  const syncToast = () => { if (skinActive) applyToastSkin(document, state(), getLook()); };
  function update(patch) {
    Object.assign(state(), patch);
    normalizeRingtone(getOwner());
    save(); syncToast(); refresh();
  }
  const newLocalId = () => `l${now().toString(36)}${(localSeq++).toString(36)}`;
  async function localSource(id) {
    if (!id) return '';
    if (localUrls.has(id)) return localUrls.get(id);
    const blob = await store.get(id).catch(() => null);
    if (disposed || !blob) return '';
    const url = URLClass.createObjectURL(blob);
    localUrls.set(id, url);
    return url;
  }
  function dropLocalUrl(id) {
    if (id) { const url = localUrls.get(id); if (url) { URLClass.revokeObjectURL(url); localUrls.delete(id); } return; }
    player.stop();
    for (const url of localUrls.values()) URLClass.revokeObjectURL(url);
    localUrls.clear();
  }
  async function soundSource(s = state()) {
    if (s.soundSource === 'url') return safeSoundUrl(s.soundUrl);
    if (s.soundSource === 'local') return s.localId ? localSource(s.localId).catch(() => '') : '';
    return (RINGTONE_PRESETS.find(item => item.id === s.soundPreset) || RINGTONE_PRESETS[0]).url;
  }
  const iconFrames = (s = state()) => {
    if (s.iconSource !== 'custom') return [...RINGTONE_TAB_ICONS];
    const custom = s.customIcons.filter(Boolean);
    return custom.length ? [custom[0], custom[1] || ''] : [...RINGTONE_TAB_ICONS];
  };
  const stopFlash = () => { if (!hidden()) alert.stop(); };
  function listen(on) {
    if (on === listening || !document?.addEventListener) return;
    listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', stopFlash); window?.[method]?.('focus', stopFlash);
  }
  function flash(options = {}) {
    const s = state();
    const started = alert.start({ text: s.flashText, icons: iconFrames(s), ...options });
    listen(started && !options.duration);
    return started;
  }
  async function ring() {
    const s = state(), background = hidden();
    if (s.flashEnabled && background) flash();
    if (s.soundEnabled && (!s.soundOnlyHidden || background)) await player.play(await soundSource(s), s.volume);
  }
  const events = Object.freeze({
    // Quiet/dry-run passes (summaries, token counts) run beside a real reply; they neither arm nor disarm it.
    generationStarted(type, options, dryRun) { if (!dryRun && !['quiet', 'impersonate'].includes(type) && !options?.quiet_prompt) armed = true; },
    generationStopped() { armed = false; },
    chatChanged() { armed = false; alert.stop(); },
    messageReceived(id, type) {
      if (!armed || type === 'first_message' || !isCurrent()) return;
      armed = false;
      const message = getContext()?.chat?.[Number(id)];
      if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()) return;
      // Group replies arrive back to back; one alert per burst is enough.
      if (now() - lastRing < 1500) return;
      lastRing = now();
      void ring();
    },
  });
  const actions = Object.freeze({
    presets: RINGTONE_PRESETS, limits: RINGTONE_LIMITS, builtinIcons: RINGTONE_TAB_ICONS, iconFrames: () => iconFrames(),
    update,
    // Phone-OS list behaviour: picking a row auditions it and records the choice at once (no separate preview button).
    stopSound() { player.stop(); },
    async selectPreset(id) {
      const preset = RINGTONE_PRESETS.find(item => item.id === id);
      if (!preset) return;
      const s = state(); s.soundPreset = id; normalizeRingtone(getOwner()); save();
      await player.play(preset.url, s.volume);
    },
    setVolume(value, commit = false) {
      const s = state(); s.volume = value; normalizeRingtone(getOwner());
      if (commit) save();
    },
    async pickLocal(file) {
      if (!file) return;
      if (!file.size) throw new Error('音频文件为空');
      if (file.size > RINGTONE_LIMITS.localSoundBytes) throw new Error('音频超过 5 MB，请截取一段短铃声');
      if (file.type && !/^audio\//i.test(file.type)) throw new Error('请选择音频文件');
      const probe = file.type && document.createElement?.('audio');
      if (probe?.canPlayType && !probe.canPlayType(file.type)) throw new Error('当前浏览器不支持这种音频格式，请转成 MP3 后再选');
      const existing = state().localSounds;
      if (existing.length >= RINGTONE_LIMITS.localSoundCount) throw new Error(`本地铃声最多保存 ${RINGTONE_LIMITS.localSoundCount} 个，请先移除一些`);
      const id = newLocalId();
      await store.put(id, file);
      const entry = { id, name: String(file.name || '本地铃声'), size: file.size };
      update({ soundSource: 'local', localSounds: [...existing, entry], localId: id });
      notify('本地铃声已保存在此浏览器。', 'success');
    },
    async selectLocal(id) {
      if (!state().localSounds.some(item => item.id === id)) return;
      const s = state(); s.localId = id; normalizeRingtone(getOwner()); save();
      const url = await localSource(id).catch(() => '');
      if (url) await player.play(url, s.volume);
    },
    async clearLocal(id) {
      const s = state();
      const target = id || s.localId;
      if (!target) return;
      await store.delete(target).catch(() => {});
      dropLocalUrl(target);
      const remaining = s.localSounds.filter(item => item.id !== target);
      update({ localSounds: remaining, localId: remaining[0]?.id || '' });
    },
    async pickIcon(slot, file) {
      const data = await imageToFavicon(file, { document, URL: URLClass });
      const icons = [...state().customIcons]; icons[slot === 1 ? 1 : 0] = data;
      update({ iconSource: 'custom', customIcons: [icons[0] || '', icons[1] || ''] });
    },
    clearIcons() { update({ customIcons: [], iconSource: 'builtin' }); },
    testFlash() { return flash({ duration: 6000 }); },
    toastStyles: TOAST_STYLES,
    toastFontSizes: TOAST_FONT_SIZES,
    toastDurations: TOAST_DURATIONS,
    toastStacks: TOAST_STACKS,
    previewToast() { notify('(｡･∀･)ﾉﾞoi，这是一条提示框预览', 'info'); },
  });
  async function mount(host) {
    if (!host || mounted?.host === host) return;
    unmount(); disposed = false;
    const token = {}; mounted = { host, token, view: null };
    const module = await loadView();
    if (disposed || mounted?.token !== token || !host.isConnected) return;
    mounted.view = module.mountChatRingtoneView({ root: host, actions, notify });
    mounted.view.setAudio?.(player.state());
    refresh();
  }
  function unmount() { player.stop(); mounted?.view?.dispose(); mounted = null; }
  // Runtime teardown; a later re-enable may mount again.
  // Applies the saved toast skin once settings are loaded (runtime init).
  function activate() { skinActive = true; syncToast(); }
  // Re-reads the Qianmu theme after a theme/day-night change so the default card follows it.
  function refreshLook() { syncToast(); }
  function dispose() { disposed = true; skinActive = false; applyToastSkin(document, null); unmount(); listen(false); alert.stop(); player.dispose(); dropLocalUrl(); armed = false; }
  return Object.freeze({ events, mount, unmount, activate, refreshLook, dispose, actions, state });
}
