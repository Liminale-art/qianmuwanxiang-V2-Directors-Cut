import { VERSION } from './contract.mjs';

export function createApi({ fetcher = globalThis.fetch.bind(globalThis), headers = () => globalThis.SillyTavern?.getContext?.().getRequestHeaders?.() || {}, timeout = 10000 } = {}) {
    async function request(path, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetcher(`/api/plugins/yimu/${path}`, { method: body ? 'POST' : 'GET', headers: { ...headers(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store' });
            let result; try { result = await response.json(); } catch { throw new Error('忆幕服务返回了无法读取的结果'); }
            if (!response.ok) throw Object.assign(new Error(result?.message || result?.error?.message || result?.error || `忆幕请求失败（${response.status}）`), { status: response.status });
            return result;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('忆幕请求超时，保存结果尚未确认');
            throw error;
        } finally { clearTimeout(timer); }
    }
    return {
        async health() {
            const value = await request('health');
            if (value.version !== VERSION || value.schema !== 1) throw new Error(`请安装配套忆幕服务端 ${VERSION} 后重启 ST`);
            return value;
        },
        read: binding => request('read', { binding }),
        change: (binding, operation) => request('change', { binding, operation }),
        defaults: operation => request('defaults', { operation }),
        rename: (binding, newBinding) => request('rename', { binding, newBinding }),
    };
}
