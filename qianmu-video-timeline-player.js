// 千幕完整影片顺序预览状态机。仅在显式打开预览后按段取材；不联网、不转码、不持久化临时 URL。
import { normalizeVideoTimeline, validateVideoTimeline } from './qianmu-video-timeline.js';

export const QIANMU_VIDEO_TIMELINE_PLAYER_SCHEMA = 'qianmu.video-timeline-player.v1';

const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);

function assertDependencies(value = {}) {
  if (typeof value.openMotion !== 'function') throw new Error('timeline player requires openMotion');
  if (typeof value.resolveStill !== 'function') throw new Error('timeline player requires resolveStill');
  return value;
}

export function createVideoTimelinePlaybackSession(dependencies = {}) {
  const deps = assertDependencies(dependencies);
  const schedule = typeof deps.setTimeout === 'function' ? deps.setTimeout : globalThis.setTimeout.bind(globalThis);
  const cancelSchedule = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : globalThis.clearTimeout.bind(globalThis);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  let disposed = false;
  let sequence = 0;
  let timer = null;
  let activeResource = null;
  let stillStartedAt = null;
  let state = {
    schema: QIANMU_VIDEO_TIMELINE_PLAYER_SCHEMA,
    status: 'idle', issue: '', timeline: null, index: -1, playing: false, frame: null, clipElapsedMs: 0,
  };

  function clipDurationMs(index = state.index) {
    return Math.max(100, Math.round((Number(state.timeline?.clips?.[index]?.playback?.durationSeconds) || .1) * 1000));
  }

  function currentClipElapsedMs() {
    const live = state.playing && state.timeline?.clips?.[state.index]?.kind === 'still' && stillStartedAt != null
      ? state.clipElapsedMs + Math.max(0, Number(now()) - stillStartedAt)
      : state.clipElapsedMs;
    return Math.min(clipDurationMs(), Math.max(0, Math.round(live || 0)));
  }

  function timelineElapsedMs(clipElapsedMs = currentClipElapsedMs()) {
    const previous = (state.timeline?.clips || []).slice(0, Math.max(0, state.index));
    return previous.reduce((sum, clip) => sum + Math.max(100, Math.round((Number(clip.playback?.durationSeconds) || .1) * 1000)), 0) + clipElapsedMs;
  }

  function snapshot() {
    const clipElapsedMs = currentClipElapsedMs();
    return {
      schema: state.schema,
      status: state.status,
      issue: state.issue,
      timeline: state.timeline ? normalizeVideoTimeline(state.timeline) : null,
      index: state.index,
      playing: state.playing,
      frame: state.frame ? { ...state.frame } : null,
      clipElapsedMs,
      timelineElapsedMs: timelineElapsedMs(clipElapsedMs),
    };
  }

  function emit() {
    if (disposed) return;
    try { onChange(snapshot()); } catch (_) {}
  }

  function clearTimer() {
    if (timer == null) return;
    try { cancelSchedule(timer); } catch (_) {}
    timer = null;
  }

  function commitStillElapsed() {
    if (stillStartedAt == null || state.timeline?.clips?.[state.index]?.kind !== 'still') return;
    state = { ...state, clipElapsedMs: currentClipElapsedMs() };
    stillStartedAt = null;
  }

  function releaseActive() {
    const resource = activeResource;
    activeResource = null;
    try { resource?.release?.(); } catch (_) {}
  }

  function scheduleStill() {
    clearTimer();
    const clip = state.timeline?.clips?.[state.index];
    if (!state.playing || state.status !== 'ready' || clip?.kind !== 'still') return;
    if (stillStartedAt == null) stillStartedAt = Number(now());
    const milliseconds = Math.max(1, clipDurationMs() - Math.max(0, Number(state.clipElapsedMs) || 0));
    timer = schedule(() => {
      timer = null;
      state = { ...state, clipElapsedMs: clipDurationMs() };
      stillStartedAt = null;
      void advance(true);
    }, milliseconds);
  }

  async function loadIndex(index, keepPlaying = false) {
    if (disposed) throw new Error('timeline player is disposed');
    const timeline = state.timeline;
    if (!timeline || !Number.isInteger(index) || index < 0 || index >= timeline.clips.length) return snapshot();
    const requestId = ++sequence;
    clearTimer();
    stillStartedAt = null;
    releaseActive();
    state = { ...state, status: 'loading', issue: '', index, playing: false, frame: null, clipElapsedMs: 0 };
    emit();
    const clip = timeline.clips[index];
    try {
      let frame;
      if (clip.kind === 'motion') {
        const playback = await deps.openMotion(clip.source.assetId, { chatKey: timeline.owner.chatKey });
        if (disposed || requestId !== sequence) {
          try { playback?.release?.(); } catch (_) {}
          return snapshot();
        }
        if (!playback?.url || playback.assetId !== clip.source.assetId) {
          try { playback?.release?.(); } catch (_) {}
          throw new Error('motion source mismatch');
        }
        activeResource = playback;
        frame = {
          kind: 'motion', url: text(playback.url, 4096), assetId: clip.source.assetId,
          recordId: clip.source.recordId, posterRecordId: clip.source.posterRecordId,
          mimeType: text(playback.technical?.mimeType, 100), title: clip.title,
        };
      } else {
        const still = await deps.resolveStill(clip.source.recordId, { chatKey: timeline.owner.chatKey });
        if (disposed || requestId !== sequence) return snapshot();
        if (!still?.url || text(still.recordId, 200) !== clip.source.recordId) throw new Error('still source mismatch');
        frame = {
          kind: 'still', url: String(still.url), assetId: '', recordId: clip.source.recordId,
          posterRecordId: clip.source.posterRecordId, mimeType: '', title: clip.title,
        };
      }
      state = { ...state, status: 'ready', issue: '', index, playing: Boolean(keepPlaying), frame, clipElapsedMs: 0 };
      emit();
      scheduleStill();
      return snapshot();
    } catch (_) {
      if (disposed || requestId !== sequence) return snapshot();
      releaseActive();
      state = { ...state, status: 'error', issue: clip.kind === 'motion' ? 'timeline_motion_unavailable' : 'timeline_still_unavailable', playing: false, frame: null };
      emit();
      return snapshot();
    }
  }

  async function advance(keepPlaying = state.playing) {
    if (!state.timeline) return snapshot();
    if (state.index >= state.timeline.clips.length - 1) {
      clearTimer();
      state = { ...state, status: 'ended', issue: '', playing: false };
      emit();
      return snapshot();
    }
    return loadIndex(state.index + 1, keepPlaying);
  }

  return Object.freeze({
    async open(value = {}, options = {}) {
      if (disposed) throw new Error('timeline player is disposed');
      const validation = validateVideoTimeline(value);
      const expectedChat = text(options.chatKey || options.chat_key, 512);
      if (!validation.ok) throw new Error(`timeline player input is invalid: ${validation.issues.join(',')}`);
      if (!expectedChat || validation.timeline.owner.chatKey !== expectedChat) throw new Error('timeline player owner mismatch');
      sequence++;
      clearTimer();
      releaseActive();
      state = { ...state, status: 'idle', issue: '', timeline: validation.timeline, index: -1, playing: false, frame: null, clipElapsedMs: 0 };
      return loadIndex(0, false);
    },

    async play() {
      if (disposed || !state.timeline) return snapshot();
      if (state.status === 'ended') return loadIndex(0, true);
      if (state.status !== 'ready' || !state.frame) return snapshot();
      state = { ...state, playing: true };
      if (state.timeline.clips[state.index]?.kind === 'still') stillStartedAt = Number(now());
      emit();
      scheduleStill();
      return snapshot();
    },

    pause() {
      clearTimer();
      if (!disposed && state.playing) {
        commitStillElapsed();
        state = { ...state, playing: false };
        emit();
      }
      return snapshot();
    },

    next() {
      return advance(state.playing);
    },

    previous() {
      return loadIndex(Math.max(0, state.index - 1), state.playing);
    },

    seek(index) {
      return loadIndex(Number(index), state.playing);
    },

    ended() {
      if (state.timeline?.clips?.[state.index]?.kind !== 'motion' || !state.playing) return Promise.resolve(snapshot());
      return advance(true);
    },

    snapshot,

    dispose() {
      if (disposed) return;
      disposed = true;
      sequence++;
      clearTimer();
      releaseActive();
      state = { ...state, status: 'disposed', issue: '', timeline: null, index: -1, playing: false, frame: null, clipElapsedMs: 0 };
      stillStartedAt = null;
    },
  });
}
