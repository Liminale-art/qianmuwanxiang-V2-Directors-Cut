import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

test('closing either widget stops restore work and restores originals without forgetting saved dock entries', () => {
  for (const off of ['enabled', 'quickWheelEnabled', 'floatingButton']) {
    const settings = {quickWheelEnabled:true, floatingButton:true, quickWheelDockedPlugins:[{key:'saved',selector:'#external'}]};
    const original = structuredClone(settings.quickWheelDockedPlugins), states = [], cleared = [], record = {host:{isConnected:true}};
    const context = vm.createContext({settings, quickDockRuntime:new Map([['saved',record]]),
      normalizeQuickWheelSettings(){}, quickDockSetOriginState:(...args)=>states.push(args),
      quickDockObserver:{disconnect(){cleared.push('observer');}}, quickDockShadowObservers:new Map([['shadow',{disconnect(){cleared.push('shadow');}}]]),
      quickDockRetryTimer:1, quickDockRestoreStopTimer:2, quickDockRestoreTimer:3,
      clearInterval:id=>cleared.push(id), clearTimeout:id=>cleared.push(id),
      quickDockScanStored(){states.push('scan');}, syncQuickDockOriginVisibility(){states.push('sync');},
    });
    vm.runInContext(['quickDockStopRestoreWatchers','restoreQuickDockedPlugins'].map(section).join('\n'), context);
    settings[off]=false;context.restoreQuickDockedPlugins();
    assert.deepEqual(states,[[record,'normal']]);
    assert.deepEqual(new Set(cleared),new Set(['observer','shadow',1,2,3]));
    assert.equal(context.quickDockRestoreTimer,null);
    assert.equal(context.quickDockShadowObservers.size,0);
    assert.deepEqual(settings.quickWheelDockedPlugins,original);
    states.length=0;settings[off]=true;context.restoreQuickDockedPlugins();
    assert.deepEqual(states,['scan','sync']);
    assert.deepEqual(settings.quickWheelDockedPlugins,original);
  }
});

test('a queued drop cannot attach after hive or floating entry is disabled', () => {
  for (const off of ['enabled','quickWheelEnabled','floatingButton']) {
    let pending, touched=0;
    const context=vm.createContext({settings:{quickWheelEnabled:true,floatingButton:true},
      quickDockDrag:{pointerId:7,moved:true,ready:true,host:{get isConnected(){touched++;return true;}},activator:{}},
      quickDockClearDrag(){context.quickDockDrag=null;},qianmuDockingSurfaceBusy:()=>false,setTimeout:fn=>{pending=fn;},
    });
    vm.runInContext(['quickDockAttach','quickDockOnPointerUp'].map(section).join('\n'),context);
    context.quickDockOnPointerUp({pointerId:7});assert.equal(typeof pending,'function');
    context.settings[off]=false;pending();
    assert.equal(touched,0,'late drop stops before inspecting or changing an external element');
    assert.equal(context.quickDockDrag,null);
  }
});

test('a late stored-entry scan does not normalize, look up or attach while widgets are disabled', () => {
  for (const off of ['enabled','quickWheelEnabled','floatingButton']) {
    const context=vm.createContext({settings:{quickWheelEnabled:true,floatingButton:true},normalizeQuickWheelSettings(){assert.fail('late scan');}});
    vm.runInContext(section('quickDockScanStored'),context);
    context.settings[off]=false;context.quickDockScanStored();
  }
});

test('origin visibility follows the one hive switch and floating entry switch', () => {
  const states=[],record={};
  const context=vm.createContext({settings:{},quickDockRuntime:new Map([['one',record]]),quickDockSetOriginState:(_record,state)=>states.push(state)});
  vm.runInContext(section('syncQuickDockOriginVisibility'),context);
  for (const [wheel,float,expected] of [[true,true,'hidden'],[false,true,'normal'],[true,false,'normal'],[false,false,'normal']]) {
    Object.assign(context.settings,{quickWheelEnabled:wheel,floatingButton:float});context.syncQuickDockOriginVisibility();
    assert.equal(states.at(-1),expected);
  }
  Object.assign(context.settings,{enabled:false,quickWheelEnabled:true,floatingButton:true});context.syncQuickDockOriginVisibility();
  assert.equal(states.at(-1),'normal','disabled extension cannot hide external origins');
});

test('configuration apply and undo reuse widget convergence instead of only repainting the float', () => {
  const calls=[],context=vm.createContext({settings:{},ctx:()=>({extensionSettings:{}}),MODULE_NAME:'test',
    saveSettings(){},PROSE_LAYOUT_STORAGE_KEY:'test',applyDirectorInjection(){},toast(){},
    refreshWidgetRuntime:()=>calls.push('widgets'),renderModal:()=>calls.push('modal'),
  });
  vm.runInContext(section('configApplyOptions'),context);
  context.configApplyOptions().render();
  assert.deepEqual(calls,['widgets','modal']);
});
