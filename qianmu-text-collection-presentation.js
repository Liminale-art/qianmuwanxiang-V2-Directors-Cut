import { qianmuIconElement } from './qianmu-icon-renderer.js';

// Reading already skips empty paragraph runs. Keep editing equally readable,
// while an untouched presentation round-trip must retain the exact saved text.
export function collectionEditorText(text) {
    return text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim()).join('\n\n');
}

export function collectionEditorValue(original, value) {
    return value === collectionEditorText(original) ? original : value;
}

export function collectionIconButton(document, action, label, icon) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'qm-text-collection-icon';
    button.dataset.collectionManage = action; button.title = label; button.setAttribute('aria-label', label);
    button.append(qianmuIconElement(`qm-regular-${icon}`, { document }));
    return button;
}

// Font follows the currently displayed prose, never a saved historical style.
export function applyCollectionProseStyle(dialog, sourceElement, parent) {
    const document = dialog.ownerDocument, view = document.defaultView;
    const sources = document.querySelectorAll('#chat .mes_text');
    const source = sourceElement?.isConnected && sourceElement.ownerDocument === document ? sourceElement : sources[sources.length - 1] || parent;
    if (!source) return;
    const style = view.getComputedStyle(source), paragraph = source.querySelector('p');
    dialog.style.setProperty('--qm-collection-prose-size', style.fontSize);
    dialog.style.setProperty('--qm-collection-prose-font', style.fontFamily);
    dialog.style.setProperty('--qm-collection-prose-line', style.lineHeight === 'normal' ? '1.6' : style.lineHeight);
    const gap = paragraph ? parseFloat(view.getComputedStyle(paragraph).marginBottom) : 0;
    const fontSize = parseFloat(style.fontSize) || 16;
    dialog.style.setProperty('--qm-collection-prose-gap', `${Math.max(fontSize * .6, Number.isFinite(gap) ? Math.min(20, gap) : 0)}px`);
}
