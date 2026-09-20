// Built-in floating controls must never be captured as external plugin entries.
export const QIANMU_DETACHED_OWNED_SELECTOR='.qm-prose-hive-layer,[data-qm-prose-assistant-portal],[data-qm-text-collection-portal]';
export function isQianmuOwnedDockDescriptor(item){
 const paths=[item?.selector,...(Array.isArray(item?.shadowPath)?item.shadowPath:[]),...(Array.isArray(item?.activatorPath)?item.activatorPath:[])];
 return paths.some(path=>typeof path==='string'&&(/\.qm-prose-hive-layer\b|\.sd-detached-notes-entry\b|\[data-qm-prose-assistant-portal/.test(path)
  ||/\[(?:aria-label|title)=["'](?:打开正文助手|打开场外特助|正文助手（拖回千幕归巢）|场外特助（拖回千幕归巢）)["']\]/.test(path)));
}
