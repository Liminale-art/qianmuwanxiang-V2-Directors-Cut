import test from 'node:test';
import assert from 'node:assert/strict';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';
import {planComfyCloudUpload,readComfyCloudUpload} from '../qianmu-comfy-cloud-upload-contract.js';

const source={url:'/user/images/Qianmu-References/example.png',name:'private character name',mime:'image/png',bytes:4096,sha256:'a'.repeat(64)};
const bindings=['https://cloud.comfy.org','https://saved.run.comfy.app','https://www.runninghub.cn','https://www.runninghub.ai']
  .map(url=>bindComfyCloudProtocol(url,url.includes('runninghub')?'runninghub-workflow-v1':'comfy-cloud-v2'));
const cloudReply=plan=>({id:'00112233-4455-6677-8899-aabbccddeeff',hash:null,content_type:source.mime,size_bytes:source.bytes,file_path:plan.filename,url:'https://temporary.invalid/?private-signature'});
const rhReply=()=>({code:0,message:'success',data:{type:'image',fileName:'openapi/opaque-file.png',size:'4096',download_url:'https://temporary.invalid/?private-signature'}});

test('only official platform upload endpoints are planned; no private filename, credential, job or fallback is added',()=>{
  for(const binding of bindings){
    const plan=planComfyCloudUpload(binding,source),cloud=binding.provider==='comfy-cloud';
    assert.equal(plan.url,`${binding.origin}${cloud?'/api/v2/assets':'/openapi/v2/media/upload/binary'}`);
    assert.equal(plan.createsJob,false);assert.equal(plan.effect,'upload');assert.equal(plan.redirect,'error');
    assert.equal(plan.filename,`qianmu-${source.sha256}.png`);assert.equal(plan.fileField,'file');
    assert.deepEqual(plan.fields,cloud?{file_path:plan.filename,content_type:'image/png'}:{});
    assert.ok(Object.isFrozen(plan.source));assert.ok(!JSON.stringify(plan.fields).includes(source.name));
  }
  for(const altered of [{...bindings[0],origin:'https://other.invalid'},{...bindings[0],provider:'runninghub'}, {...bindings[0],version:2}])assert.throws(()=>planComfyCloudUpload(altered,source));
  assert.throws(()=>planComfyCloudUpload(bindings[0],{...source,url:'https://external.invalid/private.png'}));
});

test('platform replies become distinct graph inputs without persisting temporary URLs or equating different hashes',()=>{
  for(const binding of bindings){
    const plan=planComfyCloudUpload(binding,source),cloud=binding.provider==='comfy-cloud',reply=cloud?cloudReply(plan):rhReply();
    const before=JSON.stringify(reply),value=readComfyCloudUpload(plan,reply);
    assert.deepEqual(value.reference,cloud?{__type:'core/ASSET',info:{id:reply.id}}:reply.data.fileName);
    assert.equal(value.source.sha256,source.sha256);assert.equal(JSON.stringify(reply),before);
    assert.doesNotMatch(JSON.stringify(value),/private-signature|temporary\.invalid|download_url/);
    if(cloud)assert.deepEqual(readComfyCloudUpload(plan,{...reply,hash:`blake3:${'b'.repeat(64)}`}),value);
  }
});

test('wrong size, path, type, provider reply, descriptor or unknown target cannot authorize reference binding',()=>{
  const cloud=planComfyCloudUpload(bindings[0],source),rh=planComfyCloudUpload(bindings[2],source);
  for(const change of [{id:'filename.png'},{file_path:'different.png'},{hash:source.sha256},{size_bytes:1},{content_type:'image/jpeg'}])assert.throws(()=>readComfyCloudUpload(cloud,{...cloudReply(cloud),...change}));
  for(const change of [{fileName:'https://url.invalid/a.png'},{fileName:'../a.png'},{fileName:'api/a%2fb.png'},{fileName:'api/a.jpg'},{size:'04096'},{size:1},{type:'video'}])assert.throws(()=>readComfyCloudUpload(rh,{...rhReply(),data:{...rhReply().data,...change}}));
  assert.throws(()=>readComfyCloudUpload(rh,{...rhReply(),code:'0'}));
  assert.throws(()=>readComfyCloudUpload(cloud,rhReply()));assert.throws(()=>readComfyCloudUpload(rh,cloudReply(cloud)));
  assert.throws(()=>readComfyCloudUpload({...cloud,url:'https://other.invalid/upload'},cloudReply(cloud)));
  let touched=0;const reply=cloudReply(cloud);Object.defineProperty(reply,'url',{get(){touched++;return 'secret';}});
  assert.throws(()=>readComfyCloudUpload(cloud,reply));assert.equal(touched,0);
});
