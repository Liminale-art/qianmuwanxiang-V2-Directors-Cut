import { createSourceIdentityClient } from './qianmu-source-identity-client.js';
import { sourceIdentityForNamespace, sourceIdentityLabelsMatch } from './qianmu-source-identity-contract.js';

// Called only from the explicitly confirmed resource export, never startup or ordinary configuration export.
export async function prepareStoryboardBundleSource({ namespace, headers, guard, confirm, fetchImpl } = {}) {
  if (typeof guard !== 'function' || typeof confirm !== 'function') throw Error('缺少备份来源核对与确认');
  const client = createSourceIdentityClient({ namespace, headers, guard, fetchImpl }); let source;
  try { source = await client.inspect(); }
  catch (_) {
    await guard();
    if (await confirm('来源识别暂不可用', '增强服务未支持来源识别或当前连接不可用。是否继续导出旧格式联包？旧包没有 ST 实例与账户来源标识，只能人工核对原环境，不能视为完整迁移。') !== true) throw Error('已取消本次导出，原资料未修改');
    await guard(); return Object.freeze({ source: null, verify: guard });
  }
  if (source.state !== 'ready') {
    if (await confirm('初始化备份来源标识', '将在当前 ST 数据目录与账户目录各新增一份小型随机标识（已存在的保留），用于比较迁移来源。不含 Key、不修改聊天，不会自动重绑；完整复制服务器会同时复制这些标识。是否继续？') !== true) throw Error('已取消来源初始化与本次导出');
    await guard(); source = await client.initialize({ confirmed: true });
  }
  const frozen = Object.freeze(await sourceIdentityForNamespace(source, namespace)); await guard();
  return Object.freeze({ source: frozen, async verify() {
    await guard(); const current = await client.inspect();
    if (!sourceIdentityLabelsMatch(frozen, current)) throw Error('打包期间 ST 来源标识已变化，未输出资源包');
    await guard();
  } });
}
