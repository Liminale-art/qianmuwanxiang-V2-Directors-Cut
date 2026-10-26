import test from 'node:test';
import assert from 'node:assert/strict';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';
import {mountPromptView} from '../yimu/prompt-view.mjs';
import {DEFAULT_PROMPTS,BUILTIN_PROMPT_PRESET,exportPromptPreset} from '../yimu/prompt-settings.mjs';
const clone=value=>structuredClone(value);
function fixture(onSave){
    const dom=textCollectionDom(),create=dom.doc.createElement,saves=[],errors=[],exports=[];
    dom.doc.createElement=tag=>{const node=create(tag);if(tag==='span')Object.defineProperty(node,'innerHTML',{set(value){assert.match(value,/^<svg xmlns=/);}});return node;};
    const view=mountPromptView(dom.parent,{document:dom.doc,onSave:async(...args)=>{saves.push(clone(args));return onSave?.(...args);},onError:error=>errors.push(error),onExport:value=>exports.push(value)});
    const render=value=>view.render({settings:{},scope:'chat-a',revision:2,...value});render();
    return{...dom,view,saves,errors,exports,render};
}

test('each title has check/close controls and only that entry draft is submitted',async()=>{
    const f=fixture(),first=f.get('叙事与依据提示词正文'),second=f.get('叙事质感提示词正文');
    assert.equal(first.value,DEFAULT_PROMPTS.groups.summary[0].text);
    first.value='只保留明确事实';first.emit('input');second.value='另一条尚未保存';second.emit('input');
    f.render({revision:3});assert.equal(f.get('叙事与依据提示词正文'),first);assert.equal(second.value,'另一条尚未保存');
    f.get('保存叙事与依据').click();await f.wait(()=>f.get('保存叙事与依据').disabled);
    assert.equal(f.parent.textContent.includes('提示词已保存'),false);
    assert.equal(f.saves[0][0].groups.summary[0].text,'只保留明确事实');assert.equal(f.saves[0][0].groups.summary[1].text,DEFAULT_PROMPTS.groups.summary[1].text);assert.equal(f.saves[0][1].revision,3);
    assert.equal(second.value,'另一条尚未保存');f.get('撤销叙事质感修改').click();assert.equal(second.value,DEFAULT_PROMPTS.groups.summary[1].text);
    assert.equal(f.get('保存提示词'),undefined);assert.equal(f.get('取消提示词修改'),undefined);f.view.destroy();
});

test('in-flight saves keep newer typing and serialize another row without including unsubmitted drafts',async()=>{
    const releases=[],f=fixture(()=>new Promise(resolve=>releases.push(resolve))),first=f.get('叙事与依据提示词正文'),second=f.get('叙事质感提示词正文');
    first.value='第一版';first.emit('input');f.get('保存叙事与依据').click();assert.equal(first.disabled,false);
    first.value='保存过程中输入的新草稿';first.emit('input');second.value='第二条已明确保存';second.emit('input');f.get('保存叙事质感').click();
    assert.equal(f.saves.length,1);assert.equal(f.byClass('ym-prompt-drag').emit('dragstart').defaultPrevented,true);
    releases[0]();await f.wait(()=>f.saves.length===2);assert.equal(f.saves[1][1].revision,3);assert.equal(f.saves[1][0].groups.summary[0].text,'第一版');
    assert.equal(f.saves[1][0].groups.summary[1].text,'第二条已明确保存');releases[1]();await f.wait(()=>f.byClass('ym-prompts').getAttribute('aria-busy')==='false'&&f.get('保存叙事质感').disabled);
    assert.equal(first.value,'保存过程中输入的新草稿');f.get('保存叙事与依据').click();assert.equal(f.saves[2][1].revision,4);releases[2]();f.view.destroy();
});

test('preset select automatically loads, includes built-in default, and never clears the preset library',async()=>{
    const config=clone(DEFAULT_PROMPTS);config.presets=[{id:'short',name:'简洁',groups:clone(config.groups)}];config.presets[0].groups.summary[0].text='短规则';
    const f=fixture();f.render({settings:{prompts:config}});const select=f.get('总结提示词预设');assert.equal(select.value,BUILTIN_PROMPT_PRESET);
    select.value='short';select.emit('change');await f.wait(()=>f.saves.length===1&&f.get('叙事与依据提示词正文').value==='短规则');
    select.value=BUILTIN_PROMPT_PRESET;select.emit('change');await f.wait(()=>f.saves.length===2&&f.get('叙事与依据提示词正文').value===DEFAULT_PROMPTS.groups.summary[0].text);
    assert.equal(f.saves[1][0].presets.length,1);assert.equal(f.get('删除提示词预设').disabled,true);
    assert.equal(f.get('载入提示词预设'),undefined);assert.equal(f.get('恢复内置默认'),undefined);
    for(const node of f.all().filter(node=>node.tagName==='BUTTON')){if(node.getAttribute('role')!=='tab')assert.equal(node.textContent,'');assert.ok(node.getAttribute('aria-label'));assert.ok(node.title);}
    assert.equal(f.get('保存为预设').parentNode,select.parentNode);assert.equal(f.get('新增条目').parentNode,select.parentNode);assert.equal(f.get('导入').parentNode,select.parentNode);f.view.destroy();
});

test('structural changes, switches and sorting persist directly while text remains a row draft',async()=>{
    const f=fixture(),text=f.get('叙事与依据提示词正文');text.value='不要夹带';text.emit('input');
    f.get('启用叙事与依据').click();f.get('下移叙事与依据').click();f.get('新增条目').click();
    await f.wait(()=>f.saves.length===3&&f.get('自定义提示词提示词正文'));
    assert.equal(f.saves[0][0].groups.summary[0].enabled,false);assert.equal(f.saves[0][0].groups.summary[0].text,DEFAULT_PROMPTS.groups.summary[0].text);
    assert.equal(f.saves[1][0].groups.summary[1].id,'facts');assert.equal(text.value,'不要夹带');
    f.get('删除自定义提示词').click();await f.wait(()=>f.saves.length===4);assert.equal(f.get('自定义提示词提示词正文'),undefined);f.view.destroy();
});

test('late scope completion does not touch the new scope and detached old row callbacks are ignored',async()=>{
    let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;})),old=f.get('叙事与依据提示词正文'),oldSave=f.get('保存叙事与依据');
    old.value='旧聊天已提交';old.emit('input');oldSave.click();old.value='旧聊天后续草稿';old.emit('input');
    f.render({scope:'chat-b'});const newer=f.get('叙事与依据提示词正文');newer.value='新聊天草稿';newer.emit('input');
    release();await f.wait(()=>f.saves.length===1&&f.parent.textContent.includes('有条目草稿'));assert.equal(newer.value,'新聊天草稿');
    oldSave.click();assert.equal(f.saves.length,1);f.render();assert.equal(f.get('叙事与依据提示词正文'),old);assert.equal(old.value,'旧聊天后续草稿');f.view.destroy();
});

test('failed row save retains drafts; an explicit retry rebases only its patch and preserves remotely added presets',async()=>{
    let reject=true;const f=fixture(async()=>{if(reject)throw new Error('offline');}),text=f.get('叙事与依据提示词正文');
    text.value='未丢失的草稿';text.emit('input');f.get('保存叙事与依据').click();await f.wait(()=>f.errors.length===1);
    assert.equal(text.value,'未丢失的草稿');const remote=clone(DEFAULT_PROMPTS);remote.presets=[{id:'remote',name:'另一端预设',groups:clone(remote.groups)}];
    f.render({settings:{prompts:remote},revision:5});reject=false;f.get('重试本次提示词保存').click();await f.wait(()=>f.saves.length===2&&f.get('保存叙事与依据').disabled);
    assert.equal(f.saves[1][1].revision,5);assert.equal(f.saves[1][0].presets[0].id,'remote');assert.equal(f.saves[1][0].groups.summary[0].text,'未丢失的草稿');f.view.destroy();
});

test('cancelling a different row never silently retries a failed save; its own check can retry the latest text',async()=>{
    let reject=true;const f=fixture(async()=>{if(reject)throw new Error('offline');}),first=f.get('叙事与依据提示词正文'),second=f.get('叙事质感提示词正文');
    first.value='失败的旧草稿';first.emit('input');f.get('保存叙事与依据').click();await f.wait(()=>f.errors.length===1);
    second.value='另一条临时修改';second.emit('input');f.get('撤销叙事质感修改').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.saves.length,1);
    first.value='当前明确重试的新草稿';first.emit('input');reject=false;f.get('保存叙事与依据').click();await f.wait(()=>f.saves.length===2&&f.get('保存叙事与依据').disabled);
    assert.equal(f.saves[1][0].groups.summary[0].text,'当前明确重试的新草稿');f.view.destroy();
});

test('imports are validated before explicit replacement, keep existing presets, and late file reads do not cross scopes',async()=>{
    const f=fixture(),config=clone(DEFAULT_PROMPTS);config.presets=[{id:'mine',name:'现有预设',groups:clone(config.groups)}];f.render({settings:{prompts:config}});
    const file=f.get('导入忆幕提示词文件');file.files=[{name:'safe.json',size:100,text:async()=>exportPromptPreset(DEFAULT_PROMPTS)}];file.emit('change');
    await f.wait(()=>f.visible(f.get('确认提示词操作')));assert.equal(f.saves.length,0);f.get('确认提示词操作').click();await f.wait(()=>f.saves.length===1);assert.equal(f.saves[0][0].presets[0].id,'mine');
    let resolve;file.files=[{name:'late.json',size:100,text:()=>new Promise(yes=>{resolve=yes;})}];file.emit('change');f.render({scope:'chat-b'});resolve(exportPromptPreset(DEFAULT_PROMPTS));await new Promise(yes=>setTimeout(yes,0));
    assert.equal(f.visible(f.get('确认提示词操作')),false);f.view.destroy();
});

test('presets save with an explicit save icon and are editable without a selected chat',async()=>{
    const f=fixture();f.render({scope:'global',snapshot:null,revision:7,disabled:false});
    const text=f.get('叙事与依据提示词正文');text.value='全局规则';text.emit('input');f.get('保存叙事与依据').click();await f.wait(()=>f.saves.length===1);
    assert.equal(f.saves[0][1].scope,'global');assert.equal(f.saves[0][1].snapshot,null);
    f.get('保存为预设').click();f.get('总结提示词预设名称').value='全局预设';f.get('确认保存提示词预设').click();await f.wait(()=>f.saves.length===2);
    assert.equal(f.saves[1][0].presets[0].name,'全局预设');assert.equal(f.saves[1][0].presets[0].groups.summary[0].text,'全局规则');f.view.destroy();
});

test('recall state badge still reflects its single functional setting',()=>{
    const f=fixture();f.render({recallEnabled:false});f.get('原文回查').click();assert.equal(f.byClass('ym-prompt-recall-badge').textContent,'未开启');
    f.render({recallEnabled:true});assert.equal(f.byClass('ym-prompt-recall-badge').textContent,'已开启');f.view.destroy();
});
