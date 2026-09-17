import {chatEvidenceFixture} from './chat-evidence-fixture.mjs';
import {emptyChatCharacterCollection} from '../../qianmu-character-chat-batch.js';
import {createChatCharacterDraft} from '../../qianmu-character-chat-draft.js';
import {chatCharacterReceiptErrorPayload} from '../../qianmu-chat-character-receipt.js';
export async function chatStateFixture(t,options){
  const f=await chatEvidenceFixture(t,options),owner={namespace:'st-user:alice',chatKey:f.target.chatId};
  const characterDrafts=emptyChatCharacterCollection(owner);
  characterDrafts.items=[structuredClone(createChatCharacterDraft({owner,source:{kind:'body',chatKey:owner.chatKey,messageKey:'0',revisionId:'original',characterId:'C1'},character:{id:'C1',name:'原聊天人物',identity:[' silver hair ']}}))];
  characterDrafts.revision=1;characterDrafts.items[0].future={note:' preserve exact fields ',zero:0};
  f.saved={storyboardImages:f.rows,storyboardCollections:[{id:'album',name:'原册',future:{zero:0}}],characterDrafts};
  f.header=()=>({chat_metadata:{story_director_liminale:{...f.saved,imagegen:{source:'WRONG_GLOBAL'},history:'PRIVATE_HISTORY',voice:'PRIVATE_VOICE'},unrelated:{apiKey:'PRIVATE_KEY'}}});
  f.fetch=async(_url,options)=>{try{return Response.json(await f.service.readGalleryState(f.req,JSON.parse(options.body),{signal:options.signal}));}
    catch(error){const result=chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}};
  await f.write();return f;
}
