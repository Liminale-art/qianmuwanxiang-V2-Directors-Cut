import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chatStorageName} from '../../yimu/server-store.mjs';
import {applyOperation, fingerprintMessages} from '../../yimu/contract.mjs';

// 「原文回查与补充」已去掉（2026-11-24），服务端不再新建原文摘录；但早先存下的摘录（kind 'excerpt'）
// 仍要能读取、显示、屏蔽、删除、改成自定义。这里把一条「当年回查存下的」摘录直接写进聊天的忆幕资料，
// 走与服务端当年相同的合同操作（applyOperation 的 recall 分支）生成指针，不经已删除的回查接口。
// 只存指针（楼层、字符区间、父切片版本），引文本身照旧只在读取时从 ST 原文里取出。
const digest = text => createHash('sha256').update(text).digest('hex');

export async function plantExcerpt({account, binding, messages, parentId, floor, text, entryId, triggerSource = null}) {
    const file = path.join(account, '.yimu', chatStorageName(binding));
    const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    const document = envelope.value, parent = document.entries.find(entry => entry.id === parentId);
    if (!parent?.source) throw new Error(`夹具里没有可挂摘录的切片：${parentId}`);
    const message = messages[floor - 1], start = message?.mes.indexOf(text) ?? -1;
    if (start < 0) throw new Error(`第 ${floor} 层原文里没有这段引文`);
    const hashes = await fingerprintMessages(messages);
    const trigger = triggerSource || {start: parent.source.end + 1, end: parent.source.end + 1, hashes: [hashes[parent.source.end]]};
    const ref = {id: parent.id, revision: parent.revision};
    const excerpt = {kind: 'excerpt', text: '原文补充', parent: ref, source: {start: floor, end: floor, hashes: [hashes[floor - 1]]}, quote: {start, end: start + text.length}};
    const values = {id: `plant_${entryId}`, type: 'recall', entryId, expectedRevision: document.revision, expectedEpoch: document.epoch,
        parent: ref, triggerSource: trigger, quote: {floor, text}};
    // 与服务端一样只留操作内容的摘要作回执，引文不随回执落盘。
    const operation = {...values, receipt: digest(JSON.stringify(values))};
    const {document: next} = applyOperation(document, operation, {excerpt});
    await fs.writeFile(file, JSON.stringify({schema: 1, value: next, checksum: digest(JSON.stringify(next))}), 'utf8');
    return next.entries.find(entry => entry.id === entryId);
}
