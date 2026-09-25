import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture({width=160,viewport=360,avatar=false}={}){
  const classes=new Set(),styles=new Map(),runClasses=new Set(),runStyles=new Map(),layout={active:true,contentWidth:width};let writes=0,mixed=false;
  const parent={getBoundingClientRect:()=>({left:10,right:350}),classList:{add:k=>classes.add(k),remove:k=>classes.delete(k)}};
  const message={getBoundingClientRect:()=>({left:0,right:360}),querySelector:()=>avatar?{getBoundingClientRect:()=>({left:8,right:48,bottom:80,width:40,height:60})}:null};
  const text={dataset:{},parentElement:parent,closest:()=>message,getBoundingClientRect:()=>({left:10,right:350,top:40}),classList:{add:k=>runClasses.add(k),remove:k=>runClasses.delete(k)},querySelectorAll:()=>mixed?[run]:[],style:{setProperty:(k,v)=>{writes++;styles.set(k,v);},removeProperty:k=>{writes++;styles.delete(k);}}};
  const run={dataset:{},parentElement:text,closest:()=>message,getBoundingClientRect:()=>({top:40}),style:{setProperty:(k,v)=>{writes++;runStyles.set(k,v);},removeProperty:k=>{writes++;runStyles.delete(k);}}};
  const chat={getBoundingClientRect:()=>({left:0,right:360})};
  const context=vm.createContext({document:{getElementById:()=>chat},window:{innerWidth:viewport},getComputedStyle:()=>({paddingLeft:'20px',paddingRight:'40px'}),proseLayoutSettings:()=>layout,proseLayoutMessageRoots:()=>[text],proseLayoutTargets:()=>mixed?[run]:[text]});
  vm.runInContext(section('proseLayoutClearExpandedWidth')+section('proseLayoutUpdateWidth'),context);
  return {layout,context,classes,styles,text,run,runStyles,runClasses,writes:()=>writes,update:()=>context.proseLayoutUpdateWidth(),enableMixed:()=>{context.proseLayoutClearExpandedWidth(text);mixed=true;text.dataset.sdProseMixed='1';}};
}
test('mobile width above 80 gradually releases actual theme space up to viewport without changing font or offset',()=>{
  const e=fixture();e.update();assert.equal(e.styles.get('--sd-prose-expanded-width'),'358.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'29.00px');assert.equal(e.styles.get('--sd-prose-expand-right'),'49.00px');
  e.layout.contentWidth=120;e.update();assert.equal(e.styles.get('--sd-prose-expanded-width'),'319.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'14.50px');
  assert.deepEqual([...e.styles.keys()].sort(),['--sd-prose-expand-left','--sd-prose-expand-right','--sd-prose-expanded-width'].sort());
});
test('adjacent visible avatar remains protected even at maximum width',()=>{
  const e=fixture({avatar:true});e.update();assert.equal(e.styles.get('--sd-prose-expand-left'),'-20.00px');assert.equal(e.styles.get('--sd-prose-expand-right'),'49.00px');
});
test('normal widths and desktop do not write per-message styles; reset removes only owned overrides',()=>{
  for(const options of [{width:80},{viewport:1100}]){const e=fixture(options);e.update();assert.equal(e.writes(),0);}
  const e=fixture();e.update();e.layout.active=false;e.update();assert.equal(e.styles.size,0);assert.equal(e.classes.size,0);assert.equal(e.text.dataset.sdProseExpanded,undefined);
  const writes=e.writes();e.update();assert.equal(e.writes(),writes);
});
test('visual viewport and chat bounds limit added space, including shifted or zoomed viewport',()=>{
  const e=fixture();e.context.window.visualViewport={offsetLeft:20,width:320};e.update();assert.equal(e.styles.get('--sd-prose-expanded-width'),'318.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'9.00px');
  e.context.window.visualViewport={offsetLeft:50,width:260};e.update();assert.equal(e.styles.get('--sd-prose-expanded-width'),'258.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'-21.00px');
});
test('when a card joins the floor, only the ordinary run expands and the card keeps its parent width',()=>{
  const e=fixture();e.update();assert.equal(e.text.dataset.sdProseExpanded,'1');
  e.enableMixed();e.update();
  assert.equal(e.text.dataset.sdProseExpanded,undefined);assert.equal(e.styles.size,0);assert.equal(e.classes.size,0);
  assert.equal(e.run.dataset.sdProseExpanded,'1');assert.equal(e.runStyles.get('--sd-prose-expanded-width'),'358.00px');
  assert.equal(e.runClasses.has('sd-prose-expand-host'),true);
});
