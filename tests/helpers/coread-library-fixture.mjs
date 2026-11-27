import vm from 'node:vm';
import * as libraryView from '../../qianmu-reader-library-view.js';
import * as shelf from '../../features/reader/qianmu-reader-shelf.js';
import {htmlEscape,readerCoverPlaceholder} from '../../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export const libraryFunctions=['coreadBookMeta','coreadCollections','sortedLibraryBooks','allLibraryTags',
  'coreadBookPalNames','buildShelfSearchIndex','renderLibraryBookItem','renderLibraryCollectionItem','renderLibraryView'].map(section).join('\n');
export function createLibraryFixture(){
  const data={books:[],collections:[],libCollectionId:'',libTags:[],libSort:'addedAt-desc',libViewMode:'grid'};
  const c=vm.createContext({...libraryView,...shelf,readerLog:null,shelfSearchField:'all',shelfSearchIndex:null,coreadTagColor:tag=>shelf.tagColor(tag,data.tagColors),coread:()=>data,htmlEscape,readerCoverPlaceholder,COREAD_BOOK_ACCEPT:'fixture-books-only'});
  vm.runInContext(libraryFunctions,c);return {c,data};
}
