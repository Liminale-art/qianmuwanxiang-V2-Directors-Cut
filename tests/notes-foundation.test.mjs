import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  clearTemporaryQianmuNotes,
  createQianmuNote,
  deleteQianmuNote,
  listQianmuNotes,
  normalizeQianmuNote,
  saveQianmuNote,
} from '../qianmu-notes.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const storeSource = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

const clipped = normalizeQianmuNote({ id: 'n', title: 'a'.repeat(150), body: 'b'.repeat(21000), width: 10, height: 900 });
assert.equal(clipped.title.length, 120, '便笺标题必须限制长度');
assert.equal(clipped.body.length, 20000, '便笺正文必须限制长度');
assert.equal(clipped.width, 220, '浮贴宽度不得小于可编辑范围');
assert.equal(clipped.height, 620, '浮贴高度不得突破安全上限');

clearTemporaryQianmuNotes();
const temporary = createQianmuNote({ body: '只活在本次 ST 会话', pinned: false, floating: true });
await saveQianmuNote(temporary);
assert.ok((await listQianmuNotes()).some((note) => note.id === temporary.id), '临时便笺应在当前运行态可见');
await deleteQianmuNote(temporary.id);
assert.ok(!(await listQianmuNotes()).some((note) => note.id === temporary.id), '删除后不得残留临时便笺');

assert.match(storeSource, /DB_VERSION = 6[\s\S]*STORE_NOTES = 'notes'/, '数据库升级必须建立独立便笺仓');
assert.match(storeSource, /STORE_NOTES.*recoverable: false/, '固定便笺不得进入安全清理白名单');
assert.match(source, /id: 'notes', label: '便笺'/, '蜂巢必须具备便笺入口');
assert.match(source, /sd-notes-global-entry[\s\S]*notesPanelOpen \? renderNotesPanel/, '千幕任意子页必须保留顶层便笺入口');
assert.match(source, /note\.pinned = !note\.pinned[\s\S]*note\.floating = !note\.floating/, '固定与浮贴必须是两个独立动作');
assert.match(source, /addEventListener\('dragend'[\s\S]*note\.floating = true/, 'PC 从列表拖出必须转为 ST 浮贴');
assert.match(source, /settings\.notes\.enabled[\s\S]*固定内容仍安全保留/, '关闭便笺功能只能隐藏 UI，不能删除固定内容');
assert.doesNotMatch(source, /QianmuNote[\s\S]{0,120}applyDirectorInjection/, '便笺不得进入导演注入链');

console.log('Notes foundation contract OK');
