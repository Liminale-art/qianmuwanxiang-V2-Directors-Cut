import assert from 'node:assert/strict';
import {configureStAccountStorage,createStAccountStorage} from '../../qianmu-st-account-storage.js';

// Actual native-file transport, with every request intercepted in memory. No
// browser, real ST account, external endpoint or model is contacted by tests.
export function streamCheckpointTransport(initialNamespace='st-user:route-test'){
  const files=new Map(),calls=[];let hook=null,namespace=initialNamespace;
  const json=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const fetchImpl=async(url,options)=>{
    const target=new URL(url);assert.equal(target.origin,'https://stream-storage.fixture.invalid');
    const path=target.pathname;calls.push({path,options});
    if(hook){const reply=await hook({path,options,files,calls,json});if(reply)return reply;}
    if(path==='/api/files/upload'){
      const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return json({path:`/user/files/${name}`});
    }
    assert.ok(path.startsWith('/user/files/'));const name=path.split('/').at(-1);
    return files.has(name)?json(files.get(name)):json({},404);
  };
  const options={fetchImpl,origin:'https://stream-storage.fixture.invalid',resolveNamespace:async()=>namespace,isCurrent:()=>true,
    headers:()=>({'X-CSRF-Token':'fixture'}),timeoutMs:5000};
  return {files,calls,configure:()=>configureStAccountStorage(options),createStorage:overrides=>createStAccountStorage({...options,...overrides}),
    set hook(value){hook=value;},set namespace(value){namespace=value;},
    checkpoints(){return [...files.values()].map(text=>JSON.parse(text)).filter(row=>row.schema==='qianmu.st-account-document.v1').map(row=>row.value).filter(value=>value?.schema==='qianmu.storyboard.stream-checkpoint.v1');},
  };
}
