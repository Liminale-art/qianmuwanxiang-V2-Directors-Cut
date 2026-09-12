// Versioned cloud acceptance/output evidence, not a credential or permission grant.
// Existing node/count validation is shared; the native receipt shape itself is unchanged.
import { bindComfyCloudTask, planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
import { normalizeComfyReceipt } from './qianmu-comfy-receipt.js';
import { normalizeComfyRouteBinding } from './qianmu-comfy-route-contract.js';

export const COMFY_CLOUD_RECEIPT_SCHEMA = 'qianmu.comfy-cloud-receipt.v1';
export const COMFY_CLOUD_INTENT_SCHEMA = 'qianmu.comfy-cloud-intent.v1';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw Object.assign(new Error('云端原任务收据缺失或不一致，请核查原任务'), { code: 'comfy_cloud_receipt_invalid', retryable: false }); };
const fields = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!names.includes(key) || descriptor.get || descriptor.set) fail();
  }
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function evidence(value) {
  if (!hash(value.requestDigest)) fail();
  fields(value.workflow, ['templateHash', 'executionHash', 'binding']);
  const { templateHash, executionHash } = value.workflow;
  if (!hash(templateHash) || !hash(executionHash)) fail();
  let binding;
  if (value.workflow.binding !== undefined) {
    fields(value.workflow.binding, ['schemaVersion', 'namespace', 'id', 'revision', 'version', 'name', 'workflowHash', 'recipeHash']);
    binding = normalizeComfyRouteBinding(value.workflow.binding);
    if (binding.workflowHash !== templateHash) fail();
  }
  fields(value.stillOutput, ['version', 'model', 'previewNodeIds', 'execution']);
  fields(value.stillOutput.execution, ['version', 'automatic', 'maxImages', 'outputNodeIds', 'expectedImages']);
  return { requestDigest: value.requestDigest, workflow: { templateHash, executionHash, ...(binding ? { binding } : {}) },
    stillOutput: normalizeComfyReceipt(value.stillOutput) };
}

// Construct from the server-validated request before credentials are injected.
// This is not proof of submission or permission to generate.
export function normalizeComfyCloudIntent(value) {
  try {
    fields(value, ['schema', 'connection', 'requestDigest', 'workflow', 'stillOutput']);
    if (value.schema !== COMFY_CLOUD_INTENT_SCHEMA) fail();
    fields(value.connection, ['version', 'provider', 'protocol', 'origin']);
    const { version, provider, protocol, origin } = planComfyCloudOperation(value.connection, 'submit');
    return freeze({ schema: COMFY_CLOUD_INTENT_SCHEMA, connection: { version, provider, protocol, origin }, ...evidence(value) });
  } catch (_) {
    throw Object.assign(new Error('云任务提交前配置缺失或不一致，请核查原请求'), { code: 'comfy_cloud_intent_invalid', retryable: false });
  }
}

export function normalizeComfyCloudReceipt(value) {
  try {
    fields(value, ['schema', 'task', 'requestDigest', 'workflow', 'stillOutput']);
    if (value.schema !== COMFY_CLOUD_RECEIPT_SCHEMA || !hash(value.requestDigest)) fail();
    fields(value.task, ['version', 'provider', 'protocol', 'origin', 'taskId', 'links']);
    if (value.task.links !== undefined) fields(value.task.links, ['self', 'cancel']);
    const task = bindComfyCloudTask(value.task, value.task.taskId, value.task.links);
    if (task.provider === 'runninghub' && value.task.links !== undefined) fail();
    return freeze({ schema: COMFY_CLOUD_RECEIPT_SCHEMA, task, ...evidence(value) });
  } catch (_) { fail(); } // Never reuse the native validator's not_submitted state for accepted cloud evidence.
}

export function assertComfyCloudReceiptForIntent(value, rawIntent, upstreamId) {
  try {
    const intent = normalizeComfyCloudIntent(rawIntent);
    const receipt = assertComfyCloudReceiptMatches(value, { ...intent, ...intent.workflow, upstreamId });
    if (JSON.stringify(receipt.workflow) !== JSON.stringify(intent.workflow)
      || JSON.stringify(receipt.stillOutput) !== JSON.stringify(intent.stillOutput)) fail();
    return receipt;
  } catch (_) { fail(); }
}

// Expected fields come from the coordinator's frozen reservation, not an HTTP body.
// ST account/fence ownership is still enforced by the queue transaction around this check.
export function assertComfyCloudReceiptMatches(value, expected) {
  const receipt = normalizeComfyCloudReceipt(value);
  try {
    const connection = planComfyCloudOperation(expected.connection, 'submit');
    if (receipt.requestDigest !== expected.requestDigest || receipt.task.taskId !== expected.upstreamId
      || receipt.task.provider !== connection.provider || receipt.task.protocol !== connection.protocol || receipt.task.origin !== connection.origin
      || receipt.workflow.templateHash !== expected.templateHash || receipt.workflow.executionHash !== expected.executionHash) fail();
    return receipt;
  } catch (_) { fail(); }
}
