import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateVideoReadiness } from '../qianmu-video-readiness.js';

const compiled = (resolution = '768p') => ({
  ok: true,
  draft: { settings: { resolution } },
  spec: { route: { ready: true, mode: 'i2va', missingRequirements: [] } },
});

test('readiness remains submission-locked even when prerequisites are complete', () => {
  const report = evaluateVideoReadiness({
    service: { status: 'ready', services: ['minimax-h3'], version: '1.0.0' },
    credentialConfigured: true,
    compiled: compiled(),
  });
  assert.equal(report.readyForQuote, true);
  assert.equal(report.readyForSubmission, false);
  assert.equal(report.submissionLocked, true);
  assert.equal(report.items.find((item) => item.id === 'submission')?.status, 'locked');
});

test('missing gateway capability, credential and route inputs remain distinct blockers', () => {
  const report = evaluateVideoReadiness({
    service: { status: 'ready', services: ['doubao-tts'] },
    credentialConfigured: false,
    compiled: {
      ok: false,
      draft: { settings: { resolution: '768p' } },
      spec: { route: { ready: false, mode: 'fl2va', missingRequirements: ['last_frame'] } },
    },
  });
  assert.equal(report.readyForQuote, false);
  assert.match(report.items.find((item) => item.id === 'gateway')?.detail || '', /MiniMax H3/);
  assert.match(report.items.find((item) => item.id === 'credential')?.detail || '', /尚未配置/);
  assert.match(report.items.find((item) => item.id === 'materials')?.detail || '', /尾帧/);
});

test('2K is visible as a separate confirmation without hiding other readiness', () => {
  const report = evaluateVideoReadiness({
    service: { status: 'ready', services: ['minimax-h3'] },
    credentialConfigured: true,
    compiled: compiled('2k'),
  });
  assert.equal(report.readyForQuote, true);
  assert.equal(report.items.find((item) => item.id === 'quality')?.status, 'attention');
  assert.match(report.items.find((item) => item.id === 'quality')?.detail || '', /单独确认/);
});
