import { chatCharacterReceiptError } from './qianmu-chat-character-receipt.js';
import { chatGalleryRecordRequest, chatGalleryRecordSelection } from './qianmu-chat-gallery-record.js';

export const CHAT_GALLERY_DETAILS_RESPONSE_BYTES = 256 * 1024;
const textFields = Object.freeze({ source: 80, model: 240, prompt: 24000, finalPrompt: 24000, negative: 12000, effectiveNegative: 12000, artistString: 6000, sampler: 240, scheduler: 240 });
const scalarFields = ['width', 'height', 'seed', 'steps', 'cfg'];
const recipeStates = ['inline', 'reference-only', 'unavailable', 'not-recorded'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw chatCharacterReceiptError('details_content', '原画面生成信息不兼容或超过显示上限，未截断内容', 409); };
function generationFields(raw) {
    const result = {};
    for (const [name, limit] of Object.entries(textFields)) {
        const value = raw[name] ?? null;
        if (value !== null && (typeof value !== 'string' || value.length > limit)) fail();
        result[name] = value;
    }
    for (const name of scalarFields) {
        const value = raw[name] ?? null;
        if (value !== null && !(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && value.length <= 120)) fail();
        result[name] = value;
    }
    return result;
}
// Read-only display fields only. No current settings, snapshot hydration, secrets,
// arbitrary workflow payloads, snapshot keys, media URL, body or unrelated records.
export function projectChatGalleryDetails(raw) {
    if (!object(raw)) fail();
    if (raw.snapshot != null && !object(raw.snapshot) || raw.snapshotRef != null && typeof raw.snapshotRef !== 'string'
        || raw.recipeUnavailable != null && typeof raw.recipeUnavailable !== 'boolean') fail();
    chatGalleryRecordSelection({ recordId: raw.id, createdAt: raw.createdAt, gallerySha256: '0'.repeat(64) });
    const generation = generationFields(raw);
    generation.recipeState = raw.recipeUnavailable === true ? 'unavailable' : object(raw.snapshot) ? 'inline'
        : typeof raw.snapshotRef === 'string' && raw.snapshotRef ? 'reference-only' : 'not-recorded';
    return { id: raw.id, createdAt: raw.createdAt, generation };
}
export function chatGalleryDetailsResponse(value) {
    if (!exact(value, ['ok', 'version', 'expectedAccount', 'target', 'gallerySha256', 'record', 'proof']) || value.ok !== true || value.proof !== 'read-only-details'
        || !exact(value.record, ['id', 'createdAt', 'generation']) || !exact(value.record.generation, [...Object.keys(textFields), ...scalarFields, 'recipeState'])
        || !recipeStates.includes(value.record.generation.recipeState)) fail();
    const request = chatGalleryRecordRequest({ version: value.version, expectedAccount: value.expectedAccount, target: value.target,
        selection: { recordId: value.record.id, createdAt: value.record.createdAt, gallerySha256: value.gallerySha256 } });
    const generation = { ...generationFields(value.record.generation), recipeState: value.record.generation.recipeState };
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > CHAT_GALLERY_DETAILS_RESPONSE_BYTES) fail();
    return { ...value, target: request.target, record: { id: value.record.id, createdAt: value.record.createdAt, generation } };
}
