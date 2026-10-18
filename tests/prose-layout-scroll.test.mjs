import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.match(source, /function proseLayoutCaptureViewport[\s\S]*querySelectorAll\('\.mes'\)[\s\S]*atBottom:/, '切换排版前必须捕获当前可见楼层与底部状态');
assert.match(source, /function proseLayoutScheduleViewportRestore[\s\S]*overflow-anchor[\s\S]*requestAnimationFrame[\s\S]*requestAnimationFrame/, '重排期间必须关闭原生锚定并等待两帧布局稳定');
assert.match(source, /snapshot\.anchor\.getBoundingClientRect[\s\S]*chat\.scrollTop \+= currentOffset - snapshot\.offset/, '非底部视口必须按同一楼层像素偏移恢复');
assert.match(source, /if \(snapshot\.atBottom\)[\s\S]*chat\.scrollHeight - chat\.clientHeight/, '原本在底部时必须继续保持底部');
assert.match(source, /function applyProseLayout[\s\S]*proseLayoutCaptureViewport\(\)[\s\S]*proseLayoutScheduleViewportRestore\(viewport\)/, '开启和取消排版必须统一走楼层锚点恢复');

console.log('Prose layout scroll anchor contract OK');

function actualFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function viewportFixture({ anchorValue = '', anchorPriority = '' } = {}) {
  const frames = new Map(); let frameId = 0;
  const properties = new Map();
  if (anchorValue) properties.set('overflow-anchor', { value: anchorValue, priority: anchorPriority });
  const chat = { isConnected: true, scrollTop: 150, scrollHeight: 1000, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    style: {
      getPropertyValue: name => properties.get(name)?.value || '',
      getPropertyPriority: name => properties.get(name)?.priority || '',
      setProperty: (name, value, priority = '') => properties.set(name, { value, priority }),
      removeProperty: name => properties.delete(name),
    },
    querySelectorAll: () => anchor.isConnected ? [anchor] : [],
  };
  const anchor = { isConnected: true, position: 180,
    getBoundingClientRect: () => ({ top: 100 + anchor.position - chat.scrollTop, bottom: 200 + anchor.position - chat.scrollTop }),
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'chat' ? chat : null },
    proseLayoutRestoreFrame: 0, proseLayoutRestoreSnapshot: null,
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(['proseLayoutCaptureViewport', 'proseLayoutCancelViewportRestore', 'proseLayoutScheduleViewportRestore'].map(actualFunction).join('\n'), context);
  function tick() {
    const current = [...frames];
    for (const [id, callback] of current) if (frames.delete(id)) callback();
  }
  return { chat, anchor, context, frames, tick, settle() { for (let count = 0; frames.size && count < 4; count++) tick(); assert.equal(frames.size, 0); },
    capture: () => context.proseLayoutCaptureViewport(),
    schedule: snapshot => context.proseLayoutScheduleViewportRestore(snapshot),
    cancel: () => context.proseLayoutCancelViewportRestore(),
    offset: () => anchor.getBoundingClientRect().top - chat.getBoundingClientRect().top,
  };
}

test('one reflow restores the same visible paragraph pixel offset after two frames', () => {
  const f = viewportFixture(), snapshot = f.capture();
  assert.equal(snapshot.offset, 30);
  f.anchor.position += 40; f.schedule(snapshot);
  assert.equal(f.chat.style.getPropertyValue('overflow-anchor'), 'none');
  f.tick(); assert.equal(f.chat.scrollTop, 150, 'first frame waits for layout');
  f.tick(); assert.equal(f.chat.scrollTop, 190); assert.equal(f.offset(), 30);
  assert.equal(f.chat.style.getPropertyValue('overflow-anchor'), ''); assert.equal(f.context.proseLayoutRestoreSnapshot, null);
});

test('rapid successive font/layout reflows keep the original offset and original anchor property', () => {
  const f = viewportFixture({ anchorValue: 'auto', anchorPriority: 'important' });
  const first = f.capture(); f.anchor.position += 20; f.schedule(first);
  const second = f.capture(); assert.equal(second.offset, 30, 'reuse the original, not already shifted, reading position');
  assert.equal(second.overflowAnchor, 'auto');
  f.anchor.position += 20; f.schedule(second); f.settle();
  assert.equal(f.offset(), 30); assert.equal(f.chat.scrollTop, 190);
  assert.equal(f.chat.style.getPropertyValue('overflow-anchor'), 'auto');
  assert.equal(f.chat.style.getPropertyPriority('overflow-anchor'), 'important');
  assert.equal(f.context.proseLayoutRestoreSnapshot, null);
});

test('cancelling before either restoration frame restores native anchoring without moving the chat', () => {
  for (const afterFirstFrame of [false, true]) {
    const f = viewportFixture({ anchorValue: 'auto' });
    f.schedule(f.capture()); if (afterFirstFrame) f.tick(); f.cancel();
    assert.equal(f.frames.size, 0); assert.equal(f.chat.scrollTop, 150);
    assert.equal(f.chat.style.getPropertyValue('overflow-anchor'), 'auto');
    assert.equal(f.chat.style.getPropertyPriority('overflow-anchor'), '');
    assert.equal(f.context.proseLayoutRestoreSnapshot, null);
  }
});

test('a disconnected chat has its temporary style restored and receives no scroll write', () => {
  const f = viewportFixture(); f.schedule(f.capture()); f.chat.isConnected = false; f.settle();
  assert.equal(f.chat.scrollTop, 150); assert.equal(f.chat.style.getPropertyValue('overflow-anchor'), '');
  assert.equal(f.context.proseLayoutRestoreSnapshot, null);
});

test('bottom readers stay at the new bottom and removed anchors use their saved scroll position', () => {
  const bottom = viewportFixture(); bottom.chat.scrollTop = 600;
  const snapshot = bottom.capture(); assert.equal(snapshot.atBottom, true);
  bottom.chat.scrollHeight = 1200; bottom.schedule(snapshot); bottom.settle(); assert.equal(bottom.chat.scrollTop, 800);
  const removed = viewportFixture(), before = removed.capture();
  removed.anchor.isConnected = false; removed.chat.scrollTop = 170; removed.schedule(before); removed.settle();
  assert.equal(removed.chat.scrollTop, 150); assert.equal(removed.chat.style.getPropertyValue('overflow-anchor'), '');
});

test('a removed pending paragraph is not reused as a new capture baseline', () => {
  const f = viewportFixture(); f.schedule(f.capture()); f.anchor.isConnected = false;
  f.chat.scrollTop = 175; const next = f.capture();
  assert.equal(next.anchor, null); assert.equal(next.scrollTop, 175); assert.equal(next.overflowAnchor, '');
  f.schedule(next); f.settle(); assert.equal(f.chat.scrollTop, 175);
  assert.equal(f.chat.style.getPropertyValue('overflow-anchor'), '');
});
