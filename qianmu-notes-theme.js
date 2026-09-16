// Notes live outside the main panel. Update only their theme-bearing attributes;
// never rebuild an editor or a captured-pointer entry just to change colours.
function setThemeClass(root, prefix, key) {
  for (const name of [...root.classList]) if (name.startsWith(prefix)) root.classList.remove(name);
  root.classList.add(`${prefix}${key}`);
}

export function syncQianmuNotesTheme({document = globalThis.document, themeKey = 'light', palette, appearance = {}, variables = [],
  sourceId = 'story-director-modal', panelId = 'qianmu-notes-panel-layer', floatId = 'qianmu-notes-float-layer'} = {}) {
  if (!document) return;
  if (typeof themeKey !== 'string' || !/^[a-z][a-z0-9-]*$/.test(themeKey)) throw new TypeError('Invalid notes theme key.');
  const panel = document.getElementById(panelId), floating = document.getElementById(floatId);
  if (panel) {
    let source = document.getElementById(sourceId), temporary = false;
    if (!source) {
      source = document.createElement('div');
      source.id = sourceId;
      source.className = `sd-theme-${themeKey}`;
      document.body.appendChild(source);
      temporary = true;
    }
    try {
      setThemeClass(source, 'sd-theme-', themeKey);
      setThemeClass(panel, 'sd-theme-', themeKey);
      const style = document.defaultView.getComputedStyle(source);
      for (const variable of variables) {
        const value = style.getPropertyValue(variable);
        if (value.trim()) panel.style.setProperty(variable, value);
        else panel.style.removeProperty(variable);
      }
    } finally {
      if (temporary) source.remove();
    }
  }
  if (!floating) return;
  setThemeClass(floating, 'sd-theme-', themeKey);
  setThemeClass(floating, 'sd-hive-theme-', themeKey);
  const entry = floating.querySelector('.sd-detached-notes-entry');
  if (!entry || !palette) return;
  const tone = appearance.tone === 'light' ? 'light' : 'dark';
  const requestedIndex = Number(appearance.edgeIndex);
  const index = Number.isFinite(requestedIndex) ? Math.max(0, Math.trunc(requestedIndex)) : 0;
  const edge = palette.edges?.length ? palette.edges[index % palette.edges.length] : palette.mainEdge;
  entry.classList.toggle('is-glass-light', tone === 'light');
  entry.classList.toggle('is-glass-dark', tone === 'dark');
  for (const [key, value] of [['--sd-wheel-glass-fill', palette[`${tone}Fill`]], ['--sd-wheel-edge', edge], ['--sd-wheel-icon', palette[`${tone}Icon`]]]) {
    if (typeof value === 'string' && value) entry.style.setProperty(key, value);
  }
}
