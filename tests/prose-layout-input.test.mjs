import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const constants=source.slice(source.indexOf('const PROSE_LAYOUT_DEFAULTS ='),source.indexOf('const PROSE_LAYOUT_STORAGE_KEY ='));
function fixture(key,initial){
  const layout={[key]:initial};let applied=0,persisted=0;
  const field=type=>{let value=String(initial),writes=0;const listeners=new Map();return {
    type,dataset:{proseKey:key},get value(){return value;},set value(next){value=next;writes++;},get writes(){return writes;},
    draft(next){value=next;},addEventListener(name,listener){listeners.set(name,listener);},emit(name,event={}){listeners.get(name)?.(event);},blur(){this.emit('blur');}
  };};
  const range=field('range'),number=field('number'),root={querySelectorAll:()=>[range,number]};
  const context=vm.createContext({proseLayoutSettings:()=>layout,applyProseLayout:()=>applied++,persistProseLayout:()=>persisted++});
  vm.runInContext(constants+section('proseLayoutFormatValue')+section('bindFloorProseNumberControls'),context);context.bindFloorProseNumberControls(root);
  return {layout,range,number,applied:()=>applied,persisted:()=>persisted,type(value){number.draft(value);number.emit('input');}};
}
test('width drafts can be cleared and typed from 1 through 16 to 160 without clamping or caret-buffer replacement',()=>{
  const e=fixture('contentWidth',80);
  for(const text of ['','1','16']){e.type(text);assert.equal(e.number.value,text);assert.equal(e.layout.contentWidth,80);assert.equal(e.number.writes,0);}
  e.type('160');assert.equal(e.number.value,'160');assert.equal(e.layout.contentWidth,160);assert.equal(e.range.value,'160');
  assert.equal(e.number.writes,0);assert.equal(e.applied(),1);assert.equal(e.persisted(),1);
});
test('middle-digit deletion and insertion never assign back to the active numeric input',()=>{
  const e=fixture('contentWidth',120);e.type('12');assert.equal(e.layout.contentWidth,120);e.type('128');assert.equal(e.layout.contentWidth,128);
  assert.equal(e.number.value,'128');assert.equal(e.number.writes,0);assert.equal(e.persisted(),1);
});
test('decimal and negative drafts stay intact until commit, including trailing zeros and zero itself',()=>{
  const e=fixture('horizontalOffset',2.5);
  for(const text of ['','-','-.']){e.type(text);assert.equal(e.layout.horizontalOffset,2.5);assert.equal(e.number.writes,0);}
  e.type('-0.');assert.equal(e.number.value,'-0.');e.type('-0.50');assert.equal(e.number.value,'-0.50');assert.equal(e.layout.horizontalOffset,-.5);assert.equal(e.number.writes,0);
  e.number.emit('change');assert.equal(e.number.value,'-0.5');assert.equal(e.number.writes,1);e.number.emit('blur');assert.equal(e.number.writes,1);
  e.type('0');assert.equal(e.layout.horizontalOffset,0);
});
test('commit clamps out-of-range drafts and restores the last valid value for empty or nonfinite text without default resets',()=>{
  const e=fixture('contentWidth',120);e.type('3');assert.equal(e.number.value,'3');assert.equal(e.layout.contentWidth,120);
  e.number.emit('blur');assert.equal(e.layout.contentWidth,36);assert.equal(e.number.value,'36');
  e.type('999');assert.equal(e.layout.contentWidth,36);e.number.emit('change');assert.equal(e.layout.contentWidth,160);
  for(const invalid of ['','-','1e999','invalid']){e.type(invalid);e.number.emit('blur');assert.equal(e.number.value,'160');assert.equal(e.layout.contentWidth,160);}
});
test('formatting is delayed until finishing the field and identical live values cause no layout or save churn',()=>{
  const e=fixture('lineHeight',1.8);e.type('1.8000');assert.equal(e.number.value,'1.8000');assert.equal(e.applied(),0);assert.equal(e.persisted(),0);
  e.number.emit('blur');assert.equal(e.number.value,'1.8');assert.equal(e.applied(),0);
  e.type('1.835');assert.equal(e.number.value,'1.835');assert.equal(e.layout.lineHeight,1.835);
  e.number.emit('blur');assert.equal(e.number.value,'1.83');assert.equal(e.layout.lineHeight,1.83);
});
test('IME composition is not interrupted and Enter commits only after composition has finished',()=>{
  const e=fixture('fontSize',18);e.number.emit('compositionstart');e.type('24');e.number.emit('change');
  e.number.emit('keydown',{key:'Enter',preventDefault:()=>assert.fail('composition must not close keyboard')});assert.equal(e.layout.fontSize,18);
  e.number.emit('compositionend');assert.equal(e.layout.fontSize,24);assert.equal(e.number.writes,0);
  e.number.draft('99');let prevented=false;e.number.emit('keydown',{key:'Enter',preventDefault:()=>prevented=true});
  assert.equal(prevented,true);assert.equal(e.layout.fontSize,32);assert.equal(e.number.value,'32');
  e.number.draft('20');e.number.emit('input',{isComposing:true});assert.equal(e.layout.fontSize,32);
});
test('slider still previews and saves immediately, with paired input updated and no duplicate work on change',()=>{
  const e=fixture('contentWidth',80);e.range.draft('142');e.range.emit('input');assert.equal(e.layout.contentWidth,142);assert.equal(e.number.value,'142');
  assert.equal(e.applied(),1);assert.equal(e.persisted(),1);e.range.emit('change');assert.equal(e.applied(),1);assert.equal(e.persisted(),1);
});
test('the actual floor navigator uses this single binding path, with no old per-keystroke numeric setter',()=>{
  const open=section('openFloorNavigator');assert.match(open,/bindFloorProseNumberControls\(root\)/);assert.doesNotMatch(open,/setProseNumber|control\.addEventListener\('input'/);
});
