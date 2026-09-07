import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

function fixture(ids = ['a', 'b', 'c']) {
  const doc = { body: {}, activeElement: null }; doc.activeElement = doc.body;
  const calls = [], reel = { scrollLeft: 110, clientWidth: 200, getBoundingClientRect: () => ({ left: 10, right: 210 }),
    scrollTo(value) { calls.push(value); this.scrollLeft = value.left; } };
  const figures = ids.map((id, index) => {
    const figure = { dataset: { storyboardRecord: id }, classList: { add: value => { figure.open = value; } },
      getBoundingClientRect: () => ({ left: 10 + index * 170 - reel.scrollLeft, right: 170 + index * 170 - reel.scrollLeft }) };
    const buttons = ['toggle-actions', 'copy'].map(action => ({ dataset: { storyboardChatAction: action },
      closest: () => figure, setAttribute: (name, value) => calls.push([id, action, name, value]),
      focus: options => { calls.push(['focus', id, action, options]); doc.activeElement = buttons.find(button => button.dataset.storyboardChatAction === action); } }));
    figure.buttons = buttons;
    figure.querySelectorAll = () => buttons;
    figure.actions = { style: { transition: 'opacity .2s' }, setAttribute: (name, value) => calls.push([id, 'actions', name, value]) };
    Object.defineProperty(figure.actions, 'offsetWidth', { get() { calls.push(['menu-layout', id, figure.actions.style.transition]); return 100; } });
    figure.querySelector = selector => selector.includes('toggle-actions') ? buttons[0] : figure.actions;
    return figure;
  });
  reel.querySelectorAll = () => figures;
  const wrapper = { querySelector: selector => selector.includes('reel') ? reel : figures.find(figure => figure.open),
    querySelectorAll: () => figures.flatMap(figure => figure.buttons), contains: element => figures.some(figure => figure.buttons.includes(element)) };
  const context = vm.createContext({ document: doc });
  vm.runInContext([section('storyboardCaptureInlineView'), section('storyboardRestoreInlineView')].join('\n'), context);
  return { doc, calls, figures, reel, wrapper, context };
}

test('capture uses the most visible image and keeps horizontal offset, open actions and keyboard focus', () => {
  const f = fixture(); f.figures[1].open = true; f.doc.activeElement = f.figures[1].buttons[1];
  const view = f.context.storyboardCaptureInlineView(f.wrapper);
  assert.equal(view.recordId, 'b'); assert.equal(view.offset, 60); assert.equal(view.recordIndex, 1);
  assert.equal(view.openRecordId, 'b'); assert.equal(view.focusRecordId, 'b'); assert.equal(view.focusAction, 'copy');
});

test('earlier arriving images do not reset the reading position and replacement restores focus without page scrolling', () => {
  const old = fixture(); old.figures[1].open = true; old.doc.activeElement = old.figures[1].buttons[1];
  const view = old.context.storyboardCaptureInlineView(old.wrapper);
  const fresh = fixture(['new', 'a', 'b', 'c']); fresh.reel.scrollLeft = 0;
  fresh.context.storyboardRestoreInlineView(fresh.wrapper, view);
  assert.equal(fresh.reel.scrollLeft, 280);
  assert.equal(fresh.figures[2].open, 'actions-open');
  assert.equal(fresh.doc.activeElement, fresh.figures[2].buttons[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.calls.at(-1))), ['focus', 'b', 'copy', { preventScroll: true }]);
});

test('removed image falls back to the nearest surviving display index and never restores a removed action', () => {
  const old = fixture(); old.figures[1].open = true; old.doc.activeElement = old.figures[1].buttons[1];
  const view = old.context.storyboardCaptureInlineView(old.wrapper), fresh = fixture(['a', 'c']); fresh.reel.scrollLeft = 0;
  fresh.context.storyboardRestoreInlineView(fresh.wrapper, view);
  assert.equal(fresh.reel.scrollLeft, 110); assert.equal(fresh.doc.activeElement, fresh.doc.body);
  assert.equal(fresh.figures.some(figure => figure.open), false);
});

test('restored menus bypass the initial hidden transition before focus and retain theme animation settings', () => {
  const f = fixture();
  f.context.storyboardRestoreInlineView(f.wrapper, { recordId: 'b', recordIndex: 1, offset: 0, scrollLeft: 0,
    openRecordId: 'b', focusRecordId: 'b', focusAction: 'copy' });
  assert.equal(f.figures[1].actions.style.transition, 'opacity .2s');
  assert.deepEqual(f.calls.find(item => item[0] === 'menu-layout'), ['menu-layout', 'b', 'none']);
  assert.ok(f.calls.findIndex(item => item[0] === 'menu-layout') < f.calls.findIndex(item => item[0] === 'focus'));
});

test('restore cannot steal focus from another input and does not persist any view data', () => {
  const f = fixture(), outside = {}; f.doc.activeElement = outside;
  const view = { recordId: 'b', recordIndex: 1, offset: 0, scrollLeft: 0, focusRecordId: 'b', focusAction: 'copy' };
  f.context.storyboardRestoreInlineView(f.wrapper, view);
  assert.equal(f.doc.activeElement, outside);
  assert.doesNotMatch(section('storyboardCaptureInlineView') + section('storyboardRestoreInlineView'), /localStorage|saveSettings|saveMetadata|snapshot|fetch\(/);
});

test('collapsed or empty reels tolerate missing geometry and no pictures', () => {
  const f = fixture(); f.reel.clientWidth = 0;
  f.context.storyboardRestoreInlineView(f.wrapper, { scrollLeft: 72, recordIndex: 0 }); assert.equal(f.reel.scrollLeft, 72);
  assert.equal(f.context.storyboardCaptureInlineView(null), null);
  const empty = fixture([]); empty.context.storyboardRestoreInlineView(empty.wrapper, { scrollLeft: 0, recordIndex: 0 });
  assert.equal(empty.reel.scrollLeft, 0);
});

test('disposing one wrapper only releases videos belonging to that wrapper', () => {
  const released = [], removed = [], playbacks = new Map(['a', 'b', 'c'].map(id => [id, { floor: id === 'c' ? 4 : 3,
    video: { pause: () => released.push(id), remove() {} }, playback: { release: () => removed.push(id) } }]));
  const context = vm.createContext({ storyboardInlineVideoPlaybacks: playbacks });
  vm.runInContext([section('storyboardReleaseInlineVideoPlaybacks'), section('storyboardDisposeInlineWrapper')].join('\n'), context);
  context.storyboardDisposeInlineWrapper({ querySelectorAll: () => [{ dataset: { storyboardRecord: 'a' } }], remove() { removed.push('wrapper'); } });
  assert.deepEqual(released, ['a']); assert.deepEqual(removed, ['a', 'wrapper']); assert.deepEqual([...playbacks.keys()], ['b', 'c']);
  context.storyboardReleaseInlineVideoPlaybacks(3); assert.deepEqual([...playbacks.keys()], ['c']);
  context.storyboardReleaseInlineVideoPlaybacks(); assert.equal(playbacks.size, 0);
});

test('unchanged inline markup is compared before any new element or image is parsed; ownership and removal stay scoped', () => {
  const render = section('storyboardRenderInlineImages');
  assert.ok(render.indexOf('const reusable =') < render.indexOf("document.createElement('div')"));
  assert.match(render, /const wrapper = reusable \? old : document.createElement/);
  assert.match(render, /old\?\.dataset.storyboardChatKey === currentChatKey/);
  assert.match(render, /existing.forEach\(storyboardDisposeInlineWrapper\)/);
  assert.doesNotMatch(render, /storyboardReleaseInlineVideoPlaybacks\(scopedFloor\)/);
  assert.match(section('storyboardInsertInlineWrapper'), /tail.nextElementSibling !== wrapper/);
});
