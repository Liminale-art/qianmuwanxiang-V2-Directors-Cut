import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortableConnection, assertPortableConnectionUrl, storyboardConnectionsShareTarget as share, storyboardConnectionRestoreReview as review, validStoryboardConnectionReview } from '../qianmu-storyboard-connection-identity.js';
import { createStoryboardDefaults, normalizeStoryboardConnectionProfile } from '../qianmu-storyboard.js';
import { prepareStoryboardPackageDraft } from '../qianmu-storyboard-package-draft.js';
import { normalizeOpenAIImageCompatibility, parseOpenAICompatibleHeaders, filterOpenAIProviderOptions } from '../qianmu-openai-image-compat.js';
import { fixture, file } from './fixtures/storyboard-bundle.mjs';

const connection = () => normalizeStoryboardConnectionProfile({ id:'same-id',name:'Original',baseUrl:'https://relay.example/v1',model:'model-a',credentialId:'local-key-ref',
  compatibility:{customHeaderNames:['X-Workspace']},headers:{'X-Workspace':'project-a'},options:{route:{mode:'gateway',zone:'one'}} },'openai');
const args = (local, incoming) => { const settings=createStoryboardDefaults();settings.connections.openai.presets=[local];settings.connections.openai.activePresetId=local.id;
  return {settings,chat:{},incoming:{schemaVersion:24,connections:{openai:{presets:[incoming]}}},images:[],collections:[],chatKey:'chat'}; };

test('same public contract retains only local preset authorization, excluding model/name and object insertion order', () => {
  const before=connection(),incoming={...structuredClone(before),model:'model-b',name:'Renamed',credentialId:'foreign-reference',createdAt:99,options:{route:{zone:'one',mode:'gateway'}}};
  const input=args(before,incoming),original=structuredClone(input),result=prepareStoryboardPackageDraft(input);
  assert.equal(share(before,incoming,'openai'),true); assert.equal(result.settings.connections.openai.presets[0].credentialId,'local-key-ref');
  assert.equal(result.connectionReview[0].state,'same'); assert.equal(result.connectionReview[0].credential,'retained'); assert.equal(result.connectionReview[0].active,true);
  assert.deepEqual(result.settings.connections.openai.draft,input.settings.connections.openai.draft); assert.deepEqual(input,original);
  assert.equal(JSON.stringify(result.connectionReview).includes('key-ref'),false); assert.equal(JSON.stringify(result.connectionReview).includes('project-a'),false);
});

test('endpoint, headers, options, compatibility and protocol changes cannot inherit the same-ID credential', () => {
  for(const change of [x=>x.baseUrl+='-new',x=>x.headers['X-Workspace']='project-b',x=>x.options.route.zone='two',x=>x.options.comfyTransport='browser',
    x=>x.compatibility.endpoints.generation='paint/create',x=>x.compatibility.referenceField='image',x=>x.protocol='unknown',x=>x.imageProtocolVersion=0]){
    const previous=connection(),incoming=structuredClone(previous);change(incoming);const input=args(previous,incoming),result=prepareStoryboardPackageDraft(input);
    assert.equal(share(previous,incoming,'openai'),false);assert.equal(result.settings.connections.openai.presets[0].credentialId,'');
    assert.equal(result.connectionReview[0].state,'changed');assert.equal(result.connectionReview[0].credential,'required');assert.ok(result.connectionReview[0].differences.length);
    assert.equal(input.settings.connections.openai.presets[0].credentialId,'local-key-ref');
  }
});

test('dedicated reference is the sole ignored credential field; secret-like headers or nested transport data prevent inheritance', () => {
  for(const change of [x=>x.headers.XApiKey='synthetic-secret',x=>x.options.nested={apiToken:'synthetic-secret'},x=>x.baseUrl+='?api_key=synthetic-secret',x=>x.providerId='novel']){
    const before=connection(),incoming=structuredClone(before);change(incoming);assert.equal(share(before,incoming,'openai'),false);
    const result=prepareStoryboardPackageDraft(args(before,incoming));assert.equal(result.settings.connections.openai.presets[0].credentialId,'');
  }
});

test('Comfy transport mode changes are distinct contracts, not changes to model selection', () => {
  const first=normalizeStoryboardConnectionProfile({id:'comfy',baseUrl:'http://127.0.0.1:8188',options:{comfyTransport:'browser'}},'comfy');
  assert.equal(share(first,{...first,options:{comfyTransport:'gateway'}},'comfy'),false);
  assert.equal(share(first,{...first,model:'ignored-model-label'},'comfy'),true);
});

test('portable endpoint guard rejects embedded authorization with generic errors while preserving the original URL', () => {
  for(const url of ['https://user:synthetic-secret@relay.test/v1','https://relay.test/v1?api%5Fkey=synthetic-secret','https://relay.test/v1?X-Amz-Signature=synthetic-secret','https://relay.test/#synthetic-secret','file:///synthetic-secret']){
    assert.throws(()=>assertPortableConnectionUrl(url),error=>error.code==='storyboard_connection_identity'&&!error.message.includes('synthetic-secret'));
  }
  for(const url of ['','http://127.0.0.1:8188','https://relay.test/v1?project=one'])assert.doesNotThrow(()=>assertPortableConnectionUrl(url));
});

test('structured secret guard permits public parameters but refuses opaque and differently spelled credential headers', () => {
  for(const value of [{headers:'Authorization: synthetic-secret'},{headers:{XApiKey:'synthetic-secret'}},{headers:{'X-Custom-Token':'synthetic-secret'}},
    {options:{route:{api_token:'synthetic-secret'}}},{credentialId:'local-reference'},{baseUrl:'https://relay.test/?token=synthetic-secret'}])assert.throws(()=>assertPortableConnection(value));
  assert.equal(assertPortableConnection({credentialId:'',headers:{'X-Workspace':'one'},options:{max_tokens:1024,tokenBudget:42,route:{mode:'browser'}}}),true);
  assert.throws(()=>assertPortableConnection({options:{nested:Array.from({length:20001},()=>0)}}),/过大/);
});

test('compatibility controls reject camelcase credentials without losing allowed public request headers/options', () => {
  const headers=parseOpenAICompatibleHeaders('XApiKey: synthetic-secret\nXAccessToken: synthetic-secret\nXCustomToken: synthetic-secret\nX-Workspace: public');
  assert.deepEqual(headers.headers,{'X-Workspace':'public'});
  const profile=normalizeOpenAIImageCompatibility({providerOptionKeys:['xApiKey','apiToken','accessKey','input_fidelity','vendor_mode']});
  assert.deepEqual(profile.providerOptionKeys,['input_fidelity','vendor_mode']);
  assert.deepEqual(filterOpenAIProviderOptions({input_fidelity:'high',vendor_mode:2,xApiKey:'synthetic-secret'},profile),{input_fidelity:'high',vendor_mode:2});
});

test('display rows accept only bounded public summaries, reject credentials, duplicate IDs and impossible retained states', () => {
  const row=review(null,connection(),'openai');assert.equal(validStoryboardConnectionReview([row]),true);
  for(const rows of [[{...row,credentialId:'private'}],[row,row],[{...row,state:'added',credential:'retained'}],[{...row,providerId:'__proto__'}],[{...row,differences:['secret']}],Array.from({length:301},(_,i)=>({...row,presetId:String(i)}))])assert.equal(validStoryboardConnectionReview(rows),false);
});

test('resource export detects signed connections and nested header secrets before reading originals; source remains untouched', async () => {
  for(const change of [x=>x.settings.connections.comfy.presets[0].baseUrl='https://relay.test/?key=synthetic-secret',
    x=>x.settings.connections.comfy.presets[0].headers={XApiKey:'synthetic-secret'},
    x=>x.settings.connections.comfy.draft={options:{apiToken:'synthetic-secret'}},
    x=>x.chat.images[0].snapshot={connection:{baseUrl:'https://user:synthetic-secret@relay.test'}},
    x=>x.settings.profiles.comfy.comfyUrl='https://relay.test/#synthetic-secret']){
    const f=await fixture();change(f.config);f.options.storyboard=file(f.config);const original=await f.options.storyboard.text();
    await assert.rejects(f.build(),error=>!error.message.includes('synthetic-secret'));
    assert.equal(f.reads.images,0);assert.equal(await f.options.storyboard.text(),original);
  }
});
