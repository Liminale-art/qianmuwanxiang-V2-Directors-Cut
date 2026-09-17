import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createChatCharacterReceiptService} from '../../qianmu-chat-character-receipt-service.js';
import {chatCharacterReceiptErrorPayload} from '../../qianmu-chat-character-receipt.js';
import {chatGalleryReceiptText} from '../../qianmu-chat-gallery-receipt.js';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export async function chatEvidenceFixture(t,options={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-chat-evidence-'));
  const user=path.join(root,'alice'),chats=path.join(user,'chats'),groups=path.join(user,'group chats'),folder=path.join(chats,'Alice');
  await fs.mkdir(folder,{recursive:true});await fs.mkdir(groups);
  const target={kind:'character',avatar:'Alice.png',chatId:'chat-one'},file=path.join(folder,'chat-one.jsonl');
  const req={user:{profile:{handle:'alice',enabled:true},directories:{root:user,chats,groupChats:groups}}};
  const rows=[{id:'image',createdAt:1,floor:0,tags:['test'],prompt:'PRIVATE_PROMPT',snapshot:{private:'PRIVATE_RECIPE'}}];
  const messages=[{mes:'正文🌸\n第二行',name:'PRIVATE_CHAR',is_user:false,swipe_id:1,swipes:['PRIVATE_HIDDEN'],extra:{apiKey:'PRIVATE_KEY'}},
    {mes:'USER 的选择',name:'PRIVATE_USER',is_user:true,send_date:'2026-09-18'}];
  const service=createChatCharacterReceiptService({dataRoot:root,...options});
  const f={root,user,chats,groups,folder,file,target,req,rows,messages,service,
    header:()=>({chat_metadata:{story_director_liminale:{storyboardImages:rows,history:'PRIVATE_HISTORY'},unrelated:'PRIVATE_PLUGIN'}}),
    request:()=>({version:1,expectedAccount:'st-user:'+sha('alice'),target,gallerySha256:sha(chatGalleryReceiptText(rows).text)}),
    async write({header=f.header(),body=messages,newline='\n',bom='',trailing=true}={}){const content=bom+[JSON.stringify(header),...body.map(value=>JSON.stringify(value))].join(newline)+(trailing?newline:'');await fs.writeFile(file,content);return Buffer.from(content);},
    async fetch(_url,options){try{return Response.json(await service.readGalleryEvidence(req,JSON.parse(options.body),{signal:options.signal}));}
      catch(error){const result=chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}},
    async close(){await service.close();const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-chat-evidence-/);await fs.rm(resolved,{recursive:true});},
  };t?.after(()=>f.close());await f.write();return f;
}
