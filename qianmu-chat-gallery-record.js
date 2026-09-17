import { chatCharacterReceiptRequest, chatCharacterReceiptError } from './qianmu-chat-character-receipt.js';
import { comfyReferencePath } from './qianmu-comfy-reference-contract.js';
import { galleryCatalogTags } from './qianmu-gallery-catalog-contract.js';

export const CHAT_GALLERY_RECORD_RESPONSE_BYTES = 32768;
const fail = (code, message, status = 400) => { throw chatCharacterReceiptError(code, message, status); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
export function chatGalleryRecordSelection(value) {
    if (!exact(value, ['recordId', 'createdAt', 'gallerySha256']) || !id(value.recordId) || !time(value.createdAt)
        || typeof value.gallerySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.gallerySha256)) fail('contract', '历史画面定位或来源摘要无效');
    return { ...value };
}
export function chatGalleryRecordRequest(value) {
    if (!exact(value, ['version', 'expectedAccount', 'target', 'selection'])) fail('contract', '历史画面读取请求不兼容');
    const base = chatCharacterReceiptRequest({ version: value.version, expectedAccount: value.expectedAccount, target: value.target });
    return { ...base, selection: chatGalleryRecordSelection(value.selection) };
}
export function projectChatGalleryRecord(value) {
    if (!value || !id(value.id) || !time(value.createdAt)) fail('record_content', '历史画面标识或生成时间不完整', 409);
    let url, tags;
    try { url = comfyReferencePath(value.url); } catch (_) { fail('record_url', '此画面没有可跨聊天读取的 ST 原图，请在原聊天查看；未请求外部链接', 422); }
    try { tags = galleryCatalogTags(value.tags); } catch (_) { fail('record_content', '历史画面标签不兼容，请保留原记录', 409); }
    // Render-only allowlist. Never return recipes, prompts, arbitrary metadata,
    // provider credentials, unrelated records, inline state or mutation handles.
    return { id: value.id, createdAt: value.createdAt, url, tags };
}
export function chatGalleryRecordResponse(value) {
    if (!exact(value, ['ok', 'version', 'expectedAccount', 'target', 'gallerySha256', 'record', 'proof']) || value.ok !== true || value.proof !== 'read-only-record'
        || !exact(value.record, ['id', 'createdAt', 'url', 'tags'])) fail('contract', '历史画面返回不兼容');
    const request = chatGalleryRecordRequest({ version: value.version, expectedAccount: value.expectedAccount, target: value.target,
        selection: { recordId: value.record.id, createdAt: value.record.createdAt, gallerySha256: value.gallerySha256 } });
    const record = projectChatGalleryRecord(value.record);
    if (JSON.stringify(record) !== JSON.stringify({ id: value.record.id, createdAt: value.record.createdAt, url: value.record.url, tags: value.record.tags })
        || new TextEncoder().encode(JSON.stringify(value)).byteLength > CHAT_GALLERY_RECORD_RESPONSE_BYTES) fail('contract', '历史画面返回格式或大小不符');
    return { ...value, target: request.target, record };
}
