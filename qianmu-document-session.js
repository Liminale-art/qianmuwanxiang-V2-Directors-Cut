// A page/account-owned view of one ST document. Panels subscribe/unsubscribe;
// only the owner disposes it. No persistence, migration, timers or auto-retry.
// The supplied native store remains responsible for authorization and conflicts.
const failure = (code, message) => Object.assign(new Error(message), {code: `document_session_${code}`});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function copyJson(value) {
    const seen = new Set();
    function check(item, depth = 0) {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number' && Number.isFinite(item)) return;
        if (!item || typeof item !== 'object' || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
            throw failure('value', '资料必须是完整的 JSON 内容');
        }
        if (depth > 32 || seen.has(item)) throw failure('value', '资料结构无效');
        seen.add(item);
        for (const child of Array.isArray(item) ? Array.from(item) : Object.values(item)) check(child, depth + 1);
        seen.delete(item);
    }
    const copy = structuredClone(value);
    check(copy);
    return copy;
}

function documentCopy(record) {
    if (!record || typeof record.exists !== 'boolean') throw failure('receipt', '未收到完整的资料确认');
    const valid = record.exists
        ? typeof record.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(record.fingerprint)
        : record.fingerprint === null && record.value === null;
    if (!valid) {
        throw failure('receipt', '未收到完整的资料确认');
    }
    return {exists: record.exists, fingerprint: record.fingerprint, value: copyJson(record.value)};
}

export function createDocumentSession({store, slot, isCurrent} = {}) {
    if (typeof store?.read !== 'function' || typeof store?.write !== 'function'
        || typeof isCurrent !== 'function' || typeof slot !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(slot)) {
        throw new TypeError('Document session requires a native store, slot and owner lifetime');
    }
    let closed = false, confirmed = null, draft = null, lastError = null;
    let reading = null, writing = null, needsRefresh = false;
    const listeners = new Set(), controllers = new Set();

    function check() {
        if (closed || isCurrent() !== true) throw failure('closed', '资料会话已结束');
        return true;
    }
    function state() {
        check();
        return structuredClone({
            phase: writing ? 'saving' : reading ? (confirmed ? 'refreshing' : 'loading') : lastError ? 'error' : confirmed ? 'ready' : 'idle',
            document: confirmed, draft, needsRefresh,
            error: lastError ? {code: lastError.code || 'document_session_storage', message: lastError.message} : null,
        });
    }
    function emit() {
        for (const listener of [...listeners]) {
            if (!listeners.has(listener)) continue;
            try { listener(state()); } catch { /* Presentation cannot change a storage outcome. */ }
        }
    }
    function options(controller) { return {guard: check, signal: controller.signal}; }

    function read() {
        check();
        if (reading) return reading;
        const controller = new AbortController();
        controllers.add(controller);
        reading = Promise.resolve().then(() => {
            check();
            return store.read(slot, options(controller));
        }).then(result => {
            check();
            confirmed = documentCopy(result);
            needsRefresh = false;
            // A lost acknowledgement can be reconciled by an explicit read of
            // the desired content. A different remote value never erases draft.
            if (draft && confirmed.exists && equal(confirmed.value, draft.value)) draft = null;
            lastError = !draft ? null : confirmed.fingerprint === draft.expectedFingerprint
                ? failure('unsaved', '编辑稿尚未保存，可以重试')
                : failure('conflict', '资料已有更新，编辑稿已保留');
            return structuredClone(confirmed);
        }).catch(error => {
            if (!closed) lastError = error;
            throw error;
        }).finally(() => {
            controllers.delete(controller);
            reading = null;
            emit();
        });
        emit();
        return reading;
    }

    function open() {
        try {
            check();
            // Navigation never invalidates the last confirmed view.
            return confirmed ? Promise.resolve(structuredClone(confirmed)) : read().then(value => structuredClone(value));
        } catch (error) { return Promise.reject(error); }
    }
    function refresh() {
        try {
            check();
            // Explicit refresh waits for this write, including unknown outcomes;
            // it cannot publish a pre-save response after the save completes.
            if (writing) return writing.promise.catch(() => {}).then(refresh);
            return read().then(value => structuredClone(value));
        } catch (error) { return Promise.reject(error); }
    }
    function save(value, {expectedFingerprint} = {}) {
        try {
            check();
            const next = copyJson(value);
            if (writing) {
                if (expectedFingerprint === writing.base && equal(next, writing.value)) return writing.promise.then(result => structuredClone(result));
                throw failure('busy', '请等待当前保存完成');
            }
            if (reading) throw failure('busy', '请等待当前读取完成');
            if (!confirmed) throw failure('unopened', '请先打开资料');
            if (needsRefresh) throw failure('pending', '请先刷新核对上次保存，编辑稿已保留');
            if (expectedFingerprint !== confirmed.fingerprint) throw failure('conflict', '编辑版本已变化，未覆盖');
            if (confirmed.exists && equal(next, confirmed.value)) {
                const unchanged = structuredClone(confirmed);
                draft = null; lastError = null; emit();
                return Promise.resolve(unchanged);
            }
            const controller = new AbortController(), operation = {base: expectedFingerprint, value: next, promise: null};
            controllers.add(controller);
            draft = {value: next, expectedFingerprint}; lastError = null;
            writing = operation;
            operation.promise = Promise.resolve().then(() => {
                check();
                return store.write(slot, next, {...options(controller), expectedFingerprint});
            }).then(result => {
                check();
                const receipt = documentCopy(result);
                if (!receipt.exists || !equal(receipt.value, next)) throw failure('receipt', '保存结果尚未确认，编辑稿已保留');
                confirmed = receipt; draft = null; lastError = null;
                return structuredClone(confirmed);
            }).catch(error => {
                if (!closed) {
                    lastError = error;
                    // A rejected input has not reached storage. Refresh cannot
                    // fix capacity/format errors; keep the draft directly usable.
                    // A known version conflict still needs an explicit new read.
                    needsRefresh = error?.writeState !== 'not_started' || /conflict/.test(error?.code || '');
                }
                throw error;
            }).finally(() => {
                controllers.delete(controller);
                writing = null;
                emit();
            });
            emit();
            return operation.promise.then(result => structuredClone(result));
        } catch (error) { return Promise.reject(error); }
    }
    return Object.freeze({open, refresh, save, state,
        subscribe(listener) {
            check();
            if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
            listeners.add(listener);
            try { listener(state()); } catch { /* Same isolation as subsequent notifications. */ }
            return () => listeners.delete(listener);
        },
        dispose() {
            closed = true;
            for (const controller of controllers) controller.abort();
            listeners.clear(); confirmed = null; draft = null; lastError = null;
            // The caller owns the adapter; another session may still use it.
        },
    });
}
