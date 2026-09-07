import {request as httpsRequest} from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {Readable} from 'node:stream';
import {encodeNovelVibe,prepareNovelVibeEncoding} from './qianmu-vibe-encoding.js';
import {validateGatewayBaseUrl} from './qianmu-image-gateway.js';

// Operation-scoped DNS pinning, TLS for the original hostname, no redirects/cookies/private address opt-in.
function pinnedEncodeFetch(endpoint,addresses,requestImpl){
  return (rawUrl,init)=>new Promise((resolve,reject)=>{
    if(String(rawUrl)!==endpoint||init.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>24*1024*1024){reject(Error('Invalid encoding request'));return;}
    const target=new URL(endpoint);
    const lookup=(hostname,options,callback)=>{
      if(hostname.replace(/^\[|\]$/g,'')!==target.hostname.replace(/^\[|\]$/g,'')){callback(Error('Host changed'));return;}
      if(options?.all){callback(null,addresses.map(row=>({...row})));return;}
      const selected=addresses.find(row=>!options?.family||row.family===options.family)||addresses[0];callback(null,selected.address,selected.family);
    };
    let request;
    try{
      request=requestImpl(target,{method:'POST',headers:{'Content-Type':'application/json',Authorization:init.headers.Authorization,'Content-Length':Buffer.byteLength(init.body)},
        lookup,agent:false,signal:init.signal},incoming=>{
        try{const headers=new Headers();for(const [key,value] of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):String(value));
          resolve(new Response([204,205,304].includes(incoming.statusCode)?null:Readable.toWeb(incoming),{status:incoming.statusCode,headers}));
          if([204,205,304].includes(incoming.statusCode))incoming.resume();
        }catch(error){incoming.destroy();reject(error);}
      });
      request.on('error',reject);request.end(init.body);
    }catch(error){request?.destroy();reject(error);}
  });
}

// Kept below the HTTP router until durable encoding admission/recovery is integrated.
// The eventual caller must authenticate the ST account and provide an explicit authorization callback.
export async function encodeGatewayNovelVibe(input,{authorize,guard,resolveHost=dnsLookup,requestImpl=httpsRequest,timeoutMs,signal=input?.signal}={}){
  const captured={...input},prepared=await prepareNovelVibeEncoding(captured);let addresses;
  await validateGatewayBaseUrl(prepared.identity.endpoint,{allowPrivateNetwork:false,resolveHost:async(host,options)=>{
    const found=await resolveHost(host,options);addresses=(Array.isArray(found)?found:[found]).map(row=>({address:row.address,family:Number(row.family)}));return addresses;
  }});
  if(!addresses?.length||addresses.length>128||addresses.some(row=>![4,6].includes(row.family)))throw Object.assign(new Error('无法确认 Vibe 编码服务地址'),{code:'vibe_encoding_address',submissionState:'not_submitted'});
  return encodeNovelVibe(captured,{authorize,guard,timeoutMs,signal,fetchImpl:pinnedEncodeFetch(prepared.identity.endpoint,addresses,requestImpl)});
}
