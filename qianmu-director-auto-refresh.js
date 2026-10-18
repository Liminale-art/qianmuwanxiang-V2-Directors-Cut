// A single, chat-bound pending trigger. This never saves, retries a model call,
// or treats MESSAGE_RECEIVED / GENERATION_ENDED as a persistence receipt.
export function createDirectorAutoRefresh({ getContext, getStore, getSettings, captureSource, host,
    isBusy, run, notify = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    const attempted = new WeakMap();
    let pending = null, timer = null, disposed = false;
    const cancel = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        pending?.source.close(); pending = null;
    };
    function current(ticket) {
        const settings = getSettings();
        return !disposed && pending === ticket && settings === ticket.settings && settings.enabled
            && settings.autoRefresh && settings.autoRefreshEvery === ticket.every && ticket.source.isCurrent();
    }
    function schedule(ticket, delay = 250) {
        if (!current(ticket)) { if (pending === ticket) cancel(); return; }
        timer = setTimer(() => { timer = null; void drain(ticket); }, delay);
    }
    function count(store, chat) {
        const end = chat.length - 1;
        let mark = Number(store.lastPlanIdx ?? -1);
        if (!Number.isFinite(mark) || mark < 0 || mark > end) {
            // Preserve initial/rewind behaviour; never advance an eligible floor
            // merely because a request is attempted. Successful adoption owns it.
            store.lastPlanIdx = end;
            return 0;
        }
        return chat.slice(mark + 1).filter(message => message && !message.is_user && !message.is_system).length;
    }
    async function drain(ticket) {
        try {
            if (!current(ticket)) { if (pending === ticket) cancel(); return; }
            await host.ready();
            if (!current(ticket)) { if (pending === ticket) cancel(); return; }
            // A hung host tail must not leave a permanent polling task. A new
            // received message may establish a fresh pending trigger, not retry
            // an already submitted request.
            if (now() - ticket.startedAt > 15 * 60 * 1000) { cancel(); return; }
            const state = host.read();
            if (!state.known) { cancel(); return; }
            if (!state.idle || isBusy()) { ticket.stable = null; schedule(ticket, 500); return; }
            // A failed old processor may coexist with a newer non-streaming
            // generation until its finalizer clears it; wait for that tail first.
            if (state.streamingStopped) { cancel(); return; }
            const chat = getContext().chat, store = getStore();
            if (count(store, chat) < ticket.every || attempted.get(store) === chat.length - 1) { cancel(); return; }
            const last = chat.at(-1);
            const stamp = JSON.stringify([chat.length, last?.name, last?.mes, last?.swipe_id]);
            if (ticket.stable !== stamp) { ticket.stable = stamp; schedule(ticket); return; }
            // Two idle observations let the native finalizer cross its delayed
            // save admission. The host's *live* stream/save state is checked
            // again in generateDirectorPlan; no duration alone proves success.
            if (!current(ticket) || !host.read().idle) { schedule(ticket); return; }
            attempted.set(store, chat.length - 1);
            cancel();
            await run();
        } catch (_) {
            if (pending !== ticket) return;
            cancel();
            try { notify('暂无法确认正文状态，自动推演未启动。', 'warning'); } catch (_) {}
        }
    }
    return Object.freeze({
        received(messageIndex, generationType) {
            if (disposed || generationType === 'quiet' || generationType === 'impersonate') return;
            const settings = getSettings(), chat = getContext().chat;
            if (!settings.enabled || !settings.autoRefresh || !Number.isFinite(settings.autoRefreshEvery) || settings.autoRefreshEvery <= 0
                || !Array.isArray(chat) || !chat.length) return;
            const message = chat[Number.isInteger(messageIndex) ? messageIndex : chat.length - 1];
            if (!message || message.is_user || message.is_system) return;
            cancel();
            try {
                const source = captureSource();
                pending = { source, settings, every: settings.autoRefreshEvery, startedAt: now(), stable: null };
                schedule(pending);
            } catch (_) { cancel(); }
        },
        cancel,
        dispose() { disposed = true; cancel(); },
    });
}
