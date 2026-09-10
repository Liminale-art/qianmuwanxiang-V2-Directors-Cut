import vm from 'node:vm';
import * as panelView from '../../qianmu-reader-panel-view.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export const coreadPanelFunctions=['renderReaderVoiceClips','renderReaderNotes','renderReaderMarks'].map(section).join('\n');
export const panelEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function createCoreadPanelFixture(){
  const c=vm.createContext({...panelView,readerView:{noteSearch:'',noteFilter:'all'},readerDialog:{messages:[]},htmlEscape:panelEscape});
  vm.runInContext(coreadPanelFunctions,c);return c;
}
