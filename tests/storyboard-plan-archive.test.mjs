import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { STORYBOARD_SCHEMA_VERSION, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const store = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

test('terminal storyboard plans use an additive private archive store', () => {
  assert.equal(STORYBOARD_SCHEMA_VERSION, 24);
assert.match(store, /const DB_VERSION = 15/);
  assert.match(store, /STORE_STORYBOARD_PLAN_ARCHIVES = 'storyboard_plan_archives'/);
  assert.match(store, /onupgradeneeded[\s\S]*createObjectStore\(STORE_STORYBOARD_PLAN_ARCHIVES\)/);
  assert.match(store, /STORE_STORYBOARD_PLAN_ARCHIVES\]: \{[^}]*recoverable: false/);
  assert.match(store, /CHAT_SCOPED_CLEARABLE_STORES[\s\S]*STORE_STORYBOARD_PLAN_ARCHIVES/);
});

test('plan archive writes commit as one transaction and reads stay bounded', () => {
  const write = store.slice(store.indexOf('export async function putStoryboardPlanArchives'), store.indexOf('export async function getStoryboardPlanArchives'));
  assert.match(write, /db\.transaction\(STORE_STORYBOARD_PLAN_ARCHIVES, 'readwrite'\)/);
  assert.match(write, /transaction\.oncomplete/);
  assert.match(write, /transaction\.onabort/);
  assert.match(write, /transaction\.abort\(\)/);
  assert.match(store, /export async function getStoryboardPlanArchives[\s\S]*?\.slice\(0, 300\)/);
});

test('archived summaries preserve UI identity without recreating heavy defaults', () => {
  const normalized = normalizeStoryboardState({
    shotPlans: [{
      id: 'plan-a', chatKey: 'chat-a', status: 'completed', archiveRef: 'chat-a␟plan-a', archiveVersion: 1,
      hasContinuityLedger: true, createdAt: 1, updatedAt: 2,
      shots: [{ id: 'shot-a', status: 'completed', hasPrompt: true, resultIds: ['image-a'] }],
    }],
  });
  const plan = normalized.shotPlans[0];
  assert.equal(plan.archiveRef, 'chat-a␟plan-a');
  assert.equal(plan.continuityLedger, null);
  assert.equal(plan.hasContinuityLedger, true);
  assert.equal(plan.shots[0].hasPrompt, true);
  assert.equal(plan.shots[0].shotSpec, null);
  assert.deepEqual(plan.shots[0].resultIds, ['image-a']);

  const active = normalizeStoryboardState({
    shotPlans: [{ id: 'plan-b', status: 'generating', shots: [{ id: 'shot-b', status: 'generating', prompt: 'portrait' }] }],
  }).shotPlans[0];
  assert.equal(active.archiveRef, '');
  assert.equal(active.shots[0].hasPrompt, true);
  assert.ok(active.shots[0].shotSpec, 'working plans keep the complete normalized shot contract');
});

test('heavy settings shrink only after durable storage and terminal revalidation', () => {
  const archive = source.slice(source.indexOf('async function storyboardArchiveShotPlans'), source.indexOf('function storyboardSchedulePlanArchive'));
  assert.ok(archive.indexOf('await blobStore.putStoryboardPlanArchives') < archive.indexOf('state.shotPlans[index] = storyboardPlanLightweightSummary'));
  assert.match(archive, /epoch !== storyboardPlanArchiveEpoch/);
  assert.match(archive, /Number\(current\.updatedAt \|\| 0\) !== item\.updatedAt/);
  assert.match(archive, /storyboardPlanIsTerminal\(current\)/);
  assert.match(source, /function storyboardPlanHasHeavyPayload[\s\S]*storyboardPlanIsTerminal\(plan\)/);
});

test('retry and re-extraction release machine-local archives before mutation', () => {
  assert.match(source, /async function storyboardRetryPlan[\s\S]*if \(plan\.archiveRef\) await storyboardReleasePlanArchive\(plan\)[\s\S]*plan\.status = 'screening'/);
  assert.match(source, /dataset\.storyboardChatAction === 'capture-floor'[\s\S]*if \(plan\.archiveRef\) await storyboardReleasePlanArchive\(plan\)/);
  assert.match(source, /async function storyboardHandleAutomaticCapture[\s\S]*if \(plan\.archiveRef\) await storyboardReleasePlanArchive\(plan\)/);
  assert.match(source, /shot\.hasPrompt \|\| String\(shot\.prompt \|\| ''\)\.trim\(\)/);
});

test('portable exports hydrate full plans while imports discard local references', () => {
  assert.match(source, /async function exportConfig[\s\S]*await storyboardPlansForPortableExport\(snapshot\.imagegen\.shotPlans\)/);
  assert.match(source, /async function storyboardExportPackage[\s\S]*await storyboardPlansForPortableExport/);
  assert.match(source, /type: 'qianmu-storyboard', version: 6/);
  assert.match(source, /async function importConfig[\s\S]*delete plan\.archiveRef[\s\S]*clearStoryboardPlanArchives/);
  assert.match(source, /async function storyboardImportPackage[\s\S]*storyboardDeletePlanArchives\(replacedPlans\)[\s\S]*storyboardSchedulePlanArchive/);
});

test('storage cleanup invalidates references and lifecycle performs idle migration only', () => {
  assert.match(source, /storyboard_plan_archives: \['不可恢复 · 分镜历史计划', true\]/);
  assert.match(source, /STORAGE_CHAT_CLEARABLE[^\n]*storyboard_plan_archives/);
  assert.match(source, /cleared\.has\('storyboard_plan_archives'\)[\s\S]*delete plan\.archiveRef/);
  assert.match(source, /reconcileClearedStoryboardPlanChats[\s\S]*keys\.has[\s\S]*delete plan\.archiveRef/);
  assert.match(source, /const appReadyHandler[\s\S]*storyboardSchedulePlanArchive\(1200\)/);
  const appReady = source.slice(source.indexOf('const appReadyHandler'), source.indexOf('const personaChangedHandler'));
  assert.doesNotMatch(appReady, /getStoryboardPlanArchives/, 'startup migration must not scan archived plan details');
  assert.match(source, /clean\('storyboard queue'[\s\S]*storyboardPlanArchiveEpoch\+\+[\s\S]*storyboardPlanArchiveCache\.clear/);
});
