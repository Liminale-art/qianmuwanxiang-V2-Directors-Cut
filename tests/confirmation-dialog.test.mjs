import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
function setup(popupResult,{reject=false,native=false}={}){
  let prompts=0,fallbacks=0;
  const context=vm.createContext({ctx:()=>native?{}:{Popup:{show:{confirm:async()=>{prompts++;if(reject)throw Error('closed');return popupResult;}}}},
    confirm:()=>{fallbacks++;return popupResult;}});
  vm.runInContext(storyboardFunctionSource('confirmDialog'),context);
  return {call:()=>context.confirmDialog('test','synthetic'),prompts:()=>prompts,fallbacks:()=>fallbacks};
}
test('actual shared dialog accepts only exact positive popup results and preserves supported ST affirmative codes',async()=>{
  for(const value of [true,1,'1','true','OK','yes','confirm','confirmed','affirmative',' ok ']){
    const e=setup(value);assert.equal(await e.call(),true);assert.equal(e.prompts(),1);assert.equal(e.fallbacks(),0);
  }
  for(const value of [false,0,-1,10,11,'-1','10','unconfirmed','not ok','cancelled','false','no','not true','not affirmative',null,undefined,{},['ok'],{toString:()=> 'yes'}]){
    const e=setup(value);assert.equal(await e.call(),false);assert.equal(e.prompts(),1);assert.equal(e.fallbacks(),0);
  }
});
test('cancelled or rejected ST popups never cause a second native confirmation',async()=>{
  const e=setup(true,{reject:true});assert.equal(await e.call(),false);assert.equal(e.fallbacks(),0);
  for(const value of [true,false]){const native=setup(value,{native:true});assert.equal(await native.call(),value);assert.equal(native.prompts(),0);assert.equal(native.fallbacks(),1);}
});
