import test from 'node:test';
import assert from 'node:assert/strict';
import {coreadPackageRestoreMessage,readCoreadPackageFile} from '../qianmu-reader-package.js';

test('restore scope explains every affected store without treating overwritten originals as copies',async()=>{
  const data=await readCoreadPackageFile(new Blob([JSON.stringify({type:'qianmu-coread',version:5,
    books:[{meta:{id:'a',progress:.75},fullText:'original',coverB64:'YQ=='},{meta:{id:'b'},fullText:''}],
    chats:[{key:'one::a',rec:{}}],images:[{key:'a::1',b64:'YQ=='}],vectors:[{key:'one::a',rec:{}}],
    audio:[{key:'sound',b64:'YQ=='}],retrievalLogs:[{at:1},{at:2}],prefs:{fontSize:18}})]));
  const before=JSON.stringify(data),text=coreadPackageRestoreMessage(data);
  for(const fragment of ['2 本书','1 张封面','1 段对话与记忆','1 张插图','1 组检索资料','1 条语音','2 条检索记录',
    '含阅读进度','不是另存副本','保留本机已有音频','不恢复配音收藏或专注语音库',
    '最近插入的50条','可能挤出本机已有记录','替换相应设置','启用状态','连接地址、模型与连接预设不随包替换','不会整包自动撤回'])assert.ok(text.includes(fragment),fragment);
  assert.equal(JSON.stringify(data),before,'confirmation cannot alter originals or companion identities');
});

test('legacy book-only packs do not warn about log trimming or audio operations absent from the file',()=>{
  const text=coreadPackageRestoreMessage({books:[{meta:{id:'legacy'},fullText:'old'}]});
  assert.match(text,/1 本书/);assert.doesNotMatch(text,/仅保留最近插入|保留本机已有音频|合并并替换/);
  assert.match(text,/API 密钥沿用本机设置/);assert.match(text,/请先备份本机资料/);
});

test('preference-only packs disclose settings changes without claiming that they will overwrite book originals',()=>{
  const text=coreadPackageRestoreMessage({books:[],prefs:{fontSize:18}});
  assert.match(text,/合并并替换相应设置/);assert.doesNotMatch(text,/不是另存副本|可能挤出本机已有记录/);
});

test('confirmation never interpolates untrusted book names, media keys or preference values',()=>{
  const hostile='<img src=x onerror=alert(1)>',text=coreadPackageRestoreMessage({books:[{meta:{id:hostile,title:hostile},fullText:hostile}],prefs:{name:hostile},retrievalLogs:[{query:hostile}]});
  assert.equal(text.includes(hostile),false);assert.equal(/[<>]/.test(text),false);
});
