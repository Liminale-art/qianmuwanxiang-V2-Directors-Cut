// Read-only selected-source grants. Reuses the image restore path contract and
// its BigInt file-identity/no-link convention without changing restore writes.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { imageRestoreReceipt } from './qianmu-image-restore-contract.js';
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { planComfyCloudUpload } from './qianmu-comfy-cloud-upload-contract.js';

const fail=()=>Object.assign(new Error('当前账户的参考图不可读取或已变化，请重新选择'),{code:'comfy_reference_source',submissionState:'not_submitted',retryable:false});
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const same=(a,b)=>typeof a?.ino==='bigint'&&a.ino>0n&&typeof a.dev==='bigint'&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b.dev;
export function createComfyReferenceSource({dataRoot,io=fs}={}) {
  if(typeof dataRoot!=='string'||!dataRoot||dataRoot.includes('\0'))throw fail();
  const configuredRoot=path.resolve(dataRoot);if(configuredRoot===path.parse(configuredRoot).root)throw fail();
  const readers=new Set();let closed=false;
  const stat=file=>io.lstat(file,{bigint:true});
  async function authorize(req,rawPlan,expectedAccount,{signal}={}) {
    try {
      const account=imageServiceAccount(req),plan=planComfyCloudUpload(rawPlan?.connection,rawPlan?.source);
      if(account.namespace!==expectedAccount?.namespace)throw fail();
      const {url,bytes,mime,sha256}=plan.source,receipt=imageRestoreReceipt({url,bytes,mime,sha256});
      const directories=req.user?.directories,originalRoot=directories?.root,originalImages=directories?.userImages;
      if(typeof originalRoot!=='string'||!originalRoot||typeof originalImages!=='string'||!originalImages||originalRoot.includes('\0')||originalImages.includes('\0'))throw fail();
      const root=path.resolve(originalRoot),images=path.resolve(originalImages);
      if(!child(configuredRoot,root)||!child(root,images))throw fail();
      const target=path.join(images,...receipt.url.slice('/user/images/'.length).split('/').map(decodeURIComponent));
      if(!child(images,target))throw fail();
      const parents=[configuredRoot];let cursor=configuredRoot;
      for(const part of path.relative(configuredRoot,path.dirname(target)).split(path.sep)){cursor=path.join(cursor,part);parents.push(cursor);}
      const identities=new Map();let originalFile,readStarted=false;
      const check=()=>{if(closed||signal?.aborted||!imageServiceAccountStillMatches(req,account)||req.user?.directories?.root!==originalRoot||req.user?.directories?.userImages!==originalImages)throw fail();};
      async function verify() {
        try {
          check();
          for(const folder of parents){
            const current=await stat(folder);check();
            if(!current.isDirectory()||current.isSymbolicLink()||path.resolve(await io.realpath(folder))!==folder||identities.has(folder)&&!same(current,identities.get(folder)))throw fail();
            identities.set(folder,current);check();
          }
          const current=await stat(target);check();
          if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||current.size!==BigInt(receipt.bytes)
            ||originalFile&&(!same(current,originalFile)||current.mtimeNs!==originalFile.mtimeNs||current.ctimeNs!==originalFile.ctimeNs))throw fail();
          originalFile ||= current;
        }catch(_){throw fail();}
      }
      await verify();
      function read({signal:readSignal}={}) {
        if(readStarted||readers.size>=2) return Promise.reject(fail());readStarted=true;
        const active=Promise.resolve().then(async()=>{
          let handle;
          const guard=()=>{check();if(readSignal?.aborted)throw fail();};
          try {
            guard();await verify();guard();handle=await io.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));guard();
            const opened=await handle.stat({bigint:true});guard();
            if(!same(opened,originalFile)||!opened.isFile()||opened.nlink!==1n||opened.size!==originalFile.size||opened.mtimeNs!==originalFile.mtimeNs||opened.ctimeNs!==originalFile.ctimeNs)throw fail();
            const buffer=Buffer.alloc(receipt.bytes+1);let length=0;
            while(length<buffer.length){guard();const part=await handle.read(buffer,length,buffer.length-length,length);guard();if(!part.bytesRead)break;length+=part.bytesRead;}
            const after=await handle.stat({bigint:true});guard();
            if(length!==receipt.bytes||!same(opened,after)||after.size!==opened.size||after.nlink!==1n||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs)throw fail();
            await verify();guard();return buffer.subarray(0,length);
          }catch(_){throw fail();}finally{try{await handle?.close();}catch(_){throw fail();}}
        });
        readers.add(active);return active.finally(()=>readers.delete(active));
      }
      return Object.freeze({verify,read});
    }catch(_){throw fail();}
  }
  return Object.freeze({authorize,close(){closed=true;return Promise.allSettled([...readers]);}});
}
