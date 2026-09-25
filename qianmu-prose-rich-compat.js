// Rich HTML cards own their own typography and width; prose controls own plain text.
// Keep the detector aligned with the CSS :has() exclusion in style.css.
export function isRichProse(message) {
  return !!message.querySelector?.('style, .np-min-card, [data-sd-prose-exempt], :scope > div[class] > div');
}
