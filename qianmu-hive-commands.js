// Shared built-in commands; no runtime state or network dependencies.
export const QIANMU_HIVE_COMMANDS = Object.freeze([
  { id: 'dashboard', label: '推演', icon: 'fa-clapperboard', glyph: 'qm-duotone-film-slate' },
  { id: 'focus', label: '专注', icon: 'fa-hourglass-half', glyph: 'focus' },
  { id: 'notes', label: '便笺', icon: 'fa-note-sticky', glyph: 'qm-regular-note-pencil' },
  { id: 'assistant', label: '正文助手', icon: 'fa-comments' },
  { id: 'collections', label: '正文收藏', icon: 'fa-bookmark' },
  { id: 'tasksnodes', label: '任务', icon: 'fa-list-check', glyph: 'tasks' },
  { id: 'castworld', label: '世界', icon: 'fa-earth-asia', glyph: 'world' },
  { id: 'context', label: '取材', icon: 'fa-box-archive', glyph: 'context' },
  { id: 'settings', label: '幕后', icon: 'fa-feather-pointed', glyph: 'backstage' },
  { id: 'theater', label: '幕外', icon: 'fa-masks-theater', glyph: 'qm-regular-tv' },
  { id: 'tts', label: '配音', icon: 'fa-microphone-lines', glyph: 'qm-duotone-microphone-stage' },
  { id: 'coread', label: '书架', icon: 'fa-book-open', glyph: 'coread-entry' },
  { id: 'geopolitics', label: '世界格局', icon: 'fa-atom', glyph: 'world-map' },
  { id: 'plug', label: 'API与日志', icon: 'fa-gear', glyph: 'qm-duotone-gear' },
  { id: 'imagegen', label: '分镜', icon: 'fa-video', glyph: 'qm-regular-aperture' },
  { id: 'floor', label: '楼层跳转', icon: 'fa-layer-group', glyph: 'floor-tools' },
]);

export function upgradeProseHiveCommands(settings) {
  if (settings.proseHiveVersion === 1) return;
  for (const key of ['quickWheelCustomOrder', 'quickWheelCustomEnabled']) {
    if (Array.isArray(settings[key])) settings[key] = [...new Set([...settings[key], 'assistant', 'collections'])];
  }
  settings.proseHiveVersion = 1;
}
