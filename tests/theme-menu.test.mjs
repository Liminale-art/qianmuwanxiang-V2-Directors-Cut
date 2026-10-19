import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderQianmuThemeMenu, bindQianmuThemeMenu } from '../qianmu-theme-menu.js';

const skinStyles = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');

function fixture() {
    function node(className, parent = null) {
        const events = new Map(), attributes = new Map(), classes = new Set([className]);
        return { className, parent, events, hidden: false, disabled: false, isConnected: true, dataset: {},
            style: { setProperty(key, value) { this[key] = value; } },
            classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
            setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key) ?? null,
            addEventListener(type, listener) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(listener); },
            removeEventListener(type, listener) { events.get(type)?.delete(listener); },
            emit(type, data = {}) { const event = { type, target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...data }; for (const listener of [...events.get(type) || []]) listener(event); return event; },
            contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; },
            closest(selector) { return selector === '.' + className ? this : parent?.closest(selector); },
            focus() { document.activeElement = this; },
        };
    }
    const document = node('document'), root = node('root'), pick = node('sd-theme-pick', root), trigger = node('sd-theme-btn', pick), menu = node('sd-theme-menu', pick);
    root.ownerDocument = document; root.querySelector = () => pick;
    pick.querySelector = selector => selector === '.sd-theme-btn' ? trigger : menu;
    menu.hidden = true;
    const buttons = ['light', 'dark', 'summer'].map(key => { const button = node('sd-theme-opt', menu); button.dataset.theme = key; button.setAttribute('aria-checked', String(key === 'dark')); return button; });
    menu.querySelectorAll = () => buttons;
    const outside = node('outside');
    return { document, root, pick, trigger, menu, buttons, outside, node, listenerCount: () => document.events.get('click')?.size || 0 };
}

function colorFixture(initial = {}) {
    const f = fixture(), picker = f.node('sd-theme-custom-picker', f.menu), color = f.node('sd-theme-color', f.menu), custom = f.node('sd-theme-custom-color', f.menu);
    const hex = f.node('sd-theme-hex', picker), rgb = ['r','g','b'].map(channel => { const input=f.node('channel',picker);input.dataset.channel=channel;return input; });
    const hue=f.node('sd-theme-hue',picker),sv=f.node('sd-theme-sv',picker),marker=f.node('i',sv),captures=[];
    sv.querySelector=()=>marker;sv.getBoundingClientRect=()=>({left:10,top:20,width:100,height:100});
    sv.setPointerCapture=id=>captures.push(['capture',id]);sv.releasePointerCapture=id=>captures.push(['release',id]);
    picker.hidden=true;picker.querySelector=selector=>({'.sd-theme-hex':hex,'.sd-theme-hue':hue,'.sd-theme-sv':sv}[selector]||null);picker.querySelectorAll=()=>rgb;
    f.menu.querySelector=selector=>({'.sd-theme-custom-picker':picker,'.sd-theme-color':color,'.sd-theme-custom-color':custom}[selector]||null);
    const frames=new Map(),view=f.node('view');let frameId=0;
    view.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};view.cancelAnimationFrame=id=>frames.delete(id);f.document.defaultView=view;
    const accentButton=f.node('sd-theme-opt',f.menu);accentButton.dataset.appearanceAccent='#b86773';f.buttons.push(accentButton);
    const classicFamily=f.node('sd-theme-opt',f.menu);classicFamily.dataset.appearanceFamily='classic';f.buttons.push(classicFamily);
    let preference={family:'glass',mode:'dark',accent:'#527c69',source:'cover',classic:'dark',...initial}, fail=false, resource='ready', nextResult=null;
    const changes=[], appearance={read:()=>preference,status:()=>resource,sync:()=>Promise.resolve(),change:patch=>{changes.push(patch);if(fail)throw new Error('test save failure');preference={...preference,...patch};const result=nextResult;nextResult=null;return result||Promise.resolve();}};
    const dispose=bindQianmuThemeMenu(f.root,()=>{preference={...preference,family:'classic'};},appearance);
    f.trigger.emit('click');custom.emit('click');
    return {...f,picker,color,custom,hex,rgb,hue,sv,marker,captures,frames,accentButton,classicFamily,appearance,changes,dispose,
        frame:()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback());},
        result:promise=>{nextResult=promise;},status:value=>{resource=value;},
        fail:(value=true)=>{fail=value;},press:(target,key,extra={})=>f.pick.emit('keydown',{target,key,...extra})};
}

test('custom color markup places an accessible native hue slider between SV and four labelled fields',async()=>{
    const html=renderQianmuThemeMenu([], 'light', {supported:true});
    assert.match(html,/sd-theme-sv/);assert.equal((html.match(/data-channel=/g)||[]).length,3);
    assert.match(html,/>Hex<input class="sd-theme-hex" type="text" maxlength="7" autocomplete="off" spellcheck="false" aria-label="Hex 颜色"/);
    assert.match(html,/<input class="sd-theme-hue" type="range" min="0" max="360" step="1" value="0" aria-label="色相">/);
    assert.ok(html.indexOf('sd-theme-sv')<html.indexOf('sd-theme-hue'));
    assert.ok(html.indexOf('sd-theme-hue')<html.indexOf('sd-theme-rgb'));
    const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
    assert.match(css,/\.sd-theme-rgb \{[^}]+repeat\(3, minmax\(0, 1fr\)\) minmax\(0, 1\.8fr\)/);
    assert.match(css,/#story-director-modal#story-director-modal \.sd-theme-rgb input \{[^}]+color: var\(--sd-text\) !important; -webkit-text-fill-color: currentColor !important/);
});

test('RGB/Hex commit only complete values, normalize shorthand and synchronize both representations',()=>{
    const f=colorFixture();
    assert.deepEqual(f.rgb.map(input=>input.value),['82','124','105']);assert.equal(f.hex.value,'#527c69');
    for(const value of ['', '-1','256','1.5','1e2']){f.rgb[0].value=value;f.rgb[0].emit('change');assert.equal(f.changes.length,0);}
    f.rgb[0].value='200';f.rgb[0].emit('change');assert.equal(f.hex.value,'#c87c69');
    for(const value of ['', '#','#12','#1234','#12345','#gggggg']){f.hex.value=value;f.hex.emit('change');assert.equal(f.changes.length,1);}
    f.hex.value='#0Cf';f.hex.emit('change');assert.equal(f.hex.value,'#00ccff');assert.deepEqual(f.rgb.map(input=>input.value),['0','204','255']);assert.equal(f.color.value,'#00ccff');
    f.hex.value='#123aBc';f.press(f.hex,'Enter');assert.equal(f.hex.value,'#123abc');
    f.hex.emit('change');assert.equal(f.changes.length,3);f.dispose();
});

test('picker keyboard retains internal Tab and Enter while Escape and focus departure close',()=>{
    const f=colorFixture();
    assert.equal(f.press(f.rgb[0],'Tab').prevented,undefined);assert.equal(f.menu.hidden,false);
    f.hex.value='#abc';assert.equal(f.press(f.hex,'Enter').prevented,true);assert.equal(f.menu.hidden,false);
    f.pick.emit('focusout',{relatedTarget:f.rgb[1]});assert.equal(f.menu.hidden,false);
    f.outside.focus();f.pick.emit('focusout',{relatedTarget:f.outside});assert.equal(f.menu.hidden,true);assert.equal(f.document.activeElement,f.outside);
    f.trigger.emit('click');f.custom.emit('click');f.press(f.hex,'Escape');assert.equal(f.menu.hidden,true);assert.equal(f.document.activeElement,f.trigger);f.dispose();
});

test('failed custom field save rolls back once and disposer removes every added listener',()=>{
    const f=colorFixture();f.fail();f.hex.value='#123456';f.press(f.hex,'Enter');
    assert.equal(f.hex.value,'#527c69');assert.equal(f.appearance.read().source,'cover');
    f.hex.emit('change');assert.equal(f.changes.length,1);
    f.dispose();f.dispose();
    for(const node of [f.hex,...f.rgb])assert.equal(node.events.get('change')?.size||0,0);
    assert.equal(f.pick.events.get('focusout')?.size||0,0);
    f.hex.value='#abcdef';f.hex.emit('change');f.press(f.hex,'Enter');assert.equal(f.changes.length,1);
});

test('pending resource settlement leaves the focused uncommitted draft intact',async()=>{
    const f=colorFixture();f.hex.focus();f.hex.value='#12';await Promise.resolve();await Promise.resolve();
    assert.equal(f.hex.value,'#12');assert.equal(f.appearance.read().accent,'#527c69');assert.equal(f.changes.length,0);f.dispose();
});

test('hue covers all HSV primaries and preserves the red 360 endpoint through refresh and reopen',async()=>{
    const f=colorFixture({accent:'#ff0000',source:'manual'});
    for(const [value,hex] of [[0,'#ff0000'],[60,'#ffff00'],[120,'#00ff00'],[180,'#00ffff'],[240,'#0000ff'],[300,'#ff00ff'],[360,'#ff0000']]){
        f.hue.value=String(value);f.hue.emit('input');
        assert.equal(f.hex.value,hex,'local RGB feedback is immediate');
        assert.equal(f.hue.value,String(value));assert.equal(f.hue.style['--sd-hue-thumb'],`hsl(${value} 100% 50%)`);
        f.hue.emit('change');assert.equal(f.appearance.read().accent,hex);assert.equal(f.color.value,hex);
        await Promise.resolve();assert.equal(f.hue.value,String(value));
    }
    f.trigger.emit('click');f.trigger.emit('click');f.custom.emit('click');
    assert.equal(f.hue.value,'360');assert.equal(f.hex.value,'#ff0000');
    f.dispose();
});

test('gray and black retain latent hue and black retains saturation until SV restores visibility',()=>{
    const f=colorFixture({accent:'#808080',source:'manual'});
    f.hue.value='240';f.hue.emit('input');f.hue.emit('change');
    assert.equal(f.appearance.read().accent,'#808080');assert.equal(f.changes.length,0);assert.equal(f.hue.value,'240');
    assert.match(f.sv.style.backgroundImage,/hsl\(240 100% 50%\)/);
    f.sv.emit('pointerdown',{pointerId:1,button:0,clientX:110,clientY:20});f.sv.emit('pointerup',{pointerId:1});
    assert.equal(f.appearance.read().accent,'#0000ff');assert.equal(f.hue.value,'240');
    f.hex.value='#000000';f.hex.emit('change');assert.equal(f.hue.value,'240');assert.equal(f.marker.style.left,'100%');
    f.hue.value='120';f.hue.emit('input');f.frame();assert.equal(f.hex.value,'#000000');assert.equal(f.hue.value,'120');
    f.press(f.sv,'ArrowUp',{shiftKey:true});assert.equal(f.appearance.read().accent,'#001a00');
    f.hex.value='#fff';f.hex.emit('change');assert.equal(f.hue.value,'120');assert.equal(f.marker.style.left,'0%');
    f.press(f.sv,'ArrowRight',{shiftKey:true});assert.equal(f.appearance.read().accent,'#e6ffe6');
    f.dispose();
});

test('RGB and Hex edits synchronize hue and native range keyboard handling remains available',()=>{
    const f=colorFixture();f.hex.value='#00ffff';f.hex.emit('change');assert.equal(f.hue.value,'180');
    f.rgb[0].value='255';f.rgb[1].value='0';f.rgb[2].value='255';f.rgb[2].emit('change');assert.equal(f.hue.value,'300');
    for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Tab']){
        assert.equal(f.press(f.hue,key).prevented,undefined);assert.equal(f.menu.hidden,false);
    }
    f.press(f.sv,'ArrowLeft',{shiftKey:true});assert.equal(f.hex.value,'#ff19ff');
    assert.equal(f.sv.getAttribute('aria-valuetext'),'饱和度 90%，明度 100%');
    f.dispose();
});

test('continuous hue and touch SV drags coalesce updates and capture only the active pointer',async()=>{
    const f=colorFixture({accent:'#ff0000',source:'manual'});
    for(let h=1;h<=120;h++){f.hue.value=String(h);f.hue.emit('input');}
    assert.equal(f.frames.size,1);assert.equal(f.changes.length,0);assert.equal(f.hex.value,'#00ff00');
    await Promise.resolve();assert.equal(f.hex.value,'#00ff00','late resource sync must not replace queued coordinates');
    f.frame();assert.equal(f.changes.length,1);assert.equal(f.appearance.read().accent,'#00ff00');
    f.sv.emit('pointerdown',{pointerId:9,button:0,pointerType:'touch',clientX:10,clientY:20});
    assert.deepEqual(f.captures,[['capture',9]]);
    f.sv.emit('pointermove',{pointerId:10,clientX:110,clientY:120});assert.equal(f.hex.value,'#ffffff');
    for(let x=11;x<=60;x++)f.sv.emit('pointermove',{pointerId:9,buttons:0,pointerType:'touch',clientX:x,clientY:70});
    assert.equal(f.frames.size,1);assert.equal(f.changes.length,1);
    f.sv.emit('pointerup',{pointerId:9});assert.equal(f.frames.size,0);assert.equal(f.changes.length,2);
    assert.equal(f.appearance.read().accent,'#408040');assert.deepEqual(f.captures,[['capture',9],['release',9]]);
    f.frame();assert.equal(f.changes.length,2);f.dispose();
});

test('SV focuses before pointer ownership so the previous Hex blur cannot swallow pointerup commit',()=>{
    const f=colorFixture();f.hex.value='#8b584a';f.press(f.hex,'Enter');f.hex.focus();
    const focus=f.sv.focus.bind(f.sv);
    f.sv.focus=()=>{f.hex.emit('change');focus();};
    // Real browsers synchronously send lostpointercapture on release. It must
    // neither undo pointerup's saved value nor cancel a subsequent interaction.
    f.sv.releasePointerCapture=id=>{f.captures.push(['release',id]);f.sv.emit('lostpointercapture',{pointerId:id});};
    f.sv.emit('pointerdown',{pointerId:4,button:0,clientX:82,clientY:48});
    assert.deepEqual(f.captures,[['capture',4]]);assert.equal(f.changes.length,1);assert.equal(f.frames.size,1);
    f.sv.emit('pointerup',{pointerId:4});
    assert.equal(f.frames.size,0);assert.equal(f.changes.length,2);
    assert.notEqual(f.appearance.read().accent,'#8b584a');assert.equal(f.hex.value,f.appearance.read().accent);assert.equal(f.color.value,f.hex.value);
    assert.deepEqual(f.captures,[['capture',4],['release',4]]);f.frame();assert.equal(f.changes.length,2);f.dispose();
});

test('async resource failures preserve accepted settings and ignore superseded requests',async()=>{
    const f=colorFixture({accent:'#ff0000',source:'manual'});
    let reject;f.result(new Promise((_,no)=>{reject=no;}));
    f.hue.value='120';f.hue.emit('input');f.frame();reject(new Error('resource paint rejected'));
    await Promise.resolve();await Promise.resolve();
    assert.equal(f.appearance.read().accent,'#00ff00');assert.equal(f.hex.value,'#00ff00');assert.equal(f.hue.value,'120');
    assert.match(f.trigger.getAttribute('aria-label'),/外观切换未完成/);
    f.result(new Promise((_,no)=>{reject=no;}));f.hue.value='180';f.hue.emit('input');f.frame();
    f.hue.value='240';f.hue.emit('input');f.frame();reject(new Error('stale resource failure'));
    await Promise.resolve();await Promise.resolve();
    assert.equal(f.appearance.read().accent,'#0000ff');assert.equal(f.hex.value,'#0000ff');assert.equal(f.hue.value,'240');
    assert.equal(f.trigger.getAttribute('aria-label'),'外观主题');
    let resolve;f.result(new Promise(yes=>{resolve=yes;}));f.hue.value='300';f.hue.emit('input');f.frame();
    f.status('error');resolve(false);await Promise.resolve();await Promise.resolve();
    assert.equal(f.appearance.read().accent,'#ff00ff');assert.equal(f.hex.value,'#ff00ff');assert.equal(f.appearance.read().source,'manual');
    assert.match(f.trigger.getAttribute('aria-label'),/外观资源未加载/);f.dispose();
});

test('an old resource rejection cannot replace queued HSV preview or write after disposal',async()=>{
    const f=colorFixture({accent:'#ff0000',source:'manual'});
    let reject;f.result(new Promise((_,no)=>{reject=no;}));f.hue.value='120';f.hue.emit('input');f.frame();
    f.hue.value='240';f.hue.emit('input');reject(new Error('resource failed before next paint'));
    await Promise.resolve();await Promise.resolve();
    assert.equal(f.hex.value,'#0000ff');assert.equal(f.hue.value,'240');assert.equal(f.appearance.read().accent,'#00ff00');
    f.frame();assert.equal(f.appearance.read().accent,'#0000ff');assert.equal(f.trigger.getAttribute('aria-label'),'外观主题');
    f.result(new Promise((_,no)=>{reject=no;}));f.hue.value='300';f.hue.emit('input');f.frame();
    const attempts=f.changes.length;f.dispose();reject(new Error('resource rejected after disposal'));
    await Promise.resolve();await Promise.resolve();
    assert.equal(f.changes.length,attempts);assert.equal(f.trigger.getAttribute('aria-label'),'外观主题');assert.equal(f.menu.hidden,true);
});

test('a failed hue or SV save restores exact editing coordinates and trailing change preserves the error',()=>{
    const f=colorFixture({accent:'#ff0000',source:'manual'});
    f.hue.value='360';f.hue.emit('input');f.hue.emit('change');assert.equal(f.changes.length,0);
    f.fail();f.hue.value='120';f.hue.emit('input');f.frame();
    assert.equal(f.appearance.read().accent,'#ff0000');assert.equal(f.hue.value,'360');assert.equal(f.hex.value,'#ff0000');
    assert.match(f.trigger.getAttribute('aria-label'),/颜色切换未完成/);
    f.hue.emit('change');assert.equal(f.changes.length,1);assert.match(f.trigger.getAttribute('aria-label'),/颜色切换未完成/);
    f.sv.emit('pointerdown',{pointerId:3,button:0,clientX:60,clientY:70});f.sv.emit('pointerup',{pointerId:3});
    assert.equal(f.marker.style.left,'100%');assert.equal(f.marker.style.top,'0%');assert.equal(f.hue.value,'360');
    f.fail(false);f.hue.value='240';f.hue.emit('input');f.hue.emit('change');
    assert.equal(f.appearance.read().accent,'#0000ff');assert.equal(f.trigger.getAttribute('aria-label'),'外观主题');f.dispose();
});

test('closing, cancellation, preset selection and disposal never save an abandoned queued drag',()=>{
    for(const exit of ['close','custom','outside','cancel','lostcapture','preset','classic','dispose']){
        const f=colorFixture({accent:'#ff0000',source:'manual'});
        f.sv.emit('pointerdown',{pointerId:5,button:0,clientX:60,clientY:70});assert.equal(f.frames.size,1);
        if(exit==='close')f.press(f.hue,'Escape');
        if(exit==='custom')f.custom.emit('click');
        if(exit==='outside')f.document.emit('click',{target:f.outside});
        if(exit==='cancel')f.sv.emit('pointercancel',{pointerId:5});
        if(exit==='lostcapture')f.sv.emit('lostpointercapture',{pointerId:5});
        if(exit==='preset')f.menu.emit('click',{target:f.accentButton});
        if(exit==='classic')f.menu.emit('click',{target:f.classicFamily});
        if(exit==='dispose')f.dispose();
        assert.equal(f.frames.size,0,exit);f.frame();
        assert.equal(f.changes.length,exit==='preset'?1:0,exit);
        assert.equal(f.appearance.read().accent,exit==='preset'?'#b86773':'#ff0000',exit);
        assert.deepEqual(f.captures,[['capture',5],['release',5]],exit);f.dispose();
        for(const node of [f.hue,f.sv])for(const listeners of node.events.values())assert.equal(listeners.size,0,exit);
    }
});

test('theme markup preserves radio semantics, explicit button types and escaped descriptors', () => {
    const html = renderQianmuThemeMenu([{ key: 'light', name: '日间', dot: '#fff' }, { key: 'dark', name: '<img onerror="x">', dot: '#000' }], 'dark');
    assert.equal((html.match(/type="button"/g) || []).length, 3);
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
    assert.match(html, /aria-haspopup="menu" aria-expanded="false" aria-controls="qianmu-appearance-menu"/);
    assert.match(html, /&lt;img onerror=&quot;x&quot;&gt;/); assert.doesNotMatch(html, /<img/);
    assert.match(html, /data-theme="dark"/); assert.match(html, /role="menu" aria-label="外观主题" hidden/);
});

test('compact menu shows current family controls immediately without disclosure',()=>{
    const themes=['light','dark','summer','candy','kraft','dream'].map(key=>({key,name:key,dot:'#fff'}));
    const html=renderQianmuThemeMenu(themes,'dream',{supported:true,settings:{theme:'dream',appearance:{version:1,family:'glass',mode:'dark'}}});
    for(const {key} of themes)assert.match(html,new RegExp(`data-theme="${key}"`));
    assert.match(html,/data-appearance-family="editorial"/);assert.match(html,/aria-checked="true" data-appearance-family="glass"/);assert.match(html,/data-appearance-family="classic"/);
    assert.equal((html.match(/data-appearance-family=/g)||[]).length,3);
    assert.match(html,/class="sd-theme-details" role="group" aria-label="主题颜色">/);
    assert.match(html,/class="sd-theme-accent-options" role="group" aria-label="强调色">/);
    assert.match(html,/class="sd-theme-classic-options" role="group" aria-label="经典颜色" hidden/);
    assert.doesNotMatch(html,/data-appearance-family="[^"]+" aria-expanded/);
    assert.match(html,/data-appearance-mode-toggle aria-label="切换至日间"/);
    assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/sd-theme-retry/);
    const legacy=renderQianmuThemeMenu(themes,'dark',{supported:false,settings:{appearance:{version:1,family:'glass'}}});assert.doesNotMatch(legacy,/data-appearance-family|data-appearance-mode/);assert.equal((legacy.match(/aria-checked="true"/g)||[]).length,1);
});

test('both new families expose safe curated and custom accent controls, not the legacy palette',()=>{
    for(const family of ['glass','editorial']){
        const html=renderQianmuThemeMenu([], 'light', {supported:true,settings:{appearance:{version:1,family,accent:'#AbC',mode:'light'}}});
        assert.equal((html.match(/data-appearance-accent=/g)||[]).length,6);
        assert.match(html,/type="color" value="#aabbcc" aria-label="自定强调色"/);
        assert.match(html,/sd-theme-custom-color sd-theme-swatch active/);
        assert.match(html,/data-appearance-mode-toggle aria-label="切换至夜间"/);
        assert.doesNotMatch(html,/>日间<|>夜间</);
    }
});

test('appearance families are text-only and mode leads the accent row without a redundant heading',()=>{
    const html=renderQianmuThemeMenu([], 'light', {supported:true});
    const families=html.slice(html.indexOf('class="sd-theme-family-options"'), html.indexOf('id="qianmu-theme-details"'));
    assert.doesNotMatch(families,/sd-theme-dot|<svg|<img/);
    for(const name of ['纸间','极简','经典'])assert.match(families,new RegExp(`>${name}<`));
    assert.doesNotMatch(families, /流光/);
    assert.match(families, /data-appearance-family="glass"[^>]*><span class="sd-theme-name">极简<\/span>/);
    assert.match(html,/class="sd-theme-swatches"><button[^>]+data-appearance-mode-toggle/);
    assert.doesNotMatch(html,/sd-theme-detail-head|>强调色<|>\+</);
    assert.match(html,/sd-theme-custom-color[^>]*><span aria-hidden="true"><\/span><input/);
});

test('classic palettes keep all exact identities and accessible names while rendering only color dots',()=>{
    const themes=['light','dark','summer','candy','kraft','dream'].map(key=>({key,name:`颜色${key}`,dot:'#abcd12'}));
    const html=renderQianmuThemeMenu(themes,'summer',{supported:true});
    const classic=html.slice(html.indexOf('class="sd-theme-classic-options"'),html.indexOf('class="sd-theme-accent-options"'));
    assert.equal((classic.match(/sd-theme-swatch/g)||[]).length,6);
    assert.doesNotMatch(classic,/sd-theme-name|<svg|sd-theme-mode-toggle/);
    for(const {key,name} of themes)assert.match(classic,new RegExp(`data-theme="${key}" aria-label="${name}" title="${name}"`));
    assert.match(classic,/aria-checked="true" data-theme="summer"/);
});

test('rainbow custom dot remains circular independently of the rectangular editorial button shell',async()=>{
    const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
    assert.match(css,/\.sd-theme-custom-color > span \{ background: conic-gradient\(/);
    assert.match(css,/\.sd-theme-swatch > span \{[^}]+border-radius: 50%/);
    assert.match(css,/\.sd-theme-classic-options \{[^}]+repeat\(6,/);
    assert.match(css,/\.sd-theme-swatches \{[^}]+repeat\(8,/);
});

test('new skin roots rebind heading gradients after leaving the classic dream palette', () => {
    const root = skinStyles.match(/:is\(#story-director-modal, \[data-qm-theme\]\):is\(\[data-qm-theme="editorial"\], \[data-qm-theme="glass"\]\) \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(root, /--sd-title-grad:\s*linear-gradient\(92deg,\s*var\(--qm-accent\),\s*var\(--qm-ink\)\)/);
    assert.match(root, /--sd-subtitle-grad:\s*linear-gradient\(90deg,\s*var\(--qm-accent\),\s*var\(--qm-muted\)\s*70%\)/);
    assert.doesNotMatch(root, /#c79ad6|#8f9fe0|#79c7c0/);
});

test('the production header no longer renders the tagline in any family',async()=>{
    const entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const start=entry.indexOf('function renderModal()'),render=entry.slice(start,entry.indexOf('\nfunction ',start+1));
    assert.doesNotMatch(render,/一蝶振翅|万象入幕/);
    assert.match(render,/<h2>\$\{EXTENSION_NAME\}<\/h2>/);
});

test('repeated trigger open/close owns at most one document listener', () => {
    const f = fixture(), cleanup = bindQianmuThemeMenu(f.root, () => assert.fail('toggle selected a theme'));
    for (let i = 0; i < 30; i++) {
        f.trigger.emit('click'); assert.equal(f.listenerCount(), 1); assert.equal(f.menu.hidden, false); assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(f.document.activeElement, f.buttons[1]);
        f.trigger.emit('click'); assert.equal(f.listenerCount(), 0); assert.equal(f.menu.hidden, true); assert.equal(f.document.activeElement, f.trigger);
    }
    cleanup(); cleanup(); assert.equal(f.listenerCount(), 0);
});

test('outside close does not consume the outside action or steal its focus', () => {
    const f = fixture(); bindQianmuThemeMenu(f.root, () => {}); f.trigger.emit('click');
    f.document.activeElement = f.outside;
    const event = f.document.emit('click', { target: f.outside });
    assert.equal(f.menu.hidden, true); assert.equal(f.listenerCount(), 0); assert.equal(event.stopped, undefined); assert.equal(f.document.activeElement, f.outside);
});

test('menu bounds listeners are open-only and disposed across repeated toggles', () => {
    const f = fixture();
    f.document.defaultView = f.outside;
    f.outside.visualViewport = f.buttons[0];
    const cleanup = bindQianmuThemeMenu(f.root, () => {});
    const counts = () => [f.document.events.get('scroll')?.size || 0, f.outside.events.get('resize')?.size || 0,
        f.buttons[0].events.get('resize')?.size || 0, f.buttons[0].events.get('scroll')?.size || 0];
    assert.deepEqual(counts(), [0, 0, 0, 0]);
    for (let i = 0; i < 5; i++) {
        f.trigger.emit('click'); assert.deepEqual(counts(), [1, 1, 1, 1]);
        assert.doesNotThrow(() => f.outside.emit('resize', { target: {} }), 'window targets are not DOM Nodes');
        f.trigger.emit('click'); assert.deepEqual(counts(), [0, 0, 0, 0]);
    }
    f.trigger.emit('click'); cleanup(); cleanup(); assert.deepEqual(counts(), [0, 0, 0, 0]);
});

test('keyboard navigation skips unavailable options and Escape/Tab restore the trigger', () => {
    const f = fixture(); bindQianmuThemeMenu(f.root, () => {}); f.buttons[0].disabled = true;
    f.pick.emit('keydown', { target: f.trigger, key: 'ArrowDown' }); assert.equal(f.document.activeElement, f.buttons[1]);
    f.pick.emit('keydown', { key: 'ArrowDown' }); assert.equal(f.document.activeElement, f.buttons[2]);
    f.pick.emit('keydown', { key: 'ArrowDown' }); assert.equal(f.document.activeElement, f.buttons[1]);
    f.pick.emit('keydown', { key: 'End' }); assert.equal(f.document.activeElement, f.buttons[2]);
    f.pick.emit('keydown', { key: 'Home' }); assert.equal(f.document.activeElement, f.buttons[1]);
    const escape = f.pick.emit('keydown', { key: 'Escape' }); assert.equal(escape.stopped, true); assert.equal(f.document.activeElement, f.trigger); assert.equal(f.listenerCount(), 0);
    f.pick.emit('keydown', { target: f.trigger, key: 'ArrowUp' }); assert.equal(f.document.activeElement, f.buttons[2]);
    const tab = f.pick.emit('keydown', { key: 'Tab' }); assert.equal(tab.prevented, undefined); assert.equal(f.document.activeElement, f.trigger); assert.equal(f.listenerCount(), 0);
});

test('selection closes before calling its owner and rejects disabled or mutated options', () => {
    const f = fixture(), chosen = [];
    bindQianmuThemeMenu(f.root, key => { assert.equal(f.menu.hidden, true); assert.equal(f.listenerCount(), 0); chosen.push(key); });
    f.menu.emit('click', { target: f.buttons[0] }); assert.deepEqual(chosen, []);
    f.trigger.emit('click'); f.buttons[0].disabled = true; f.menu.emit('click', { target: f.buttons[0] });
    f.buttons[1].dataset.theme = 'unknown'; f.menu.emit('click', { target: f.buttons[1] }); assert.deepEqual(chosen, []);
    f.menu.emit('click', { target: f.buttons[2] }); assert.deepEqual(chosen, ['summer']);
});

test('disposal releases all owned listeners, does not refocus and is reentrant-safe', () => {
    const f = fixture(); let count = 0;
    const cleanup = bindQianmuThemeMenu(f.root, () => { count++; cleanup(); });
    f.trigger.emit('click'); f.menu.emit('click', { target: f.buttons[0] });
    assert.equal(count, 1); assert.equal(f.listenerCount(), 0);
    for (const [node, event] of [[f.trigger, 'click'], [f.menu, 'click'], [f.pick, 'keydown']]) assert.equal(node.events.get(event)?.size || 0, 0);
    f.trigger.emit('click'); f.menu.emit('click', { target: f.buttons[2] }); assert.equal(count, 1);
    cleanup();
    const g = fixture(), release = bindQianmuThemeMenu(g.root, () => {}); g.trigger.emit('click'); g.document.activeElement = g.outside; release();
    assert.equal(g.document.activeElement, g.outside); assert.equal(g.menu.hidden, true); assert.equal(g.listenerCount(), 0);
});

test('absent menu on storyboard pages is an inert disposer', () => {
    const cleanup = bindQianmuThemeMenu({ querySelector: () => null }, () => assert.fail()); cleanup(); cleanup();
});

test('successful in-place selection updates radio state and returns focus, a rejected action keeps the old radio',()=>{
    for(const accepted of [true,false]){
        const f=fixture();bindQianmuThemeMenu(f.root,()=>accepted);f.trigger.emit('click');f.menu.emit('click',{target:f.buttons[2]});
        assert.equal(f.document.activeElement,f.trigger);assert.equal(f.buttons[2].getAttribute('aria-checked'),String(accepted));assert.equal(f.buttons[1].getAttribute('aria-checked'),String(!accepted));
    }
});

test('production rerender, allowed close and extension disposal all release menu ownership', async () => {
    const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const closeStart = entry.indexOf('function closeModal()'), close = entry.slice(closeStart, entry.indexOf('\nfunction ', closeStart + 1));
    assert.match(close, /^function closeModal\(\) \{\s*if \(focusClockBlockExit\(\)\) return;/);
    assert.match(close, /document.getElementById\(MODAL_ID\)\?\._sdGalleryToolbarCleanup\?\.\(\);/);
    assert.match(close, /document.getElementById\(MODAL_ID\)\?\._sdThemeMenuCleanup\?\.\(\);/);
    assert.match(entry, /modal\._sdThemeMenuCleanup\?\.\(\);\s*storyboardCaptureTagDraft/);
    const panelsStart = entry.indexOf("clean('panels',"), panels = entry.slice(panelsStart, entry.indexOf("\n    clean('", panelsStart + 1));
    assert.match(panels, /document.getElementById\(MODAL_ID\)\?\._sdThemeMenuCleanup\?\.\(\);/);
    assert.match(entry, /renderQianmuThemeMenu\(THEMES, themeKey, \{settings,supported:appearanceSession.supported\}\)/);
    const start = entry.indexOf('function renderModal()'), render = entry.slice(start, entry.indexOf('\nfunction ', start + 1));
    assert.equal(/const themePick =|const closeOnce =/.test(render), false, 'the old leaking menu binder must be removed from renderModal');
    const module = await readFile(new URL('../qianmu-theme-menu.js', import.meta.url), 'utf8');
    assert.doesNotMatch(module, /localStorage|indexedDB|fetch\(|renderModal|saveSettings|MutationObserver/);
});
