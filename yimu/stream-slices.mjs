// 从还没收完的流式返回里，取出「已经完整成形」的切片。
// 整理结果是 {"slices":[{…},{…}]}：一个切片对象的右花括号到了，这一片就算成立，可以先给用户看；
// 还在往外吐字的那一片不显示。只做展示用，真正入库仍以完整返回经 parseSummary 校验为准。
export function completedSlices(text) {
    const source = typeof text === 'string' ? text : '';
    const key = source.indexOf('"slices"');
    if (key < 0) return [];
    const open = source.indexOf('[', key);
    if (open < 0) return [];
    const found = [];
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let index = open + 1; index < source.length; index++) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '{') { if (depth === 0) start = index; depth++; continue; }
        if (char === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                try {
                    const slice = JSON.parse(source.slice(start, index + 1));
                    if (slice && typeof slice === 'object' && typeof slice.text === 'string' && slice.text.trim()) found.push({
                        start: Number.isSafeInteger(slice.start) ? slice.start : null, end: Number.isSafeInteger(slice.end) ? slice.end : null,
                        title: typeof slice.title === 'string' ? slice.title : '', text: slice.text.trim(),
                    });
                } catch { /* 不成形的片段不显示 */ }
                start = -1;
            }
            continue;
        }
        if (char === ']' && depth === 0) break; // slices 数组结束
    }
    return found;
}
