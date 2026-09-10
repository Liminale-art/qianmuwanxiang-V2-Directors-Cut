import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const e=focusFixture({activity:'reading',bookId:'book'}),{c}=e;
  Object.assign(c,{MODAL_ID:'modal',coreadOpenRequestId:0,focusClockCloseVoiceDrawer:()=>{},unmountTheaterFullscreen:()=>{},
    coreadMemoryWrites:0,coreadIdentitySwitchBusy:false,coreadWorldSyncBusy:false,coreadDistilling:false,coreadAutoTextInFlight:false,
    coreadStopDialog:()=>{},coreadStopAssistant:()=>{},coreadClearPendingChatImages:()=>{},coreadComicVisionAbort:null,
    coreadComicVisionBusy:false,coreadAssistantConfig:()=>({historyMode:'session'}),coreadStoreAssistantHistory:()=>{}});
  c.document.getElementById=()=>({classList:{remove:()=>{}}});c.document.body={classList:{remove:()=>{}}};
  vm.runInContext(['closeModal','coreadCloseReader'].map(section).join('\n'),c);return e;
}

test('accepted page exits cancel old reading admission even after the same page reopens',async()=>{
  for(const exit of ['closeModal','coreadCloseReader']){
    const {c,f}=fixture(),loads=[];let opens=0;
    c.ensureCoreadReaderRuntime=()=>new Promise(resolve=>loads.push(resolve));
    c.coreadOpenBook=async()=>{opens++;c.activeTab='coread';c.readerView={bookId:'book'};c.readerContentCache={bookId:'book'};c.document.querySelector=()=>({isConnected:true});};
    const old=c.focusClockRequestStart(),before=JSON.stringify(f);c[exit]();
    assert.equal(JSON.stringify(f),before,'leaving a pending start must not consume a round');
    assert.equal(c.coreadOpenRequestId,1,'accepted exit invalidates pending book reads too');
    c.activeTab='focus';const next=c.focusClockRequestStart();assert.equal(loads.length,2,exit);
    loads[0]();await old;assert.equal(opens,0);assert.equal(f.status,'idle');assert.equal(c.focusClockEntryBusy,true);
    loads[1]();await next;assert.equal(opens,1);assert.equal(f.status,'running');assert.equal(c.focusClockEntryBusy,false);
  }
});

test('old lock consent cannot restart after closing and reopening the focus page',async()=>{
  const {c,f}=fixture(),answers=[];f.activity='task';c.confirmDialog=()=>new Promise(resolve=>answers.push(resolve));
  const old=c.focusClockEnableLock();c.closeModal();const next=c.focusClockEnableLock();
  assert.equal(answers.length,2);answers[0](true);await old;assert.equal(f.status,'idle');assert.equal(c.focusClockLockConfirming,true);
  answers[1](true);await next;assert.equal(f.status,'running');assert.ok(f.lock);
});

test('blocked exits preserve the current admission and lock; memory-save refusal is not navigation',()=>{
  for(const exit of ['closeModal','coreadCloseReader']){
    const {c}=fixture();c.focusClockEntryBusy=true;c.focusClockLockConfirming=true;c.focusClockBlockExit=()=>true;
    c[exit]();assert.equal(c.focusClockEntryEpoch,0);assert.equal(c.coreadOpenRequestId,0);assert.equal(c.focusClockEntryBusy,true);assert.equal(c.focusClockLockConfirming,true);
  }
  const {c}=fixture();c.coreadMemoryWrites=1;c.focusClockEntryBusy=true;c.coreadCloseReader();
  assert.equal(c.focusClockEntryEpoch,0);assert.equal(c.coreadOpenRequestId,0);assert.equal(c.focusClockEntryBusy,true);
});
