import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionEditorText,collectionEditorValue} from '../qianmu-text-collection-presentation.js';

test('editor compacts only paragraph separators while untouched saves retain exact original whitespace',()=>{
    const original='\r\n\n  开头缩进😀  \r\n\r\n \n\t\n正文二\n\n\n';
    assert.equal(collectionEditorText(original),'  开头缩进😀  \n\n正文二');
    assert.equal(collectionEditorValue(original,collectionEditorText(original)),original);
    assert.equal(collectionEditorValue(original,'改写\n\n正文二'),'改写\n\n正文二');
});
