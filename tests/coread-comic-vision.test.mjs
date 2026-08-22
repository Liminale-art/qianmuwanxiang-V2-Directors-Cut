import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseComicArchive } from '../qianmu-reader.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

class FakeZip {
  static async loadAsync() {
    const image = (value) => ({ async: async () => Uint8Array.from([value]) });
    return {
      files: {
        '10.jpg': image(10),
        '2.png': image(2),
        'folder/1.webp': image(1),
        '__MACOSX/3.jpg': image(3),
        '.hidden/4.jpg': image(4),
        'notes.txt': image(9),
      },
    };
  }
}

const parsed = await parseComicArchive(new ArrayBuffer(0), FakeZip);
assert.equal(parsed.pageCount, 3, 'CBZ 只应读取可见图片');
assert.deepEqual(parsed.images.map((item) => item.name), ['2.png', '10.jpg', 'folder/1.webp'], '漫画页必须按自然文件名排序');
assert.deepEqual(parsed.chapters.map((item) => item.content), ['⟦img:1⟧', '⟦img:2⟧', '⟦img:3⟧']);

// 导入和阅读模式。
assert.match(source, /COREAD_BOOK_ACCEPT[\s\S]*\.cbz[\s\S]*image\/\*/, '书架必须接收 CBZ 和连续图片');
assert.match(source, /coreadHandleImportFiles\(files/, '导入必须保留多文件选择');
assert.match(source, /mode:\s*'comic'[\s\S]*pageCount/, '漫画必须保存独立模式和页数');
assert.match(source, /sd-reader-comic-mode/, '漫画阅读页必须有独立布局');
assert.match(css, /\.sd-reader-comic-mode \.sd-reader-inline-img/, '漫画图片必须使用独立阅读样式');

// 视觉识别严格止于当前页，并在写记忆前让用户校对。
const analyze = source.slice(source.indexOf('async function coreadAnalyzeComicPages'), source.indexOf('// 发送/生成分离'));
assert.match(analyze, /const toIndex = Math\.max\(0, readerView\.chapterIndex/, '漫画识图终点必须是当前页');
assert.doesNotMatch(analyze, /toIndex\s*\+\s*cfg\.pagesPerBatch/, '漫画识图不得向未来页面扩展');
assert.match(analyze, /尚未建稿、且与当前页连续的过去页面/, '识图批次必须避开已保存范围，防止重复记忆');
assert.match(analyze, /coreadConfirmComicSummary[\s\S]*coreadPersistSlice/, '视觉文字稿必须先校对再写入记忆切片');
assert.match(source, /if \(meta\.mode === 'comic'\) return \{ ok: false, reason: '漫画请在阅读页使用识图按钮/, '漫画不得误走正文占位符蒸馏');
assert.match(source, /if \(coreadBookMeta\(id\)\?\.mode === 'comic'\) return;/, '漫画不得触发自动正文蒸馏');

// 图片对话：本地存储、可移除预览，书友与幕伴助手共用视觉模型但消息池仍隔离。
assert.match(source, /sd-reader-dialog-image[\s\S]*sd-reader-dialog-image-input sd-reader-native-file[\s\S]*accept="image\/\*"[\s\S]*multiple/, '伴读输入框必须使用 iOS 兼容的原生控件支持多图选择');
assert.match(source, /coreadPersistPendingChatImages[\s\S]*putReaderImage/, '发送前必须将图片保存到本书本地媒体仓');
assert.match(source, /coreadAskAssistant\(text, imageIds\)[\s\S]*coreadAppendUserMessage\(text, imageIds\)/, '图片必须能分别发给幕伴助手或书友');
assert.match(source, /pendingUsers\.flatMap[\s\S]*callCoreadVisionModel/, '书友回复必须读取本轮图片并调用视觉模型');
assert.match(source, /comicDescriptions: rec\?\.comicDescriptions[\s\S]*version: 4/, '数据打包必须携带漫画视觉文字稿并升级格式');
assert.match(css, /\.sd-reader-chat-pending[\s\S]*\.sd-reader-chat-images/, '待发送和已发送图片都必须有隔离样式');
assert.match(css, /#sd-reader-portal \.sd-reader-dialog-image \.sd-reader-dialog-image-input[^}]*inset:\s*0[^}]*clip-path:\s*none/, '发图控件必须直接覆盖按钮，避免 iOS 丢失用户手势');

console.log('Coread comic vision and image dialogue contract OK');
