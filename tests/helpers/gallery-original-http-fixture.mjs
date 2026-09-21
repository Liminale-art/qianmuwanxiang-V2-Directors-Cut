import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {init,exit} from '../../server-plugin.js';
import {imageServiceAccount} from '../../qianmu-image-service-access.js';
import {chatGalleryDigest} from '../../qianmu-chat-gallery-digest.js';
import {recipeClientFixture} from './recipe-client-fixture.mjs';

export const originalPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
export const originalHash=value=>createHash('sha256').update(value).digest('hex');
export async function galleryOriginalHttpFixture(t,serviceOptions={}){
    const f=await recipeClientFixture(t),images=path.join(f.req.user.directories.root,'user','images');await fs.mkdir(images,{recursive:true});
    const image=path.join(images,'example.png');await fs.writeFile(image,originalPng);f.req.user.directories.userImages=images;
    const routes=new Map(),calls=[],root=f.root;
    await init({get:(name,fn)=>routes.set('GET '+name,fn),post:(name,fn)=>routes.set('POST '+name,fn)},{dataRoot:root,galleryOriginalOptions:serviceOptions});t.after(()=>exit());
    const server=http.createServer(async(req,res)=>{
        try{
            const parts=[];for await(const part of req)parts.push(part);req.body=JSON.parse(Buffer.concat(parts).toString()||'{}');
            if(req.headers['x-fixture-anonymous']!=='yes')req.user=f.req.user;
            res.set=(name,value)=>{res.setHeader(name,value);return res;};res.status=value=>{res.statusCode=value;return res;};
            res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};
            const route=routes.get(req.method+' '+req.url);if(!route){res.statusCode=404;res.end();return;}await route(req,res);
        }catch{res.statusCode=500;res.end('fixture failed');}
    });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base='http://127.0.0.1:'+server.address().port;
    const expectedAccount=imageServiceAccount(f.req).namespace;
    const input=()=>({version:1,expectedAccount,target:{kind:'character',avatar:'Alice.png',chatId:'chat'},
        selection:{recordId:f.rows[0].id,createdAt:f.rows[0].createdAt,gallerySha256:chatGalleryDigest(f.rows).sha256}});
    return {...f,image,images,routes,calls,expectedAccount,input,
        request:(action,body,anonymous=false)=>fetch(base+'/chat-gallery/original/'+action,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(anonymous?{'x-fixture-anonymous':'yes'}:{})},...(body?{body:JSON.stringify(body)}:{})}),
        fetch:async(url,options)=>{calls.push({url,...options});if(!url.startsWith('/api/plugins/qianmu-tts/chat-gallery/original/'))throw Error('unexpected URL');
            return fetch(base+url.slice('/api/plugins/qianmu-tts'.length),options);},
    };
}
