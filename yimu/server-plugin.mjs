import {createYimuStore} from './server-store.mjs';
import {VERSION, SCHEMA} from './contract.mjs';

export const info = {id: 'yimu', name: '忆幕', description: '按 ST 账户与聊天保存忆幕文本、修订与来源关联'};

export function registerYimuRoutes(router, {store = createYimuStore({hostCwd: process.cwd()})} = {}) {
    const route = handler => async (request, response) => {
        try {
            if (!request.user?.profile?.handle || !request.user?.directories) {
                return response.status(403).json({error: 'yimu_account', message: '未取得当前 ST 账户'});
            }
            return response.json(await handler(request));
        } catch (caught) {
            const known = typeof caught?.code === 'string' && caught.code.startsWith('yimu_');
            const contractFailure = Number.isInteger(caught?.statusCode) && caught.statusCode === caught.status;
            const status = Number.isInteger(caught?.status) && caught.status >= 400 && caught.status <= 599 ? caught.status : 500;
            return response.status(status).json({
                error: known ? caught.code : contractFailure ? 'yimu_validation' : 'yimu_storage',
                message: known || contractFailure ? caught.message : '忆幕操作未完成，请保留当前修改后重试',
            });
        }
    };
    router.get('/health', route(async () => ({version: VERSION, schema: SCHEMA})));
    router.post('/read', route(request => store.read(request, request.body?.binding)));
    router.post('/change', route(request => store.change(request, request.body?.binding, request.body?.operation)));
    router.post('/defaults', route(request => store.defaults(request, request.body?.operation)));
    router.post('/rename', route(request => store.rename(request, request.body?.binding, request.body?.newBinding)));
}

export async function init(router) {
    registerYimuRoutes(router);
}
