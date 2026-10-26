import { VERSION, SCHEMA } from './contract.mjs';

export function createApi({ fetcher = globalThis.fetch.bind(globalThis), headers = () => globalThis.SillyTavern?.getContext?.().getRequestHeaders?.() || {}, timeout = 10000, transferTimeout = 120000 } = {}) {
    async function request(path, body, deadline = timeout) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deadline);
        try {
            const response = await fetcher(`/api/plugins/yimu/${path}`, { method: body ? 'POST' : 'GET', headers: { ...headers(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store' });
            if (response.status === 404 && path === 'health') throw new Error('尚未安装忆幕服务端，请按安装说明完成安装后重新检测');
            let result; try { result = await response.json(); } catch { throw new Error('忆幕服务返回了无法读取的结果'); }
            if (!response.ok) throw Object.assign(new Error(result?.message || result?.error?.message || result?.error || `忆幕请求失败（${response.status}）`), { status: response.status });
            return result;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('忆幕请求超时，保存结果尚未确认');
            if (error instanceof TypeError) throw new Error('无法连接忆幕服务，请检查网络后重新检测');
            throw error;
        } finally { clearTimeout(timer); }
    }
    async function transfer(path, body, { uploadId, download = false } = {}) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), transferTimeout);
        try {
            const response = await fetcher(`/api/plugins/yimu/${path}`, { method: 'POST', cache: 'no-store', signal: controller.signal,
                headers: { ...headers(), 'Content-Type': uploadId ? 'application/octet-stream' : 'application/json', ...(uploadId ? { 'x-yimu-operation-id': uploadId } : {}) },
                body: uploadId ? body : JSON.stringify(body) });
            if (!response.ok) {
                let value; try { value = await response.json(); } catch { /* Keep the HTTP status for confirmed rejections. */ }
                throw Object.assign(new Error(value?.message || value?.error?.message || value?.error || `备份请求失败（${response.status}）`), { status: response.status });
            }
            if (!download) return await response.json();
            const blob = await response.blob();
            return { blob, filename: '忆幕备份.yimu.gz' };
        } catch (error) {
            if (controller.signal.aborted) throw new Error('备份传输超时，结果尚未确认');
            if (error instanceof TypeError) throw new Error('备份连接中断，结果尚未确认');
            throw error;
        } finally { clearTimeout(timer); }
    }
    return {
        async health() {
            const value = await request('health');
            if (value.version !== VERSION || value.schema !== SCHEMA) throw Object.assign(
                new Error(`忆幕服务端当前 ${value.version || '未知版本'}，需要配套 ${VERSION}；请一键更新后重启 ST`),
                { code: 'yimu_version', currentVersion: typeof value.version === 'string' ? value.version : '' });
            return value;
        },
        read: binding => request('read', { binding }),
        recallSource: (binding, query) => request('recall-source', { binding, request: query }),
        planStory: (binding, query) => request('story/plan', { binding, request: query }),
        createStory: (binding, operation) => request('story/create', { binding, request: operation }),
        storyResult: (binding, query) => request('story/result', { binding, request: query }),
        change: (binding, operation) => request('change', { binding, operation }),
        defaults: operation => operation === undefined ? request('defaults') : request('defaults', { operation }),
        rename: (binding, newBinding) => request('rename', { binding, newBinding }),
        backupPlan: binding => request('backup/plan', { binding }, transferTimeout),
        backupExport: (binding, query) => transfer('backup/export', { binding, request: query }, { download: true }),
        backupUpload: (file, id) => transfer('backup/upload', file, { uploadId: id }),
        backupUploadResult: id => request('backup/upload-result', { id }, transferTimeout),
        backupList: () => request('backup/list', {}),
        backupRead: archiveId => request('backup/read', { archiveId }, transferTimeout),
        backupApply: (archiveId, operation) => request('backup/apply', { archiveId, request: operation }, transferTimeout),
        backupRestore: (archiveId, operation) => request('backup/restore', { archiveId, request: operation }, transferTimeout),
        backupResult: (archiveId, query = {}) => request('backup/result', { archiveId, request: query }, transferTimeout),
    };
}
