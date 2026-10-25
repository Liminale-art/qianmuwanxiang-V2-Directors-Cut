import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createYimuStore} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {createApi} from '../yimu/client.mjs';
import {createHost} from '../yimu/host.mjs';
import {createController} from '../yimu/runtime.mjs';
import {fingerprintMessages} from '../yimu/contract.mjs';

test('own backup through real HTTP uploads, account archive, explicit restore and native open stays off',async t=>{
    const base=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'yimu-backup-loop-'));
    t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),base);assert.match(path.basename(real),/^yimu-backup-loop-/);await fs.rm(real,{recursive:true});});
    const account=path.join(root,'account'),chats=path.join(account,'chats'),folder=path.join(chats,'Actor'),characters=path.join(account,'characters');
    await fs.mkdir(folder,{recursive:true});await fs.mkdir(characters);await fs.writeFile(path.join(characters,'Actor.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5YQAAAAASUVORK5CYII=','base64'));
    const binding={avatar:'Actor.png',file:'source',integrity:'source-integrity'};
    const messages=Array.from({length:12},(_,i)=>({name:i%2?'User':'Actor',is_user:!!(i%2),is_system:false,mes:`第${i+1}层约定`,send_date:`date-${i}`,extra:{preserved:true}}));
    const original=[{user_name:'User',character_name:'Actor',chat_metadata:{integrity:binding.integrity,other_plugin:{doNotRestore:true}}},...messages].map(JSON.stringify).join('\r\n');
    const sourceFile=path.join(folder,'source.jsonl');await fs.writeFile(sourceFile,original);
    const request={user:{profile:{handle:'fixture'},directories:{root:account,chats,characters}}};
    const store=createYimuStore({hostCwd:root}),routes=new Map();
    registerYimuRoutes({get:(url,fn)=>routes.set(`GET ${url}`,fn),post:(url,fn)=>routes.set(`POST ${url}`,fn)},{store});
    const readRows=async file=>(await fs.readFile(path.join(folder,`${file}.jsonl`),'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    const server=http.createServer(async(req,res)=>{
        res.status=function(code){this.statusCode=code;return this;};
        res.json=function(value){this.setHeader('Content-Type','application/json');this.end(JSON.stringify(value));return this;};
        try{
            Object.assign(req,request);
            if(!req.headers['content-type']?.startsWith('application/octet-stream')){
                const chunks=[];for await(const chunk of req)chunks.push(chunk);
                req.body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
            }
            if(req.url==='/api/chats/get')return res.json(await readRows(req.body.file_name));
            const route=routes.get(`${req.method} ${req.url.replace('/api/plugins/yimu','')}`);
            if(!route)return res.status(404).json({message:'test route missing'});
            await route(req,res);
        }catch(error){if(!res.headersSent)res.status(500).json({message:error.message});else res.destroy(error);}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const fetcher=(url,options)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,options);
    const api=createApi({fetcher,headers:()=>({})});
    await api.change(binding,{id:'enable',type:'enable',expectedRevision:0,enabled:true,range:{start:1,end:12,total:12}});
    await api.change(binding,{id:'memory',type:'append',expectedEpoch:1,entry:{id:'early',kind:'summary',text:'第一版',source:{start:1,end:7,hashes:(await fingerprintMessages(messages)).slice(0,7)}}});
    await api.change(binding,{id:'edit',type:'edit',entryId:'early',expectedRevision:1,text:'人工审定的约定'});
    await api.change(binding,{id:'stale_edit',type:'edit',entryId:'early',expectedRevision:1,text:'另一版修订，待决定'});
    await api.change(binding,{id:'config',type:'settings',expectedRevision:1,values:{profileId:'do-not-export-connection',model:'private-model'}});
    let opened=0;
    const context={groupId:null,characterId:0,characters:[{name:'Actor',avatar:binding.avatar}],chatId:'source',chatMetadata:{integrity:binding.integrity,other_plugin:{doNotRestore:true}},chat:structuredClone(messages),
        mainApi:'openai',name1:'User',chatCompletionSettings:{chat_completion_source:'custom',openai_max_context:32000,openai_max_tokens:1000,names_behavior:0},
        getChatCompletionModel:()=> 'fixture',getRequestHeaders:()=>({}),
        async openCharacterChat(file){opened++;const rows=await readRows(file);this.chatId=file;this.chatMetadata=rows[0].chat_metadata;this.chat=rows.slice(1);},
        async generateRaw(){assert.fail('backup never calls a model');}};
    const host=createHost({getContext:()=>context,fetcher});let operation=0;
    const controller=createController({host,api,id:()=>`backup_loop_${++operation}`,defer:()=>{}});t.after(()=>controller.destroy());
    await controller.refresh();
    const plan=await controller.action('backupPlan');assert.equal(plan.sources.length,1);
    const downloaded=await api.backupExport(binding,{planId:plan.planId,sourceIds:['source_0']});
    assert.equal(downloaded.blob.type,'application/gzip');
    const file=Object.assign(downloaded.blob,{name:'test.yimu.gz'});
    const imported=await controller.action('backupImport',{file});
    assert.equal(opened,0);assert.deepEqual((await fs.readdir(folder)).sort(),['source.jsonl']);
    const archive=controller.state.backup.document;
    assert.equal(archive.entries[0].text,'人工审定的约定');assert.equal(archive.entries[0].history[0].text,'第一版');
    assert.equal(archive.entries[0].conflicts[0].text,'另一版修订，待决定');
    assert.equal(archive.settings.profileId,undefined);assert.equal(archive.settings.model,undefined);
    const duplicate=await api.backupUpload(file,'duplicate');assert.equal(duplicate.archive.id,imported.archive.id);
    assert.equal((await api.backupList()).archives.length,1);
    const recovered=await controller.action('backupRestore',{targetAvatar:'Actor.png',sourceIds:['source_0']});
    assert.equal(recovered.receipt.status,'complete');assert.notEqual(recovered.binding.file,binding.file);
    assert.equal(opened,0);const restoredRows=await readRows(recovered.binding.file);
    assert.deepEqual(restoredRows.slice(1),messages);assert.equal(restoredRows[0].chat_metadata.other_plugin,undefined);
    const restored=await api.read(recovered.binding);assert.equal(restored.document.enabled,false);
    assert.equal(restored.document.entries[0].text,'人工审定的约定');assert.deepEqual(restored.invalidSourceIds,[]);
    const retry=await controller.action('backupRestore',{targetAvatar:'Actor.png',sourceIds:['source_0']});assert.deepEqual(retry.binding,recovered.binding);
    assert.equal((await fs.readdir(folder)).filter(name=>name.endsWith('.jsonl')).length,2);
    const openResult=await controller.action('backupOpen');assert.equal(openResult.opened,true,openResult.message);assert.equal(opened,1);assert.equal(controller.state.document.enabled,false);
    await controller.intercept(structuredClone(context.chat),32000,()=>{});assert.equal(controller.state.lastUsed,null);
    assert.equal(await fs.readFile(sourceFile,'utf8'),original);
});
