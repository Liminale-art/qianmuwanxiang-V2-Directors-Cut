import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
import {QIANMU_HIVE_COMMANDS} from '../qianmu-hive-commands.js';
import {qianmuIconMarkup} from '../qianmu-icon-renderer.js';

const dashboard=QIANMU_HIVE_COMMANDS.find(command=>command.id==='dashboard');
const iconHint=html=>html.match(/data-qm-icon="([^"]+)"/)?.[1];

test('initial next-scene controls use the same semantic icon as the hive and retain the stop state',()=>{
  const c=vm.createContext({busy:false,settings:{newcomerMode:false}});
  vm.runInContext(storyboardFunctionSource('renderGenerateRow'),c);
  const idle=c.renderGenerateRow();
  assert.equal(iconHint(idle),dashboard.glyph);
  assert.equal(qianmuIconMarkup(iconHint(idle)),qianmuIconMarkup(dashboard.glyph),'same semantic renderer retains all appearance groups');
  assert.match(idle,/推演下一幕/);
  assert.doesNotMatch(idle,/sd-as-stop|fa-stop/);
  c.busy=true;
  const running=c.renderGenerateRow();
  assert.match(running,/sd-as-stop/);
  assert.match(running,/<i class="fa-solid fa-stop"><\/i>停止推演/);
  assert.equal(iconHint(running),undefined,'an idle override must not replace the stop glyph');
});

test('busy-to-idle rerender restores the hive icon on every next-scene button without affecting theater actions',()=>{
  const control=()=>({disabled:false,innerHTML:'',classes:new Set(),classList:{toggle(name,on){on?this.owner.classes.add(name):this.owner.classes.delete(name);}}});
  const generation=[control(),control()],theater=[control()],refreshed=[];
  for(const item of [...generation,...theater])item.classList.owner=item;
  const c=vm.createContext({busy:false,theaterBusy:false,settings:{enabled:true},document:{querySelectorAll:selector=>selector==='.sd-generate-main'?generation:theater},applyQianmuIcons:item=>refreshed.push(item)});
  vm.runInContext(storyboardFunctionSource('renderBusyState'),c);
  for(const busy of [false,true,false]){
    c.busy=busy;c.renderBusyState();
    for(const item of generation){
      assert.equal(item.classes.has('sd-as-stop'),busy);
      assert.equal(item.disabled,false);
      assert.equal(iconHint(item.innerHTML),busy?undefined:dashboard.glyph);
      assert.match(item.innerHTML,busy?/fa-stop.*停止推演/:/推演下一幕/);
    }
    assert.match(theater[0].innerHTML,/fa-masks-theater.*上演此幕/);
    assert.equal(iconHint(theater[0].innerHTML),undefined);
  }
  assert.equal(refreshed.length,9,'all changed controls pass through the existing scoped icon refresh');
  c.settings.enabled=false;c.renderBusyState();
  assert.ok([...generation,...theater].every(item=>item.disabled));
});

test('all literal next-scene idle entry points carry the dedicated hint, without reclassifying clapperboard globally',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const idle=[...source.matchAll(/<i class="fa-solid fa-clapperboard"([^>]*)><\/i>推演下一幕/g)];
  assert.equal(idle.length,2);
  for(const match of idle)assert.equal(match[1],` data-qm-icon="${dashboard.glyph}"`);
  const floorUi=await readFile(new URL('../qianmu-tts-floor-ui.js',import.meta.url),'utf8');
  assert.match(floorUi,/class="sd-tts-trigger"[^>]*><i class="fa-solid fa-clapperboard" data-qm-icon="voice-lines"/,'the dialogue extraction icon is an unrelated consumer');
});
