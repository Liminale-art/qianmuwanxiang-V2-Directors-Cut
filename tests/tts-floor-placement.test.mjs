import test from 'node:test';
import assert from 'node:assert/strict';
import {gridRowAfter, followTextOrder} from '../features/tts/qianmu-tts-floor-ui.js';

test('grid row after text row', () => {
  assert.equal(gridRowAfter('auto', 'auto'), '');
  assert.equal(gridRowAfter('3', 'auto'), '4');
  assert.equal(gridRowAfter('2', 'span 2'), '4');
  assert.equal(gridRowAfter('2', '5'), '5');
  assert.equal(gridRowAfter('text', 'text'), 'text-end');
});

test('toolbar mirrors theme order of .mes_text', () => {
  const mk = () => { const props = {}; return {props, style: {setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; }}}; };
  const toolbar = mk(); const bar = mk();
  const textEl = {ownerDocument: {defaultView: {getComputedStyle: () => ({order: '2', gridRowStart: '3', gridRowEnd: 'auto'})}}};
  followTextOrder(textEl, [toolbar, bar, null]);
  assert.deepEqual(toolbar.props, {order: '2', 'grid-row-start': '4'});
  assert.deepEqual(bar.props, {order: '2', 'grid-row-start': '5'});
  const plain = {ownerDocument: {defaultView: {getComputedStyle: () => ({order: '0', gridRowStart: 'auto', gridRowEnd: 'auto'})}}};
  followTextOrder(plain, [toolbar]);
  assert.deepEqual(toolbar.props, {});
});
