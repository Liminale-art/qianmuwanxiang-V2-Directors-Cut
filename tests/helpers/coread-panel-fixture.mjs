import vm from 'node:vm';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export const coreadPanelFunctions=['renderReaderVoiceClips','renderReaderNotes','renderReaderMarks'].map(section).join('\n');
export const panelEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function createCoreadPanelFixture(){
  const c=vm.createContext({readerView:{noteSearch:'',noteFilter:'all'},readerDialog:{messages:[]},htmlEscape:panelEscape});
  vm.runInContext(coreadPanelFunctions,c);return c;
}
