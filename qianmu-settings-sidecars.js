// One place that assembles the side stores behind Qianmu's settings (see qianmu-settings-persistence.js).
import { createFontFacesSidecar } from './qianmu-font-faces-sidecar.js';
import { createLogBodiesSidecar } from './qianmu-log-bodies-sidecar.js';

export function createSettingsSidecars({ resolveNamespace, requestSave, notify, onRestored } = {}) {
  const fontFaces = createFontFacesSidecar({ resolveNamespace, requestSave, notify });
  const logBodies = createLogBodiesSidecar({ resolveNamespace, requestSave, onRestored });
  return Object.freeze({ fontFaces, logBodies,
    slimmers: Object.freeze([...fontFaces.slimmers, logBodies.slimmer]),
    // Run once per settings object, right after it is loaded; they fill memory back in and never save.
    restorers: Object.freeze([settings => logBodies.restore(settings)]) });
}
