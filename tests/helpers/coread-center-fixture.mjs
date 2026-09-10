import vm from 'node:vm';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export const coreadCenterFunctions=['renderMemSwitch','renderCoreadCenterStatus','renderCoreadSpoilerGuard',
  'coreadGuideSteps','coreadGuideCurrent','coreadGuideTargetClass','renderCoreadGuide','renderCoreadPackBar'].map(section).join('\n');

export function createCoreadCenterFixture(){
  const trace=[],inputs={meta:{title:'Book<&',progress:60},fallback:{progress:40},safe:[{id:1}]};
  const c=vm.createContext({COREAD_MEMORY_ENABLED:true,coreadGuideStep:null,
    readerDialog:{bookId:'book',readBoundary:{progress:12.5},slices:[{id:1},{id:2},{id:3}]},
    coreadBookMeta:id=>{trace.push(['meta',id]);return inputs.meta;},
    coreadCurrentReadBoundarySync:id=>{trace.push(['boundary',id]);return inputs.fallback;},
    coreadSafeSlices:(rows,boundary,memory)=>{trace.push(['safe',rows,boundary,memory]);return inputs.safe;},
    htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
  vm.runInContext(coreadCenterFunctions,c);return {c,trace,inputs};
}
