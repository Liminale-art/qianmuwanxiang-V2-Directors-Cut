// Runs inside page.evaluate: inspect the gradient's actual painting box, not
// just its declaration. A full-width heading can leave short text all black.
export function titleGradientProbe(node) {
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(node);
    const textWidth = range.getBoundingClientRect().width;
    const size = style.backgroundSize.split(',')[0].trim().split(/\s+/)[0];
    const paintedWidth = size.endsWith('%') ? box.width * parseFloat(size) / 100 : size.endsWith('px') ? parseFloat(size) : box.width;
    return {
        text: node.textContent.trim(), image: style.backgroundImage, clip: style.backgroundClip,
        textWidth, paintedWidth, fontSize: style.fontSize,
        gradient: style.backgroundImage.includes('linear-gradient(') && style.backgroundClip.includes('text'),
        textSized: textWidth > 0 && paintedWidth >= textWidth - 2 && paintedWidth <= textWidth + 4,
    };
}
