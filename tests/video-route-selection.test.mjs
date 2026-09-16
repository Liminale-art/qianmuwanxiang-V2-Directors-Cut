import assert from 'node:assert/strict';
import test from 'node:test';
import { createVideoShotFromStoryboardFrames, normalizeVideoShotSpec, normalizeMultimodalAssetManifest, resolveH3VideoMode } from '../qianmu-video-contract.js';
import { createVideoDraftFromStoryboardFrame, reviseVideoDraft, compileVideoDraftSelection } from '../qianmu-video-draft.js';
import { createVideoPromptPlanFromShotSpec, compileH3VideoPrompt } from '../qianmu-video-prompt.js';
import { createVideoGenerationConfirmation } from '../qianmu-video-confirmation.js';
import { estimateMiniMaxH3Cost } from '../qianmu-video-pricing.js';
import { buildMiniMaxH3CreateRequest } from '../qianmu-video-minimax.js';

const modes = ['t2va', 'i2va', 'l2va', 'fl2va', 'ref2va'];
const roles = { t2va: [], i2va: ['first_frame'], l2va: ['last_frame'], fl2va: ['first_frame', 'last_frame'], ref2va: ['reference_image'] };
const frames = ['first', 'last', 'reference'].map(id => ({ id, chatKey: 'route-fixture', floor: 4, shotId: 'source-shot', width: 600, height: 400 }));
const sourceShot = { id: 'source-shot', scene: 'A quiet sunlit kitchen.', camera: { angle: 'eye level', framing: 'doorway on the left' },
    characters: [{ id: 'a', name: 'A', identity: ['red hair'], wardrobe: ['white shirt'], action: ['stands at the doorway'] }] };
const selection = { firstRecordId: 'first', lastRecordId: 'last', referenceRecordIds: ['reference'], referenceRoles: { reference: ['style_reference'] } };

for (const mode of modes) {
    test(`frame bridge preserves explicit ${mode} over a previously normalized automatic route`, () => {
        const previous = normalizeVideoShotSpec({ summary: 'A slow camera move across a quiet kitchen.' });
        const snapshot = structuredClone(previous);
        const { spec, manifest } = createVideoShotFromStoryboardFrames(previous, frames, { ...selection, requestedMode: mode });
        assert.equal(spec.route.requestedMode, mode);
        assert.equal(spec.route.mode, mode);
        assert.equal(spec.route.ready, true);
        assert.equal(manifest.assets.length, 3, 'inactive choices remain available for subsequent editing');
        assert.deepEqual(normalizeVideoShotSpec(spec, manifest), spec, 'normalization must not revert the edit');
        assert.deepEqual(previous, snapshot, 'source shot is immutable');
    });
}

test('an explicit return to auto replaces the previous manual choice, including snake-case options', () => {
    const previous = normalizeVideoShotSpec({ summary: 'Kitchen.', requestedMode: 'fl2va' });
    for (const options of [{ requestedMode: 'auto' }, { requested_mode: 'auto' }]) {
        const { spec } = createVideoShotFromStoryboardFrames(previous, frames, { firstRecordId: 'first', ...options });
        assert.equal(spec.route.requestedMode, 'auto'); assert.equal(spec.route.mode, 'i2va'); assert.equal(spec.route.ready, true);
    }
});

test('omitting a mode retains the original route precedence and legacy route aliases', () => {
    for (const route of [{ requestedMode: 't2va' }, { requested_mode: 't2va' }]) {
        const { spec } = createVideoShotFromStoryboardFrames({ summary: 'Kitchen.', route, requestedMode: 'fl2va' }, frames, selection);
        assert.equal(spec.route.requestedMode, 't2va'); assert.equal(spec.route.mode, 't2va');
    }
    const { spec } = createVideoShotFromStoryboardFrames({ summary: 'Kitchen.', requestedMode: 'l2va' }, frames, selection);
    assert.equal(spec.route.mode, 'l2va');
});

test('an invalid explicit mode follows the existing auto fallback, not a stale manual route', () => {
    const previous = normalizeVideoShotSpec({ summary: 'Kitchen.', requestedMode: 'fl2va' });
    const { spec } = createVideoShotFromStoryboardFrames(previous, frames, { firstRecordId: 'first', requestedMode: 'not-a-mode' });
    assert.equal(spec.route.requestedMode, 'auto'); assert.equal(spec.route.mode, 'i2va'); assert.equal(spec.route.ready, true);
});

const manifest = normalizeMultimodalAssetManifest({ assets: [
    { assetId: 'first', kind: 'image', roles: ['first_frame'], locator: { kind: 'gallery', ref: 'route-fixture:first' } },
    { assetId: 'last', kind: 'image', roles: ['last_frame'], locator: { kind: 'gallery', ref: 'route-fixture:last' } },
    { assetId: 'reference', kind: 'image', roles: ['style_reference'], locator: { kind: 'gallery', ref: 'route-fixture:reference' } },
] });
for (const mode of modes) {
    test(`${mode} exposes only inputs consumed by that mode, without deleting available assets`, () => {
        const route = resolveH3VideoMode({}, manifest, mode);
        assert.deepEqual(route.inputs, {
            firstFrameAssetId: ['i2va', 'fl2va'].includes(mode) ? 'first' : '',
            lastFrameAssetId: ['l2va', 'fl2va'].includes(mode) ? 'last' : '',
            referenceAssetIds: mode === 'ref2va' ? ['reference'] : [],
        });
        assert.equal(manifest.assets.length, 3);
    });
}

for (const mode of modes) {
    test(`structured-source ${mode} stays consistent through draft, prompt, price, confirmation and provider payload`, () => {
        const base = createVideoDraftFromStoryboardFrame(frames[0], { now: 1000, clientNonce: 'route-test' });
        const draft = reviseVideoDraft(base, { selection, settings: { requestedMode: mode }, direction: 'A slow camera move across the quiet kitchen.' }).draft;
        const before = structuredClone({ draft, sourceShot, frames });
        const compiled = compileVideoDraftSelection(draft, frames, { sourceShot });
        assert.equal(compiled.ok, true, JSON.stringify(compiled.issues));
        assert.equal(compiled.readyForSubmission, false);
        assert.equal(compiled.spec.route.requestedMode, mode);
        assert.equal(compiled.spec.route.mode, mode);
        assert.equal(compiled.spec.characters[0].appearance.identity[0], 'red hair');
        assert.equal(compiled.spec.characters[0].performance.action, 'stands at the doorway');
        const prompt = compileH3VideoPrompt(createVideoPromptPlanFromShotSpec(compiled.spec), compiled.spec, { manifest: compiled.manifest });
        assert.equal(prompt.ok, true, JSON.stringify(prompt.issues)); assert.equal(prompt.mode, mode);
        const estimate = estimateMiniMaxH3Cost(compiled.spec, compiled.manifest);
        assert.equal(estimate.imageCount, roles[mode].length, 'cost counts active inputs, not all preserved editor choices');
        const confirmation = createVideoGenerationConfirmation({ spec: compiled.spec, manifest: compiled.manifest, owner: draft.owner,
            prompt: prompt.prompt, service: { status: 'ready', services: ['minimax-h3'] }, credentialConfigured: true, region: 'global' });
        assert.equal(confirmation.readyForConfirmation, true, JSON.stringify(confirmation.blockers));
        assert.equal(confirmation.summary.mode, mode);
        assert.equal(confirmation.summary.selectedAssetCount, roles[mode].length);
        assert.equal(confirmation.confirmed, false); assert.equal(confirmation.readyForTaskCreation, false);
        const mediaUrls = Object.fromEntries(compiled.manifest.assets.map(asset => [asset.assetId, `https://example.invalid/${asset.assetId}.png`]));
        const request = buildMiniMaxH3CreateRequest(compiled.spec, compiled.manifest, { prompt: prompt.prompt, mediaUrls });
        assert.equal(request.ok, true, JSON.stringify(request.issues));
        assert.deepEqual(request.request.body.content.filter(item => item.type !== 'text').map(item => item.role), roles[mode]);
        assert.deepEqual({ draft, sourceShot, frames }, before, 'no implicit edits, saves or source changes');
    });
}

test('structured drafts keep missing manual prerequisites blocked instead of silently routing to the first frame', () => {
    const base = createVideoDraftFromStoryboardFrame(frames[0], { now: 1000 });
    for (const [mode, missing] of [['fl2va', 'last_frame'], ['l2va', 'last_frame'], ['ref2va', 'reference_asset']]) {
        const draft = reviseVideoDraft(base, { settings: { requestedMode: mode } }).draft;
        const compiled = compileVideoDraftSelection(draft, [frames[0]], { sourceShot });
        assert.equal(compiled.spec.route.mode, mode); assert.equal(compiled.spec.route.ready, false);
        assert.equal(compiled.readyForPrompt, false); assert.equal(compiled.readyForSubmission, false);
        assert.ok(compiled.issues.includes(`route_input_missing:${missing}`));
    }
});

test('mode-only changes produce a different confirmation fingerprint without discarding the draft choices', () => {
    const base = createVideoDraftFromStoryboardFrame(frames[0], { now: 1000 });
    const reviews = modes.map(mode => {
        const draft = reviseVideoDraft(base, { selection, settings: { requestedMode: mode }, direction: 'A quiet kitchen.' }).draft;
        const { spec, manifest } = compileVideoDraftSelection(draft, frames, { sourceShot });
        const { prompt } = compileH3VideoPrompt(createVideoPromptPlanFromShotSpec(spec), spec, { manifest });
        return createVideoGenerationConfirmation({ spec, manifest, owner: draft.owner, prompt,
            service: { status: 'ready', services: ['minimax-h3'] }, credentialConfigured: true, region: 'global' });
    });
    assert.equal(new Set(reviews.map(review => review.fingerprint)).size, modes.length);
    assert.ok(reviews.every(review => !review.confirmed && review.quote === null));
});
