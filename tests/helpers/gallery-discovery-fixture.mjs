import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGalleryDiscoveryService} from '../../qianmu-gallery-discovery-service.js';
import {createGalleryArchiveStorage} from '../../qianmu-gallery-archive-storage.js';
import {imageServiceAccount} from '../../qianmu-image-service-access.js';
import {chatGalleryReceiptText} from '../../qianmu-chat-gallery-receipt.js';
import {streamCheckpointTransport} from './stream-checkpoint-fixture.mjs';
import {recipeClientFixture} from './recipe-client-fixture.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
export async function galleryDiscoveryFixture(t,options={}){
  const host=await recipeClientFixture(t),folder=path.join(host.req.user.directories.root,'files');await fs.mkdir(folder);host.req.user.directories.files=folder;
  const opened=[],transport=streamCheckpointTransport(host.account),io={...fs,open:async(file,...args)=>{opened.push(path.basename(file));return fs.open(file,...args);},...options.io};
  const service=createGalleryDiscoveryService({dataRoot:host.root,io,...options}),account=imageServiceAccount(host.req).namespace;
  t.after(()=>service.close());
  const input=(patch={})=>({version:1,expectedAccount:account,limit:2,cursor:null,...patch});
  return {host,folder,opened,transport,service,input,
    async add(id=1){
      const scope={namespace:host.account,ownerKey:'char:Alice.png',chatKey:'chat-'+id},rows=[{id:'image-'+id,createdAt:id,chatKey:scope.chatKey,url:'/user/images/private.png',prompt:'PRIVATE_PROMPT'}];
      const store=await createGalleryArchiveStorage({scope,guard:()=>true,verifyRecord:()=>true,createStorage:transport.createStorage});
      try{const page=await store.stagePage(rows),summary=chatGalleryReceiptText(rows),receipt={count:summary.count,bytes:summary.bytes,sha256:sha(summary.text),proof:'read-only-snapshot'};
        await store.publishSourceVersion(receipt,[page.descriptor]);
      }finally{store.close();}
    },
    async flush(){for(const [name,text] of transport.files)await fs.writeFile(path.join(folder,name),text);},
    async unchanged(){const result={};for(const name of await fs.readdir(folder))result[name]=sha(await fs.readFile(path.join(folder,name)));return result;},
  };
}
