import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVideoTimeline } from '../qianmu-video-timeline.js';
import { createVideoTimelinePlaybackSession } from '../qianmu-video-timeline-player.js';

function timeline(selections = [
  { kind: 'motion', assetId: 'asset-a' },
  { kind: 'still', recordId: 'still-a', durationSeconds: 2 },
]) {
  const result = buildVideoTimeline({
    owner: { chatKey: 'chat-a' },
    motionItems: [{ assetId: 'asset-a', recordId: 'motion-a', owner: { chatKey: 'chat-a' }, technical: { durationSeconds: 6 } }],
    stillRecords: [{ id: 'still-a', chatKey: 'chat-a', floor: 3 }],
    selections,
  }, { now: 1000 });
  assert.equal(result.ok, true);
  return result.timeline;
}

test('opening a film loads only its first segment and releases it before the next', async () => {
  const opened = [];
  const released = [];
  const session = createVideoTimelinePlaybackSession({
    openMotion: async (assetId) => {
      opened.push(assetId);
      return { assetId, url: `blob:${assetId}`, technical: { mimeType: 'video/mp4' }, release: () => released.push(assetId) };
    },
    resolveStill: async (recordId) => ({ recordId, url: `/images/${recordId}.png` }),
  });
  const first = await session.open(timeline(), { chatKey: 'chat-a' });
  assert.deepEqual(opened, ['asset-a']);
  assert.equal(first.frame.kind, 'motion');
  const second = await session.next();
  assert.deepEqual(released, ['asset-a']);
  assert.equal(second.frame.kind, 'still');
  assert.equal(second.frame.url, '/images/still-a.png');
  session.dispose();
});

test('still playback uses its bounded duration and advances without preloading later media', async () => {
  const timers = [];
  const session = createVideoTimelinePlaybackSession({
    openMotion: async (assetId) => ({ assetId, url: `blob:${assetId}`, release() {} }),
    resolveStill: async (recordId) => ({ recordId, url: `/images/${recordId}.png` }),
    setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
  });
  await session.open(timeline([
    { kind: 'still', recordId: 'still-a', durationSeconds: 2 },
    { kind: 'motion', assetId: 'asset-a' },
  ]), { chatKey: 'chat-a' });
  await session.play();
  assert.equal(timers[0].milliseconds, 2000);
  timers[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.snapshot().index, 1);
  assert.equal(session.snapshot().frame.kind, 'motion');
  assert.equal(session.snapshot().playing, true);
  session.dispose();
});

test('still playhead remains monotonic across pause and resume for timed subtitles', async () => {
  let clock = 1000;
  const timers = [];
  const session = createVideoTimelinePlaybackSession({
    openMotion: async (assetId) => ({ assetId, url: `blob:${assetId}`, release() {} }),
    resolveStill: async (recordId) => ({ recordId, url: `/images/${recordId}.png` }),
    now: () => clock,
    setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
  });
  await session.open(timeline([
    { kind: 'still', recordId: 'still-a', durationSeconds: 2 },
    { kind: 'motion', assetId: 'asset-a' },
  ]), { chatKey: 'chat-a' });
  await session.play();
  clock = 1600;
  assert.equal(session.snapshot().clipElapsedMs, 600);
  assert.equal(session.snapshot().timelineElapsedMs, 600);
  session.pause();
  clock = 2400;
  assert.equal(session.snapshot().clipElapsedMs, 600, 'paused playhead must not drift');
  await session.play();
  assert.equal(timers.at(-1).milliseconds, 1400, 'resume schedules only the remaining still duration');
  clock = 2700;
  assert.equal(session.snapshot().clipElapsedMs, 900);
  session.dispose();
});

test('motion ended advances only while playing and the last segment stops cleanly', async () => {
  const session = createVideoTimelinePlaybackSession({
    openMotion: async (assetId) => ({ assetId, url: `blob:${assetId}`, release() {} }),
    resolveStill: async (recordId) => ({ recordId, url: `/images/${recordId}.png` }),
  });
  await session.open(timeline(), { chatKey: 'chat-a' });
  await session.ended();
  assert.equal(session.snapshot().index, 0, 'paused media endings must not move the film');
  await session.play();
  await session.ended();
  assert.equal(session.snapshot().index, 1);
  await session.next();
  assert.equal(session.snapshot().status, 'ended');
  assert.equal(session.snapshot().playing, false);
  session.dispose();
});

test('stale asynchronous media is released and disposal clears timers and URLs', async () => {
  let resolveOpen;
  let released = 0;
  const session = createVideoTimelinePlaybackSession({
    openMotion: () => new Promise((resolve) => { resolveOpen = resolve; }),
    resolveStill: async (recordId) => ({ recordId, url: `/images/${recordId}.png` }),
  });
  const opening = session.open(timeline(), { chatKey: 'chat-a' });
  session.dispose();
  resolveOpen({ assetId: 'asset-a', url: 'blob:late', release: () => { released++; } });
  await opening;
  assert.equal(released, 1);
  assert.equal(session.snapshot().status, 'disposed');
  assert.equal(session.snapshot().frame, null);
});

test('invalid ownership fails closed before any source is opened', async () => {
  let sourceCalls = 0;
  const session = createVideoTimelinePlaybackSession({
    openMotion: async () => { sourceCalls++; return null; },
    resolveStill: async () => { sourceCalls++; return null; },
  });
  await assert.rejects(() => session.open(timeline(), { chatKey: 'chat-b' }), /owner mismatch/);
  assert.equal(sourceCalls, 0);
  session.dispose();
});
