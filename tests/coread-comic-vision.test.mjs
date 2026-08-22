import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseComicArchive, parseMobi } from '../qianmu-reader.js';

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

function buildClassicMobiComic() {
  const html = Buffer.from('<html><body><img recindex="00001" alt="封面"/><mbp:pagebreak/><img recindex="00002" alt="第 1 页"/></body></html>', 'utf8');
  const record0 = Buffer.alloc(300);
  record0.writeUInt16BE(1, 0);              // PalmDOC: uncompressed
  record0.writeUInt16BE(1, 8);              // one text record
  record0.write('MOBI', 16, 'ascii');
  record0.writeUInt32BE(232, 20);
  record0.writeUInt32BE(65001, 28);
  record0.writeUInt32BE(2, 0x6c);            // first image = PalmDB record 2
  const records = [record0, html, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const headerSize = 78 + records.length * 8;
  const output = Buffer.alloc(headerSize + records.reduce((sum, record) => sum + record.length, 0));
  output.writeUInt16BE(records.length, 76);
  let offset = headerSize;
  records.forEach((record, index) => {
    output.writeUInt32BE(offset, 78 + index * 8);
    record.copy(output, offset);
    offset += record.length;
  });
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

const mobiComic = parseMobi(buildClassicMobiComic());
assert.equal(mobiComic.pageCount, 2, '经典 MOBI 的 recindex 图片必须按正文页序解析');
assert.deepEqual(mobiComic.chapters.map((chapter) => chapter.content), ['⟦img:1⟧', '⟦img:2⟧']);
assert.deepEqual(mobiComic.images.map((image) => image.mime), ['image/jpeg', 'image/png']);

// 导入和阅读模式。
const accept = /const COREAD_BOOK_ACCEPT = '([^']+)'/.exec(source)?.[1] || '';
assert.match(accept, /\.epub[\s\S]*\.mobi[\s\S]*\.cbz/, '书架必须接收 EPUB、MOBI 和 CBZ 漫画容器');
assert.doesNotMatch(accept, /image\/\*|\.jpg|\.png/, '书架不得继续接收散装单图或连续图片');
assert.doesNotMatch(source, /sd-reader-import-input[^>]*multiple|sd-reader-refill-input[^>]*multiple/, '书籍导入与跨端补全必须一次选择一个电子书容器');
assert.match(source, /comicPages \/ parsed\.chapters\.length >= \.8/, '图片型 EPUB 必须自动进入漫画阅读模式');
assert.match(source, /!text && parsed\.pageCount && parsed\.images/, '图片型 MOBI 必须自动进入漫画阅读模式');
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
assert.match(source, /sd-reader-dialog-send[\s\S]*sd-reader-dialog-image-input sd-reader-native-file[\s\S]*accept="image\/\*"[\s\S]*multiple/, '伴读输入框必须保留 iOS 兼容的原生多图控件');
assert.match(source, /coreadPersistPendingChatImages[\s\S]*putReaderImage/, '发送前必须将图片保存到本书本地媒体仓');
assert.match(source, /coreadAskAssistant\(text, imageIds\)[\s\S]*coreadAppendUserMessage\(text, imageIds\)/, '图片必须能分别发给幕伴助手或书友');
assert.doesNotMatch(source, /看看这张图。/, '纯图片气泡不得自动附加占位文字');
assert.match(source, /if \(\(!content && !images\.length\) \|\| dialogBusy\) return/, '只有图片没有文字时仍必须允许发送');
assert.match(source, /String\(m\.text \|\| ''\)\.trim\(\) \? `<button class="sd-reader-msg-action" data-act="speak"/, '只有存在文字的气泡才显示播放按钮');
assert.match(source, /pendingUsers\.flatMap[\s\S]*callCoreadVisionModel/, '书友回复必须读取本轮图片并调用视觉模型');
assert.match(source, /comicDescriptions: rec\?\.comicDescriptions[\s\S]*version: 4/, '数据打包必须携带漫画视觉文字稿并升级格式');
assert.match(css, /\.sd-reader-chat-pending[\s\S]*\.sd-reader-chat-images/, '待发送和已发送图片都必须有隔离样式');
assert.match(source, /openDialogImagePicker[\s\S]*showPicker/, '图片选择必须优先使用浏览器原生 showPicker 用户手势接口');
assert.match(source, /pointerdown[\s\S]*pointerup[\s\S]*heldFor < 520[\s\S]*openDialogImagePicker/, '长按发送键必须在原生 pointerup 用户手势中打开图片选择器');
assert.match(source, /dialogImageInput\?\.addEventListener\('change'[\s\S]*coreadAddPendingChatImages[\s\S]*void doSend\(\)/, '长按选图完成后必须直接发送');
assert.doesNotMatch(source, /<label class="sd-reader-inbtn sd-reader-dialog-image"/, '对话输入框不得再保留拥挤的独立图片按钮');
assert.match(css, /\.sd-reader-dialog-send\.is-image-hold/, '长按图片动作必须提供即时视觉反馈');

console.log('Coread comic vision and image dialogue contract OK');
