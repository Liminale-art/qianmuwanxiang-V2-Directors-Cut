import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {isRichProse as rich} from '../qianmu-prose-rich-compat.js';

const css=await readFile(new URL('../style.css',import.meta.url),'utf8');

test('plain prose remains formatted while regex cards and explicit rich blocks opt out',()=>{
  const selector='style, .np-min-card, [data-sd-prose-exempt], :scope > div[class] > div';
  assert.equal(rich({querySelector:value=>{assert.equal(value,selector);return null;}}),false);
  assert.equal(rich({querySelector:value=>value===selector?{}:null}),true);
  assert.match(css,/\.mes_text:not\(:has\(style, \.np-min-card, \[data-sd-prose-exempt\], > div\[class\] > div\)\)/);
});

test('line-break processing leaves a styled regex card untouched',()=>{
  let cleared=0,queried=0;
  const message={querySelector:()=>({}),children:[],querySelectorAll:()=>{queried++;return []}};
  const context=vm.createContext({proseLayoutSettings:()=>({active:true,splitBreaks:true}),proseLayoutMessageRoots:()=>[message],isRichProse:rich,proseLayoutClearBreakMarks:()=>{cleared++;}});
  vm.runInContext(section('proseLayoutMarkBreaks'),context);
  context.proseLayoutMarkBreaks({});
  assert.equal(cleared,1);assert.equal(queried,0);
});
