import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRecipeArchiveService} from '../../qianmu-recipe-archive-service.js';
import {recipeArchiveErrorPayload} from '../../qianmu-recipe-archive-contract.js';
import {createCurrentRecipeArchiveClient} from '../../qianmu-recipe-archive-client.js';

export const recipe=prompt=>({source:'comfy',prompt:prompt||'original',negative:'',profile:{seed:0},
  payload:{parameters:{workflow:{nodes:Array.from({length:120},(_,id)=>({id,text:' node '+id+' '}))}}},unknown:{keep:['',0,false,null]}});
export async function recipeClientFixture(t,serviceOptions={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-recipe-client-'));
  const user=path.join(root,'alice'),chats=path.join(user,'chats'),folder=path.join(chats,'Alice'),file=path.join(folder,'chat.jsonl');
  await fs.mkdir(folder,{recursive:true});
  const service=createRecipeArchiveService({dataRoot:root,...serviceOptions});
  const req={user:{profile:{handle:'alice',enabled:true},directories:{root:user,chats,groupChats:path.join(user,'group chats')}}};
  let rows=[{id:'image',createdAt:1,chatKey:'chat',source:'comfy',snapshot:recipe(),url:'/user/images/example.png'}];
  const store={storyboardImages:rows},context={chatId:'chat',characterId:0,characters:[{avatar:'Alice.png',chat:'chat'}],chat:[],chatMetadata:{story_director_liminale:store},getRequestHeaders:()=>({'X-CSRF-Token':'fixture-only','Authorization':'must-not-forward'})};
  const e={root,file,archive:path.join(user,'.qianmu-recipes-v1'),req,service,context,epoch:0,account:'st-user:alice',calls:[],
    get rows(){return rows;},set rows(value){rows=value;store.storyboardImages=rows;},
    async save(){await fs.writeFile(file,JSON.stringify({chat_metadata:context.chatMetadata})+'\n'+JSON.stringify({mes:'private body not requested'})+'\n');},
    async fetch(url,options){
      e.calls.push({url,...options,body:JSON.parse(options.body)});
      try{const action=url.split('/').at(-1),method=({'storage':'storage','preserve':'preserve','read':'read','batch-capabilities':'batchCapabilities','preserve-batch':'preserveBatch'})[action];
        if(!method)return new Response('not found',{status:404});
        const result=await service[method](req,JSON.parse(options.body),{signal:options.signal});return Response.json(result);}
      catch(error){const result=recipeArchiveErrorPayload(error);return Response.json(result.body,{status:result.status});}
    },
    client(options={}){return createCurrentRecipeArchiveClient({getContext:()=>context,epoch:()=>e.epoch,getGallery:()=>rows,account:async()=>e.account,fetchImpl:e.fetch,...options});},
    async close(){await service.close();const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-recipe-client-/);await fs.rm(resolved,{recursive:true});}};
  t?.after(()=>e.close());await e.save();return e;
}
