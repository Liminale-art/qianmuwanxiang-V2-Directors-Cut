import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlainTextRangeMapper as mapper} from '../qianmu-plain-text-range.js';

test('CRLF selections map exactly to original text including emoji and lone CR without rewriting source',()=>{
  const source='前\r\n正文😀\r下一行\r\n后',display=source.replace(/\r\n/g,'\n').replace(/\r/g,'\n'),m=mapper(source);
  const start=display.indexOf('正文'),end=display.indexOf('后');assert.equal(source.slice(m.toSource(start),m.toSource(end)),'正文😀\r下一行\r\n');
  for(let i=0;i<=display.length;i++)assert.equal(m.toDisplay(m.toSource(i)),i);assert.equal(m.toSource(display.length),source.length);
});
test('ordinary text, empty input and consecutive CRLF preserve valid outer boundaries',()=>{
  for(const source of ['', 'abc', '\r\n\r\n', '\r\r\n\n']){const m=mapper(source),display=source.replace(/\r\n/g,'\n');
    assert.equal(m.toSource(0),0);assert.equal(m.toSource(display.length),source.length);assert.equal(m.isBoundary(0),true);assert.equal(m.isBoundary(source.length),true);assert.ok(Object.isFrozen(m));
  }
});
test('half-surrogate selection boundaries and invalid offsets are rejected without clamping or coercion',()=>{
  const m=mapper('a😀z');assert.equal(m.isBoundary(2),false);assert.equal(m.isBoundary(1),true);assert.equal(m.isBoundary(3),true);
  for(const value of [-1,5,1.5,'1',NaN,Infinity]){assert.throws(()=>m.toSource(value),RangeError);assert.throws(()=>m.toDisplay(value),RangeError);assert.equal(m.isBoundary(value),false);}
  assert.throws(()=>mapper(null),TypeError);
});
