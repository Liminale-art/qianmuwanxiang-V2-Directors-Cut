import test from 'node:test';
import assert from 'node:assert/strict';
import * as books from '../qianmu-blobstore.js';

test('invalid book edits fail before accessing storage rather than becoming imports', async () => {
  assert.equal(typeof books.updateBookMetadata, 'function');
  for (const [id, patch] of [['', {title:'Book'}], ['book', {}], ['book', {title:'  '}], ['book', {title:3}], ['book', {title:'Book', author:3}]]) {
    await assert.rejects(books.updateBookMetadata(id, patch), TypeError);
  }
});

test('a dismissed editor does not need a database connection to decline its save', async () => {
  assert.equal(typeof books.updateBookMetadata, 'function');
  assert.deepEqual(await books.updateBookMetadata('book', {title:'Book'}, {isCurrent:()=>false}), {status:'stale'});
});
