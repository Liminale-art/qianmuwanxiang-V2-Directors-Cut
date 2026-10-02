import {createStoryboardWorldbookController} from '../../qianmu-storyboard-worldbooks.js';
export function installWorldbookFixture(context, overrides={}) {
  const runtime=createStoryboardWorldbookController({
    state:()=>context.storyboardState(),context:()=>context.ctx?.()||{},chatKey:()=>context.getChatKey?.()||'fixture',epoch:()=>context.storyboardAdmissionEpoch||0,
    loadModules:async()=>({main:{user_avatar:'fixture-persona.png'},world:{getWorldInfoSettings:()=>({world_info:{}})}}),
    names:()=>context.listWorldBooks?.()||[],entries:name=>context.getWorldBookEntries?.(name)||[],
    clean:value=>context.storyboardCleanMessageText?.(value)??value,resolve:value=>context.resolveMacro?.(value)??value,
    save:()=>context.saveSettings?.(),render:()=>{},toast:()=>{},format:{},...overrides,
  });
  context.storyboardWorldbookRuntime=()=>runtime;
  context.storyboardPrepareWorldContext=(state,guard)=>runtime.prepare(state,guard);
  return runtime;
}
