import {historicalSourceFixture} from './historical-source-fixture.mjs';
import {chatCharacterReceiptErrorPayload} from '../../qianmu-chat-character-receipt.js';
import {loadGalleryPreviewImage} from '../../qianmu-gallery-preview-media.js';
import {exportGalleryHistory} from '../../qianmu-gallery-history-export.js';
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=','base64');
export async function historyExportFixture(t){
  const f=await historicalSourceFixture(t),original=f.fetch;f.downloads=[];f.mediaCalls=[];f.progress=[];
  f.fetch=async(url,options)=>{
    if(url.startsWith('/user/images/')){f.mediaCalls.push({url,...options});return new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.length)}});}
    const method=url.endsWith('/receipt')?'inspectGallery':url.endsWith('/record')?'readGalleryRecord':null;
    if(!method)return original(url,options);
    const input=JSON.parse(options.body);f.calls.push({url,...options,body:input});
    try{return Response.json(await f.service[method](f.req,input,{signal:options.signal}));}
    catch(error){const result=chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}
  };
  f.loadImage=(url,options)=>loadGalleryPreviewImage(url,{...options,fetchImpl:f.fetch,decode:async()=>({width:1,height:1,close(){}})});
  f.exportOptions=()=>({namespace:'st-user:alice',source:{ownerKey:'char:Alice.png',chatKey:'chat-one'},confirmed:true,
    resolveNamespace:async()=>f.account,guard:async()=>{if(!f.active)throw Error('fixture closed');},headers:f.options().headers,
    fetchImpl:f.fetch,loadImage:f.loadImage,save:(blob,name)=>f.downloads.push({blob,name}),onProgress:value=>f.progress.push(value)});
  f.run=options=>exportGalleryHistory({...f.exportOptions(),...options});return f;
}
