// Explicit plain DOM edits for integration tests, not a native typing emulator.
export function setCollectionEditorText(element, value) {
    const text = value.replace(/\r\n?/g, '\n');
    element.replaceChildren(...text.split(/\n[\t ]*\n/).map(value => {
        const paragraph = element.ownerDocument.createElement('p'); paragraph.textContent = value; return paragraph;
    }));
    element.emit('input');
}
export function collectionEditorDisplayText(element) {
    const text = node => node.tagName === 'BR' ? '\n'
        : node.childNodes.length ? [...node.childNodes].map(text).join('') : node.textContent;
    return [...element.children].map(text).join('\n\n');
}
