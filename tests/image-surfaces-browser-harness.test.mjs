import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const script=await readFile(new URL('../scripts/check-image-surfaces-browser.mjs',import.meta.url),'utf8');
const fixture=await readFile(new URL('./helpers/storyboard-image-surfaces-browser.mjs',import.meta.url),'utf8');
const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
test('image surface acceptance runs actual root owners with isolated no-network/no-write edges',()=>{
  for(const name of ['storyboardEditPrompt','storyboardOpenImageInfo','storyboardOpenLightbox','storyboardOpenVideoDraftEditor'])assert.ok(fixture.includes("'"+name+"'"));
  assert.match(fixture,/map\(storyboardFunctionSource\)/);
  assert.match(script,/url\.origin!==origin/);assert.match(script,/route\.abort\(\)/);
  assert.match(script,/method\(\)!=='GET'/);assert.match(fixture,/Production mutation or provider request forbidden/);
  assert.ok(release.forbiddenSegments.includes('scripts')&&release.forbiddenSegments.includes('tests'));
});
test('image surface acceptance covers production sizing, three themes and canceled/racing edits',()=>{
  assert.match(script,/no global border-box/);assert.doesNotMatch(script,/\*[^\n]+box-sizing\s*:\s*border-box/);
  assert.match(fixture,/\['classic','glass','editorial'\]/);assert.match(fixture,/\[320,390,960\]/);
  for(const evidence of ['rapid generate','cancel during pending','cancel delayed','does not resurrect a child dialog','stays silent and has no writes','late older opening','changed original blocks','undo retains','keyboard navigation'])assert.ok(fixture.includes(evidence),evidence);
  for(const evidence of ['actual gallery entry opens readonly','readonly entry combines saved native','no boxed return control','compact consistent typography'])assert.ok(fixture.includes(evidence),evidence);
  assert.match(script,/openGalleryInfo\(\)/);
});
