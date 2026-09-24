import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveImageAccountNamespace} from '../qianmu-account-identity.js';
import {resolveImageAccountNamespace as admissionIdentity} from '../qianmu-image-admission.js';

test('ordinary account identity has no local feature dependency and admission reexports that exact resolver',async()=>{
 const source=await readFile(new URL('../qianmu-account-identity.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/(?:import|export)\s+(?:[^;\n]+?\s+from\s+)?['"]\.\//);
 assert.doesNotMatch(source,/import\(['"]\.\//);
 assert.equal(resolveImageAccountNamespace,admissionIdentity);
});

test('the standalone identity entry observes live ST user changes without network or a saved identity cache',async()=>{
 const user={currentUser:{handle:'one'}},settings={loadUser:async()=>user,fetchImpl:()=>assert.fail('initialized ST users require no identity HTTP')};
 assert.equal(await resolveImageAccountNamespace(settings),'st-user:one');user.currentUser={handle:'two'};
 assert.equal(await resolveImageAccountNamespace(settings),'st-user:two');
 let calls=0;user.currentUser=null;settings.fetchImpl=async()=>{calls++;return Response.json({handle:calls===1?'fallback-one':'fallback-two'});};
 assert.equal(await resolveImageAccountNamespace(settings),'st-user:fallback-one');assert.equal(await resolveImageAccountNamespace(settings),'st-user:fallback-two');assert.equal(calls,2);
});
