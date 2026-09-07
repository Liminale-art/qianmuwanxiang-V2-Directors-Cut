import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture({width=160,viewport=360,avatar=false}={}){
  const classes=new Set(),styles=new Map(),layout={active:true,contentWidth:width};let writes=0;
  const parent={getBoundingClientRect:()=>({left:10,right:350}),classList:{add:k=>classes.add(k),remove:k=>classes.delete(k)}};
  const message={getBoundingClientRect:()=>({left:0,right:360}),querySelector:()=>avatar?{getBoundingClientRect:()=>({left:8,right:48,bottom:80,width:40,height:60})}:null};
  const text={dataset:{},parentElement:parent,closest:()=>message,getBoundingClientRect:()=>({top:40}),style:{setProperty:(k,v)=>{writes++;styles.set(k,v);},removeProperty:k=>{writes++;styles.delete(k);}}};
  const chat={getBoundingClientRect:()=>({left:0,right:360})};
  const context=vm.createContext({document:{getElementById:()=>chat},window:{innerWidth:viewport},getComputedStyle:()=>({paddingLeft:'20px',paddingRight:'40px'}),proseLayoutSettings:()=>layout,proseLayoutMessageRoots:()=>[text]});
  vm.runInContext(section('proseLayoutClearExpandedWidth')+section('proseLayoutUpdateWidth'),context);
  return {layout,context,classes,styles,text,writes:()=>writes,run:()=>context.proseLayoutUpdateWidth()};
}
test('mobile width above 80 gradually releases actual theme space up to viewport without changing font or offset',()=>{
  const e=fixture();e.run();assert.equal(e.styles.get('--sd-prose-expanded-width'),'358.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'29.00px');assert.equal(e.styles.get('--sd-prose-expand-right'),'49.00px');
  e.layout.contentWidth=120;e.run();assert.equal(e.styles.get('--sd-prose-expanded-width'),'319.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'14.50px');
  assert.deepEqual([...e.styles.keys()].sort(),['--sd-prose-expand-left','--sd-prose-expand-right','--sd-prose-expanded-width'].sort());
});
test('adjacent visible avatar remains protected even at maximum width',()=>{
  const e=fixture({avatar:true});e.run();assert.equal(e.styles.get('--sd-prose-expand-left'),'-20.00px');assert.equal(e.styles.get('--sd-prose-expand-right'),'49.00px');
});
test('normal widths and desktop do not write per-message styles; reset removes only owned overrides',()=>{
  for(const options of [{width:80},{viewport:1100}]){const e=fixture(options);e.run();assert.equal(e.writes(),0);}
  const e=fixture();e.run();e.layout.active=false;e.run();assert.equal(e.styles.size,0);assert.equal(e.classes.size,0);assert.equal(e.text.dataset.sdProseExpanded,undefined);
  const writes=e.writes();e.run();assert.equal(e.writes(),writes);
});
test('visual viewport and chat bounds limit added space, including shifted or zoomed viewport',()=>{
  const e=fixture();e.context.window.visualViewport={offsetLeft:20,width:320};e.run();assert.equal(e.styles.get('--sd-prose-expanded-width'),'318.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'9.00px');
  e.context.window.visualViewport={offsetLeft:50,width:260};e.run();assert.equal(e.styles.get('--sd-prose-expanded-width'),'258.00px');assert.equal(e.styles.get('--sd-prose-expand-left'),'-21.00px');
});
