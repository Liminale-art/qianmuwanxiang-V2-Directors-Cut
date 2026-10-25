import {createYimuStore} from './server-store.mjs';
import {VERSION, SCHEMA} from './contract.mjs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const info = {id: 'yimu', name: '忆幕', description: '按 ST 账户与聊天保存忆幕文本、修订与来源关联'};

export function registerYimuRoutes(router, {store = createYimuStore({hostCwd: process.cwd()})} = {}) {
    const sendError = (response, caught) => {
        if (response.headersSent) {response.destroy(); return;}
        const known = typeof caught?.code === 'string' && caught.code.startsWith('yimu_');
        const contractFailure = Number.isInteger(caught?.statusCode) && caught.statusCode === caught.status;
        const status = Number.isInteger(caught?.status) && caught.status >= 400 && caught.status <= 599 ? caught.status : 500;
        return response.status(status).json({error: known ? caught.code : contractFailure ? 'yimu_validation' : 'yimu_storage',
            message: known || contractFailure ? caught.message : '忆幕操作未完成，请保留当前修改后重试'});
    };
    const route = handler => async (request, response) => {
        try {
            if (!request.user?.profile?.handle || !request.user?.directories) {
                return response.status(403).json({error: 'yimu_account', message: '未取得当前 ST 账户'});
            }
            return response.json(await handler(request));
        } catch (caught) {
            return sendError(response, caught);
        }
    };
    router.get('/health', route(async () => ({version: VERSION, schema: SCHEMA})));
    router.post('/read', route(request => store.read(request, request.body?.binding)));
    router.post('/recall-source', route(request => store.recallSource(request, request.body?.binding, request.body?.request)));
    router.post('/change', route(request => store.change(request, request.body?.binding, request.body?.operation)));
    router.post('/defaults', route(request => store.defaults(request, request.body?.operation)));
    router.post('/rename', route(request => store.rename(request, request.body?.binding, request.body?.newBinding)));
    router.post('/story/plan', route(request => store.planStory(request, request.body?.binding, request.body?.request)));
    router.post('/story/create', route(request => store.createStory(request, request.body?.binding, request.body?.request)));
    router.post('/story/result', route(request => store.storyResult(request, request.body?.binding, request.body?.request)));
    router.post('/backup/plan', route(request => store.backupPlan(request, request.body?.binding)));
    router.post('/backup/list', route(request => store.backupList(request)));
    router.post('/backup/read', route(request => store.backupRead(request, request.body?.archiveId)));
    router.post('/backup/upload-result', route(request => store.backupUploadResult(request, request.body?.id)));
    router.post('/backup/restore', route(request => store.backupRestore(request, request.body?.archiveId, request.body?.request)));
    router.post('/backup/result', route(request => store.backupResult(request, request.body?.archiveId, request.body?.request)));
    router.post('/backup/upload', route(request => {
        if (String(request.headers?.['content-type'] || '').split(';')[0].trim() !== 'application/octet-stream') {
            throw Object.assign(new Error('请上传忆幕自身的备份文件'), {code: 'yimu_backup_format', status: 415});
        }
        return store.backupUpload(request, request, request.headers?.['x-yimu-operation-id']);
    }));
    router.post('/backup/export', async (request, response) => {
        try {
            if (!request.user?.profile?.handle || !request.user?.directories) return response.status(403).json({error: 'yimu_account', message: '未取得当前 ST 账户'});
            const result = await store.backupExport(request, request.body?.binding, request.body?.request);
            response.setHeader('Content-Type', 'application/gzip');
            response.setHeader('Content-Disposition', `attachment; filename="yimu-backup.yimu.gz"; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
            response.setHeader('Cache-Control', 'no-store');
            await pipeline(Readable.from(result.stream), response);
        } catch (caught) {return sendError(response, caught);}
    });
}

export async function init(router) {
    registerYimuRoutes(router);
}
