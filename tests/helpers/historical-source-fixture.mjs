import {chatStateFixture} from './chat-state-fixture.mjs';
import {recipe} from './recipe-client-fixture.mjs';
import {createRecipeArchiveService} from '../../qianmu-recipe-archive-service.js';
import {chatCharacterReceiptErrorPayload} from '../../qianmu-chat-character-receipt.js';
import {recipeArchiveErrorPayload} from '../../qianmu-recipe-archive-contract.js';
import {captureHistoricalStoryboardSource} from '../../qianmu-historical-storyboard-source.js';
export async function historicalSourceFixture(t){
  const f=await chatStateFixture(),end=f.close,recipes=createRecipeArchiveService({dataRoot:f.root});
  f.recipes=recipes;f.account='st-user:alice';f.calls=[];f.active=true;
  f.rows.splice(0,f.rows.length,{id:'inline',createdAt:1,snapshot:recipe('inline original'),url:'/user/images/inline.png'},
    {id:'server',createdAt:2,snapshot:recipe('server original'),url:'/user/images/server.png'});
  await f.write();
  const {gallerySha256,...body}=f.request(),result=await recipes.preserve(f.req,{...body,selection:{recordId:'server',createdAt:2,gallerySha256}});
  f.rows[1].snapshotServerRef=result.reference;delete f.rows[1].snapshot;await f.write();
  f.fetch=async(url,options)=>{
    const input=JSON.parse(options.body);f.calls.push({url,...options,body:input});
    try{
      const method=url.endsWith('/state')?'readGalleryState':url.endsWith('/evidence')?'readGalleryEvidence':url.endsWith('/recipe/read')?'read':null;
      if(!method)throw Error('unexpected fixture route');
      return Response.json(await (method==='read'?recipes:f.service)[method](f.req,input,{signal:options.signal}));
    }catch(error){const result=error.code?.startsWith('recipe_archive_')?recipeArchiveErrorPayload(error):chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}
  };
  f.options=()=>({namespace:'st-user:alice',target:f.target,gallerySha256:f.request().gallerySha256,account:async()=>f.account,
    guard:async()=>{if(!f.active)throw Error('fixture closed');},headers:()=>({'X-CSRF-Token':'fixture','Authorization':'PRIVATE'}),fetchImpl:f.fetch});
  f.capture=options=>captureHistoricalStoryboardSource({...f.options(),...options});
  f.close=async()=>{f.active=false;await recipes.close();await end();};t?.after(()=>f.close());return f;
}
