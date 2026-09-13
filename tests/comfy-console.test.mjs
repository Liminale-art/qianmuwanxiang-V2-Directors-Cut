import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRunningHubConsoleUrl as normalize,comfyWorkbenchConsoleLink as link} from '../qianmu-comfy-console.js';
import {normalizeStoryboardParameterProfile} from '../qianmu-storyboard.js';
import {normalizeComfyLibraryDocument,importComfyLibraryDocument,exportComfyLibraryDocument} from '../qianmu-comfy-library.js';
import {renderComfyWorkbench} from '../qianmu-comfy-workbench.js';
import {recipesFixture} from './helpers/comfy-route-fixture.mjs';
import {applyComfyRouteRecipe} from '../qianmu-comfy-route.js';
const url='https://www.runninghub.cn/workflow/1980237776367083521';
test('explicit RH links preserve exact large IDs and never retain credentials, query parameters or arbitrary destinations',()=>{
  assert.equal(normalize(url+'?source=workspace'),url);assert.equal(normalize(url.replace('/workflow/','/post/')),url);
  for(const value of [null,123,url+'?apiKey=secret',url+'#secret',url.replace('https:','javascript:'),url.replace('.cn/','.cn.evil.test/'),url.replace('www.','user:pass@www.'),url.replace('/workflow/','/a/../workflow/'),url+'/'])assert.throws(()=>normalize(value));
  assert.equal(link({comfyConsoleUrl:url},{baseUrl:'https://www.runninghub.cn'}).url,url);
  assert.equal(link({comfyConsoleUrl:url},{baseUrl:'https://www.runninghub.ai'}),null);
  assert.equal(link({comfyConsoleUrl:url},{baseUrl:'http://127.0.0.1:8188'}),null);
});
test('console metadata is optional and portable but cannot be inherited from a different old recipe',async()=>{
  const f=await recipesFixture(),old=normalizeComfyLibraryDocument(f.rows[0].document);
  assert.equal(Object.hasOwn(old,'consoleUrl'),false);
  const doc={...old,consoleUrl:url};assert.deepEqual(importComfyLibraryDocument(JSON.stringify(exportComfyLibraryDocument('linked',doc))).document,doc);
  assert.equal(normalizeStoryboardParameterProfile({comfyConsoleUrl:url},'comfy').comfyConsoleUrl,url);
  assert.equal(normalizeStoryboardParameterProfile({comfyConsoleUrl:url+'?apiKey=secret'},'comfy').comfyConsoleUrl,'[invalid]');
  assert.equal(Object.hasOwn(normalizeStoryboardParameterProfile({comfyConsoleUrl:url},'novel'),'comfyConsoleUrl'),false);
  assert.equal(Object.hasOwn(applyComfyRouteRecipe({comfyConsoleUrl:url},f.routes[0],f.recipes[0]),'comfyConsoleUrl'),false);
});
test('navigation opens separately with no referrer or opener and never implies live workflow synchronization',()=>{
  const input={profile:{comfyConsoleUrl:url},capabilities:{},connection:{baseUrl:'https://www.runninghub.cn'}};
  const html=renderComfyWorkbench(input);assert.match(html,new RegExp(`href="${url}"`));
  assert.match(html,/target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);assert.match(html,/本地保存版本不会自动改变/);
  assert.doesNotMatch(renderComfyWorkbench({...input,profile:{comfyConsoleUrl:'javascript:alert(1)'}}),/sd-comfy-console-link|javascript:/);
  assert.equal(link({}, {baseUrl:'https://cloud.comfy.org'}).url,'https://cloud.comfy.org');
});
