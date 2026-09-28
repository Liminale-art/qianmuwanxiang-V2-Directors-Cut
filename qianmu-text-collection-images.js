/** Plain-text image export. No storage, HTML rendering, object URLs or network. */
const PAGE = Object.freeze({ width: 1080, height: 1440, square: 1080, margin: 96, font: 36, line: 62, gap: 22, annotationGap: 32 });
const FALLBACK_FONT = 'serif';

function failure(code, message) {
    return Object.assign(new Error(message), { code });
}

function assertActive(signal, isCurrent) {
    if (signal?.aborted || !isCurrent()) {
        const error = new Error('存图已取消');
        error.name = 'AbortError';
        throw error;
    }
}

function taskYielder() {
    // A task, not just a microtask: let closing the dialog or changing accounts run.
    if (typeof globalThis.MessageChannel === 'function') {
        const channel = new globalThis.MessageChannel();
        let resume;
        channel.port1.onmessage = () => { const done = resume; resume = null; done?.(); };
        return {
            yield: () => new Promise(resolve => { resume = resolve; channel.port2.postMessage(0); }),
            close: () => { channel.port1.close(); channel.port2.close(); },
        };
    }
    return { yield: () => new Promise(resolve => setTimeout(resolve, 0)), close() {} };
}

function safeFont(value) {
    return typeof value === 'string' && value.length <= 512 && /^[\p{L}\p{N} ,.'"_-]+$/u.test(value)
        ? value : FALLBACK_FONT;
}

function safeColor(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const color = value.trim();
    if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) return color;
    if (/^#[\da-f]{4}$/i.test(color)) return color.slice(0, 4);
    if (/^#[\da-f]{8}$/i.test(color)) return color.slice(0, 7);
    // A PNG has a solid theme-colored paper. Discard alpha, not RGB components.
    const match = /^rgba?\(([^()]*)\)$/i.exec(color);
    if (!match) return fallback;
    const channels = match[1].trim().split(/[\s,/]+/);
    if ((channels.length === 3 || channels.length === 4) && channels.every(channel => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(channel))) {
        const rgb = channels.slice(0, 3).map(channel => Math.max(0, Math.min(255, Number.parseFloat(channel) * (channel.endsWith('%') ? 2.55 : 1))));
        if (rgb.every(Number.isFinite)) return `rgb(${rgb.map(channel => Number(channel.toFixed(3))).join(', ')})`;
    }
    return fallback;
}

function imageText(value) {
    // Image-only paragraph spacing: leave stored text untouched, retain every word.
    return value.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n');
}

function* graphemes(text) {
    if (typeof Intl.Segmenter === 'function') {
        for (const item of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) yield item.segment;
        return;
    }
    // Older engines: never split a surrogate pair, combining sequence or ZWJ emoji.
    let cluster = '';
    let joinNext = false;
    let regional = 0;
    for (const char of text) {
        const extender = /[\p{Mark}\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/u.test(char);
        const flag = /[\u{1F1E6}-\u{1F1FF}]/u.test(char);
        if (cluster && !extender && !joinNext && char !== '\u200d' && !(flag && regional === 1)) {
            yield cluster;
            cluster = '';
            regional = 0;
        }
        cluster += char;
        joinNext = char === '\u200d';
        regional = flag ? regional + 1 : 0;
    }
    if (cluster) yield cluster;
}

function cursor(iterator) {
    const source = iterator[Symbol.asyncIterator]();
    let next;
    return {
        async peek() { next ??= await source.next(); return next; },
        async take() { const item = await this.peek(); next = null; return item; },
    };
}

async function annotation(lines, maxLines) {
    const input = cursor(lines);
    const prefix = [];
    for (let i = 0; i <= maxLines; i++) {
        const next = await input.take();
        if (next.done) return { async take() { return { lines: prefix, more: false }; }, short: true };
        prefix.push(next.value);
    }
    // Long annotations are consumed in bounded chunks instead of clipped/repeated.
    let buffered = prefix;
    return {
        short: false,
        async take() {
            const result = buffered.splice(0, maxLines);
            while (result.length < maxLines) {
                const next = await input.take();
                if (next.done) break;
                result.push(next.value);
            }
            return { lines: result, more: buffered.length > 0 || !(await input.peek()).done };
        },
    };
}

/**
 * Bounded async layout, injectable text measurement for deterministic unit tests.
 * Tests with synthetic metrics do not establish actual font/rendered appearance.
 * `breakAfter` describes paragraph boundaries; soft wraps add no characters.
 */
export async function* layoutTextCollectionImages({
    text, header = '', footer = '', foreground, background, fontFamily,
    measureText, signal, isCurrent = () => true, yieldControl,
} = {}) {
    if (typeof text !== 'string' || !text.trim()) throw failure('collection_image_empty', '没有可导出的正文');
    if (typeof header !== 'string' || typeof footer !== 'string' || typeof measureText !== 'function') {
        throw failure('collection_image_input', '存图内容不完整');
    }
    const yielder = yieldControl ? null : taskYielder();
    const yieldTask = yieldControl || yielder.yield;
    let processed = 0;
    const check = async amount => {
        assertActive(signal, isCurrent);
        processed += amount;
        if (processed >= 512) {
            processed = 0;
            await yieldTask();
            assertActive(signal, isCurrent);
        }
    };
    const family = safeFont(fontFamily);
    const color = safeColor(foreground, '#242b34');
    const paper = safeColor(background, '#fffdf8');
    const width = PAGE.width - 2 * PAGE.margin;

    async function* wrap(value, size, lineHeight, indent, gap) {
        let line = '';
        let first = true;
        const emit = breakAfter => ({ text: line, breakAfter, paragraphStart: first, indent: first ? indent : 0, fontSize: size, height: lineHeight + (breakAfter ? gap : 0), lineHeight });
        const measure = value => {
            const result = measureText(value, `${size}px ${family}`);
            const measured = typeof result === 'number' ? result : result?.width;
            if (!Number.isFinite(measured) || measured < 0) throw failure('collection_image_measure', '文字尺寸读取失败');
            return measured;
        };
        for (const char of graphemes(imageText(value))) {
            await check(char.length);
            if (char === '\n') {
                yield emit('\n');
                line = '';
                first = true;
                continue;
            }
            if (line && measure(line + char) > width - (first ? indent : 0)) {
                yield emit('');
                line = '';
                first = false;
            }
            line += char;
            // Measure even the first cluster: invalid font metrics must fail closed.
            measure(line);
        }
        if (line) yield emit('');
    }

    try {
        assertActive(signal, isCurrent);
        const headers = await annotation(wrap(header, 26, 40, 0, 0), 5);
        const footers = await annotation(wrap(footer, 24, 38, 0, 0), 5);
        const body = cursor(wrap(text, PAGE.font, PAGE.line, 2 * PAGE.font, PAGE.gap));
        const prefix = [];
        for (let i = 0; i < 8; i++) {
            const next = await body.take();
            if (next.done) break;
            prefix.push(next.value);
        }
        const allShortBody = prefix.length <= 7 && (await body.peek()).done;
        let firstHeader = await headers.take();
        let firstFooter = await footers.take();
        const annotationHeight = firstHeader.lines.length * 40 + firstFooter.lines.length * 38
            + (firstHeader.lines.length ? PAGE.annotationGap : 0) + (firstFooter.lines.length ? PAGE.annotationGap : 0);
        const prefixHeight = prefix.reduce((height, line) => height + line.height, 0);
        const square = allShortBody && headers.short && footers.short
            && prefixHeight <= PAGE.square - PAGE.margin * 2 - annotationHeight;
        const height = square ? PAGE.square : PAGE.height;
        let page = 0;
        for (;;) {
            assertActive(signal, isCurrent);
            const currentHeader = firstHeader || await headers.take();
            const currentFooter = firstFooter || await footers.take();
            firstHeader = firstFooter = null;
            const top = PAGE.margin + currentHeader.lines.length * 40 + (currentHeader.lines.length ? PAGE.annotationGap : 0);
            const bottom = height - PAGE.margin - currentFooter.lines.length * 38 - (currentFooter.lines.length ? PAGE.annotationGap : 0);
            const rows = [];
            let used = 0;
            while (true) {
                const next = prefix.length ? { value: prefix[0], done: false } : await body.peek();
                if (next.done || used + next.value.height > bottom - top) break;
                rows.push(next.value);
                used += next.value.height;
                if (prefix.length) prefix.shift();
                else await body.take();
            }
            const moreBody = prefix.length > 0 || !(await body.peek()).done;
            if (!rows.length && moreBody) throw failure('collection_image_layout', '正文排版空间不足');
            const commands = [];
            currentHeader.lines.forEach((line, index) => commands.push({ ...line, kind: 'header', x: PAGE.margin, y: PAGE.margin + index * 40, width, align: 'left' }));
            const contentHeight = used - (rows.at(-1)?.breakAfter ? PAGE.gap : 0);
            let y = square ? top + (bottom - top - contentHeight) / 2 : top;
            for (const row of rows) {
                const centered = square && rows.length === 1;
                commands.push({ ...row, kind: 'body', x: centered ? PAGE.width / 2 : PAGE.margin + row.indent,
                    y, width: width - (centered ? 0 : row.indent), align: centered ? 'center' : 'left' });
                y += row.height;
            }
            currentFooter.lines.forEach((line, index) => commands.push({ ...line, kind: 'footer', x: PAGE.width - PAGE.margin,
                y: height - PAGE.margin - currentFooter.lines.length * 38 + index * 38, width, align: 'right' }));
            yield { page: ++page, width: PAGE.width, height, foreground: color, background: paper, fontFamily: family, commands };
            if (!moreBody && !currentHeader.more && !currentFooter.more) break;
            await yieldTask();
        }
    } finally {
        yielder?.close();
    }
}

function png(canvas, signal, isCurrent) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, blob) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(blob);
        };
        const abort = () => {
            try { assertActive(signal, isCurrent); } catch (error) { finish(error); }
        };
        try {
            assertActive(signal, isCurrent);
            signal?.addEventListener('abort', abort, { once: true });
            canvas.toBlob(blob => {
                try {
                    assertActive(signal, isCurrent);
                    if (!blob || blob.type !== 'image/png') throw failure('collection_image_encode', '图片生成失败');
                    finish(null, blob);
                } catch (error) { finish(error); }
            }, 'image/png');
        } catch (error) { finish(error); }
    });
}

/** Encode/download/release one PNG at a time. `download` is the host's local saver. */
export async function exportTextCollectionImages({
    document = globalThis.document, download, signal, isCurrent = () => true,
    yieldControl, filenamePrefix = '千幕收藏', ...content
} = {}) {
    if (!document?.createElement || typeof download !== 'function') throw failure('collection_image_unavailable', '当前环境无法存图');
    assertActive(signal, isCurrent);
    const canvas = document.createElement('canvas');
    const yielder = yieldControl ? null : taskYielder();
    const yieldTask = yieldControl || yielder.yield;
    let pages = 0;
    try {
        const prefix = Array.from(String(filenamePrefix).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim()).slice(0, 80).join('') || '千幕收藏';
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw failure('collection_image_unavailable', '当前环境无法存图');
        const measureText = (text, font) => { context.font = font; return context.measureText(text); };
        for await (const page of layoutTextCollectionImages({ ...content, signal, isCurrent, yieldControl: yieldTask, measureText })) {
            assertActive(signal, isCurrent);
            canvas.width = page.width;
            canvas.height = page.height;
            try {
                context.fillStyle = page.background;
                context.fillRect(0, 0, page.width, page.height);
                context.fillStyle = page.foreground;
                context.textBaseline = 'top';
                for (const line of page.commands) {
                    assertActive(signal, isCurrent);
                    context.font = `${line.fontSize}px ${page.fontFamily}`;
                    context.textAlign = line.align;
                    // maxWidth also fits an unusually wide, indivisible grapheme.
                    context.fillText(line.text, line.x, line.y, line.width);
                }
                await yieldTask();
                assertActive(signal, isCurrent);
                const blob = await png(canvas, signal, isCurrent);
                assertActive(signal, isCurrent);
                await download(blob, `${prefix}-${String(page.page).padStart(3, '0')}.png`);
                pages++;
                assertActive(signal, isCurrent);
            } finally {
                canvas.width = canvas.height = 0;
            }
        }
        return { pages };
    } catch (error) {
        if (error && typeof error === 'object' && Object.isExtensible(error)) error.exportedPages = pages;
        throw error;
    } finally {
        canvas.width = canvas.height = 0;
        yielder?.close();
    }
}
