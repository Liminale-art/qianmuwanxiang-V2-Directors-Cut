import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFocusLock,FOCUS_LOCK_MAX_MS} from '../qianmu-focus-lock.js';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

test('locking requires confirmation and starts exactly one bounded round',async()=>{
  const {c,f,calls}=focusFixture();c.confirmDialog=async()=>false;await c.focusClockEnableLock();assert.equal(f.status,'idle');assert.equal(f.lock,null);
  c.confirmDialog=async()=>true;await c.focusClockEnableLock();assert.equal(f.status,'running');assert.equal(f.lock.endsAt,f.endsAt);assert.equal(f.lock.owner,'device');
  assert.equal(calls.filter(x=>x==='attach').length,1);assert.equal(inspectFocusLock(f,'device',100001).active,true);
});
test('active locks block pause, reset and re-lock without changing the timer deadline',async()=>{
  const {c,f}=focusFixture();await c.focusClockEnableLock();const deadline=f.endsAt;
  c.focusClockPause();assert.equal(f.status,'running');c.focusClockReset();assert.equal(f.status,'running');await c.focusClockEnableLock();assert.equal(f.status,'running');assert.equal(f.endsAt,deadline);
});
test('lock ownership does not enrol another browser tab or device',async()=>{
  const {c,f}=focusFixture();await c.focusClockEnableLock();assert.equal(inspectFocusLock(f,'other',100001).active,false);
});
test('expiration records completion once and cannot auto-start a second locked round',async()=>{
  const {c,f,setNow}=focusFixture({autoStartNext:true});await c.focusClockEnableLock();setNow(f.endsAt+1000);c.focusClockComplete();c.focusClockComplete();
  assert.equal(f.history.length,1);assert.equal(f.lock,null);assert.equal(f.status,'idle');assert.equal(f.phase,'shortBreak');
});
test('malformed or unbounded locks are rejected instead of trapping the interface indefinitely',async()=>{
  for(const change of [{endsAt:Infinity},{startedAt:Infinity},{endsAt:100000+FOCUS_LOCK_MAX_MS+1},{token:'wrong'},{version:9}]){
    const {c,f}=focusFixture();await c.focusClockEnableLock();Object.assign(f.lock,change);
    assert.equal(inspectFocusLock(f,'device',100000).reason,'invalid');
  }
});
test('reading begins only after the selected page actually exists, not during lazy load or missing content',async()=>{
  const {c,f}=focusFixture({activity:'reading',bookId:'book'});let release;const wait=new Promise(r=>release=r);
  c.ensureCoreadReaderRuntime=()=>wait;
  c.coreadOpenBook=async()=>{c.activeTab='coread';c.readerView={bookId:'book',companionAvatar:'A',companionScope:'scope',userPersona:{key:'U'}};c.readerContentCache={bookId:'book'};c.document.querySelector=()=>({isConnected:true});};
  const start=c.focusClockRequestStart({locked:true});assert.equal(f.status,'idle');assert.equal(f.endsAt,0);release();await start;
  assert.equal(f.status,'running');assert.equal(f.lock.reader.avatar,'A');assert.equal(f.sessionBookId,'book');
  const absent=focusFixture({activity:'reading',bookId:'book'});await absent.c.focusClockRequestStart({locked:true});assert.equal(absent.f.status,'idle');assert.equal(absent.f.lock,null);
});
test('failed loading or leaving the page cancels preparation without consuming a round',async()=>{
  const {c,f}=focusFixture({activity:'reading',bookId:'book'});c.ensureCoreadReaderRuntime=async()=>{throw Error('offline');};
  await c.focusClockRequestStart({locked:true});assert.equal(f.status,'idle');assert.equal(c.focusClockEntryBusy,false);
  c.ensureCoreadReaderRuntime=async()=>{c.activeTab='imagegen';};await c.focusClockRequestStart();assert.equal(f.status,'idle');
});
test('duplicate starts while opening a book do not submit a second opening',async()=>{
  const {c}=focusFixture({activity:'reading',bookId:'book'});let release,count=0;
  c.focusClockEnterReading=()=>{count++;return new Promise(r=>release=r);};
  const first=c.focusClockRequestStart();await c.focusClockRequestStart();assert.equal(count,1);release(false);await first;
});
test('the reader timer suspends only the portal and does not reset identity or dialogue owner',()=>{
  const {c,calls}=focusFixture();const view={bookId:'book',companionAvatar:'A',chapterIndex:2,scrollRatio:.7};c.readerView=view;
  c.focusClockShowPanel();assert.equal(c.readerView,view);assert.equal(c.activeTab,'focus');assert.ok(calls.includes('unmount'));
  assert.doesNotMatch(section('focusClockShowPanel'),/coreadCloseReader|readerView = null|coreadLoadDialog/);
});
test('a failed reading restoration releases the lock and pauses ordinary timing',async()=>{
  const {c,f}=focusFixture();await c.focusClockEnableLock();f.lock.activity='reading';f.lock.bookId='book';f.sessionBookId='book';
  c.focusClockEnterReading=async()=>false;await c.focusClockRestoreLock();assert.equal(f.lock,null);assert.equal(f.status,'paused');
});
test('refreshing an active task keeps the original deadline and installs the guard without re-starting',async()=>{
  const {c,f}=focusFixture();await c.focusClockEnableLock();const deadline=f.endsAt;const token=f.sessionToken;
  await c.focusClockRestoreLock();assert.equal(f.endsAt,deadline);assert.equal(f.sessionToken,token);
});
test('ordinary focus still supports pause, resume and reset when the user did not lock it',()=>{
  const {c,f,setNow}=focusFixture();c.focusClockStart();setNow(160000);c.focusClockPause();assert.equal(f.status,'paused');assert.equal(f.remainingMs,24*60000);
  c.focusClockStart();assert.equal(f.status,'running');c.focusClockReset();assert.equal(f.status,'idle');
});
test('navigation entry points cannot bypass the lock and teardown releases DOM isolation',()=>{
  for(const name of ['closeModal','coreadCloseReader']) assert.match(section(name),/focusClockBlockExit\(\)/);
  assert.match(section('focusClockSession'),/blocks: \(\) => focusClockBlockExit\(\)/);
  assert.match(section('renderModal'),/focusClockActiveLock\(\)/);assert.match(section('coreadOpenBook'),/readingLock.bookId !== bookId/);
  assert.match(section('stopFocusClockRuntime'),/focusClockLockGuard\?\.dispose\(\)/);
});

test('leaving ordinary reading pauses and returning to the same loaded book resumes remaining time',()=>{
  const {c,f,setNow}=focusFixture({activity:'reading',bookId:'book',sessionBookId:'book',status:'running',endsAt:160000,sessionToken:'same-round'});
  c.readerView={bookId:'book'};c.readerContentCache={bookId:'book'};c.activeTab='coread';c.document.querySelector=()=>({isConnected:true});
  setNow(110000);c.focusClockPauseForReadingExit();assert.equal(f.status,'paused');assert.equal(f.remainingMs,50000);assert.equal(f.readingExitPaused,true);
  setNow(200000);c.focusClockResumeReading();assert.equal(f.status,'running');assert.equal(f.endsAt,250000);assert.equal(f.sessionToken,'same-round');assert.equal(f.readingExitPaused,false);
});
test('manual pause, another book, rest phases and ordinary task focus are not automatically resumed or paused',()=>{
  const {c,f}=focusFixture({status:'paused',activity:'reading',bookId:'book',sessionBookId:'book'});c.readerView={bookId:'book'};
  c.focusClockResumeReading();assert.equal(f.status,'paused');
  f.readingExitPaused=true;c.readerView.bookId='other';c.focusClockResumeReading();assert.equal(f.status,'paused');
  for(const changes of [{activity:'task',phase:'focus'},{activity:'reading',phase:'shortBreak'}]){
    Object.assign(f,{status:'running',endsAt:160000},changes);c.readerView.bookId='book';c.focusClockPauseForReadingExit();assert.equal(f.status,'running');
  }
});
test('viewing the timer in strong-locked reading cannot pause the locked round',async()=>{
  const {c,f}=focusFixture();await c.focusClockEnableLock();f.activity='reading';f.sessionBookId='book';c.readerView={bookId:'book'};
  c.focusClockShowPanel();assert.equal(f.status,'running');assert.equal(f.readingExitPaused,false);
});
test('accepted reading exits pause before losing the book identity; render-only reading updates do not pause',()=>{
  assert.match(section('coreadCloseReader'),/focusClockPauseForReadingExit\(\)[\s\S]*readerView = null/);
  assert.match(section('closeModal'),/focusClockPauseForReadingExit\(\)/);
  assert.match(section('renderModal'),/if \(activeTab !== 'coread'\) focusClockPauseForReadingExit\(\)/);
  assert.match(section('coreadOpenBook'),/refreshReaderPortal\(\);\s*focusClockResumeReading\(\)/);
});
