import test from 'node:test';
import assert from 'node:assert/strict';
import { selectQianmuClassicTheme } from '../qianmu-appearance-actions.js';
import { createQianmuClassicPainter } from '../qianmu-appearance-portals.js';
import { QUICK_HIVE_THEME_PALETTES, READER_PORTAL_BG, THEME_KEYS } from '../qianmu-classic-palettes.js';

function action(settings, { saveError=false, paintError=false }={}) {
    const paints=[], saves=[];
    return {paints,saves,run:themeKey=>selectQianmuClassicTheme({settings,themeKey,
        resolveLogo:key=>'owned-'+key,save(){saves.push(settings.theme);if(saveError)throw Error('save failed');},
        session:{repaintClassic({resolveLogo}){paints.push([settings.theme,settings.appearance,resolveLogo(settings.theme)]);if(paintError)throw Error('paint failed');}},
    })};
}
test('a classic choice saves once, keeps legacy-only settings legacy-only and same choice is inert',()=>{
    const settings={theme:'light',unrelated:{draft:'keep'}},f=action(settings);
    assert.equal(f.run('dark'),true);assert.equal(settings.theme,'dark');assert.equal(Object.hasOwn(settings,'appearance'),false);
    assert.deepEqual(f.saves,['dark']);assert.equal(f.paints.length,1);assert.equal(f.paints[0][2],'owned-dark');assert.equal(f.run('dark'),false);assert.equal(f.paints.length,1);assert.equal(settings.unrelated.draft,'keep');
});
test('return to the saved classic also explicitly exits a new family while preserving its next-use preferences',()=>{
    const settings={theme:'dream',appearance:{version:1,family:'glass',mode:'dark',source:'manual',accent:'#123456',harmony:'complementary'}},f=action(settings);
    assert.equal(f.run('dream'),true);assert.deepEqual(settings.appearance,{version:1,family:'classic',mode:'dark',source:'manual',accent:'#123456',harmony:'complementary'});assert.deepEqual(f.saves,['dream']);assert.equal(f.paints.length,1);
});
test('unknown keys or future appearance versions leave settings, pixels and persistence untouched',()=>{
    for(const settings of [{theme:'light'},{theme:'light',appearance:{version:99,family:'glass'}}]){
        const before=structuredClone(settings),f=action(settings);assert.throws(()=>f.run(settings.appearance?'dark':'injected key'),TypeError);assert.deepEqual(settings,before);assert.equal(f.paints.length,0);assert.equal(f.saves.length,0);
    }
});
test('synchronous save/paint failures roll back the original object and missing keys, without masking the first error',()=>{
    for(const config of [{saveError:true},{paintError:true}])for(const settings of [{},{theme:'candy',appearance:{version:1,family:'glass'}}]){
        const before=structuredClone(settings),original=settings.appearance,f=action(settings,config);
        assert.throws(()=>f.run('dark'),config.saveError?/save failed/:/paint failed/);assert.deepEqual(settings,before);assert.equal(settings.appearance,original);assert.equal(f.paints.length,2);
    }
});

function node(className=''){
    const styles=new Map(),classes=new Set(className.split(' ').filter(Boolean)),image={src:'old',getAttribute(){return this.src;},setAttribute(_,value){this.src=value;}};
    return {id:'owned',image,children:['draft'],classList:{contains:key=>classes.has(key),add:key=>classes.add(key),remove:(...keys)=>keys.forEach(key=>classes.delete(key))},classes,
        style:{getPropertyValue:key=>styles.get(key)?.value||'',getPropertyPriority:key=>styles.get(key)?.priority||'',setProperty:(key,value,priority='')=>styles.set(key,{value,priority}),removeProperty:key=>styles.delete(key)},
        setAttribute(){},remove(){this.removed=true;},querySelector:()=>image};
}
function painter(themeKey){
    let probe;const document={createElement:()=>probe=node(),body:{appendChild(){}},defaultView:{getComputedStyle:()=>({getPropertyValue:key=>key==='--sd-danger'?'':`classic-${themeKey}-${key}`})}};
    const paint=createQianmuClassicPainter(document,themeKey,{resolveLogo:key=>'owned-'+key});assert.equal(probe.removed,true);return paint;
}
test('classic painter changes only known classes and copied colour aliases, preserving priorities and unrelated state',()=>{
    const root=node('sd-theme-dark sd-hive-theme-dark keep sd-theme-custom');root.style.setProperty('--sd-text','old','important');root.style.setProperty('--sd-font','custom');root.style.setProperty('--sd-danger','old');root.style.setProperty('left','17px');
    painter('summer')(root);assert.deepEqual([...root.classes].sort(),['keep','sd-hive-theme-summer','sd-theme-custom','sd-theme-summer']);
    assert.equal(root.style.getPropertyValue('--sd-text'),'classic-summer---sd-text');assert.equal(root.style.getPropertyPriority('--sd-text'),'important');assert.equal(root.style.getPropertyValue('--sd-danger'),'');assert.equal(root.style.getPropertyValue('--sd-font'),'custom');assert.equal(root.style.getPropertyValue('left'),'17px');assert.deepEqual(root.children,['draft']);
});
test('classic main inline overrides are not mistaken for copied portal tokens',()=>{
    const root=node('sd-theme-dark');root.id='story-director-modal';root.style.setProperty('--sd-text','owner-override');painter('dream')(root);assert.equal(root.style.getPropertyValue('--sd-text'),'owner-override');assert.equal(root.classes.has('sd-theme-dream'),true);
});
test('six classic palettes recolor existing hive nodes and swap only the existing main logo source',()=>{
    for(const key of THEME_KEYS){const paint=painter(key),main=node('sd-hive-theme-light'),image=main.image,entry=node('is-glass-dark'),palette=QUICK_HIVE_THEME_PALETTES[key];
        entry.style.setProperty('background-image','owner-image');entry.style.setProperty('top','93px');
        paint(main,{role:'hive-main'});paint(entry,{role:'hive-entry',tone:'dark',edgeIndex:5});
        assert.equal(main.image,image);assert.equal(image.src,'owned-'+key);assert.equal(main.style.getPropertyValue('--sd-float-edge'),palette.mainEdge);assert.equal(entry.style.getPropertyValue('--sd-wheel-edge'),palette.edges[5%palette.edges.length]);assert.equal(entry.style.getPropertyValue('color'),palette.darkIcon);assert.equal(entry.style.getPropertyValue('background-color'),palette.darkFill);assert.equal(entry.style.getPropertyPriority('color'),'important');assert.equal(entry.style.getPropertyValue('background-image'),'owner-image');assert.equal(entry.style.getPropertyValue('top'),'93px');
    }
});
test('readers gain opaque classic tokens even with no copied main panel, but neutral media backdrop is untouched',()=>{
    const reader=node(),media=node();media.style.setProperty('background-color','neutral');const paint=painter('kraft');
    paint(reader,{role:'reader'});paint(media,{role:'media'});
    assert.equal(reader.style.getPropertyValue('--sd-portal-bg'),READER_PORTAL_BG.kraft);assert.equal(reader.style.getPropertyValue('background-color'),READER_PORTAL_BG.kraft);assert.equal(reader.style.getPropertyValue('--sd-text'),'classic-kraft---sd-text');assert.equal(media.style.getPropertyValue('background-color'),'neutral');assert.equal(media.style.getPropertyValue('--sd-text'),'');
});
