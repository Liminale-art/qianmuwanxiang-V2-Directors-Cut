import test from 'node:test';
import assert from 'node:assert/strict';
import {coreadPackageRestoreMessage,readCoreadPackageFile} from '../qianmu-reader-package.js';

test('restore scope explains every affected store without treating overwritten originals as copies',async()=>{
  const data=await readCoreadPackageFile(new Blob([JSON.stringify({type:'qianmu-coread',version:5,
    books:[{meta:{id:'a',progress:.75},fullText:'original',coverB64:'YQ=='},{meta:{id:'b'},fullText:''}],
    chats:[{key:'one::a',rec:{}}],images:[{key:'a::1',b64:'YQ=='}],vectors:[{key:'one::a',rec:{}}],
    audio:[{key:'sound',b64:'YQ=='}],retrievalLogs:[{at:1},{at:2}],prefs:{fontSize:18}})]));
  const before=JSON.stringify(data),text=coreadPackageRestoreMessage(data);
  assert.equal(text,'将恢复 2 本书及其对话、插图、语音，同编号内容会被覆盖。','one plain sentence: what comes in and that same-id content is overwritten');
  assert.equal(JSON.stringify(data),before,'confirmation cannot alter originals or companion identities');
});

test('legacy book-only and preference-only packs get the same single sentence',()=>{
  assert.equal(coreadPackageRestoreMessage({books:[{meta:{id:'legacy'},fullText:'old'}]}),'将恢复 1 本书及其对话、插图、语音，同编号内容会被覆盖。');
  assert.equal(coreadPackageRestoreMessage({books:[],prefs:{fontSize:18}}),'将恢复 0 本书及其对话、插图、语音，同编号内容会被覆盖。');
});

test('confirmation never interpolates untrusted book names, media keys or preference values',()=>{
  const hostile='<img src=x onerror=alert(1)>',text=coreadPackageRestoreMessage({books:[{meta:{id:hostile,title:hostile},fullText:hostile}],prefs:{name:hostile},retrievalLogs:[{query:hostile}]});
  assert.equal(text.includes(hostile),false);assert.equal(/[<>]/.test(text),false);
});
