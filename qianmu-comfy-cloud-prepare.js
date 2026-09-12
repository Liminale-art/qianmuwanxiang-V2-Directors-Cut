// Pure, text-input preparation. No credential injection, uploads or submission.
import { createHash } from 'node:crypto';
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';
import { auditComfyWorkflow, requireComfyExecution } from './qianmu-comfy-audit.js';
import { normalizeComfyRouteBinding } from './qianmu-comfy-route-contract.js';
import { describeImageServiceRequest } from './qianmu-image-service-queue.js';
import { parseBoundedJson } from './qianmu-json-input.js';
import { planComfyCloudOperation } from './qianmu-comfy-cloud-protocol.js';
import { COMFY_CLOUD_INTENT_SCHEMA, normalizeComfyCloudIntent } from './qianmu-comfy-cloud-receipt.js';

const LIMIT = 2 * 1024 * 1024;
const hash = graph => createHash('sha256').update(JSON.stringify(graph)).digest('hex');
const fail = () => { throw Object.assign(new Error('云工作流输入无效，请核对槽位、方案版本与出图数量'), { code: 'comfy_cloud_prepare_invalid', submissionState: 'not_submitted', retryable: false }); };
const fields = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) fail();
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function prepareComfyCloudSubmission(raw) {
  try {
    // Shared descriptor walk rejects getters/cycles before JSON serialization.
    // Wrapping prevents the digest helper's top-level credential exclusions.
    if (describeImageServiceRequest({ input: raw }).requestBytes > LIMIT) fail();
    const source = parseBoundedJson(JSON.stringify(raw), { maxBytes: LIMIT, maxDepth: 40, maxNodes: 50000, label: '云工作流' });
    fields(source, ['connection', 'workflow', 'prompt', 'negativePrompt', 'model', 'parameters', 'execution', 'binding', 'runninghub']);
    fields(source.connection, ['version', 'provider', 'protocol', 'origin']);
    fields(source.parameters ?? {}, ['width', 'height', 'steps', 'count', 'seed', 'scale', 'cfg', 'sampler', 'scheduler']);
    fields(source.execution, ['version', 'automatic', 'maxImages', 'outputNodeIds', 'allowUnverified']);
    if (typeof source.prompt !== 'string' || !source.prompt.trim() || source.prompt.length > 24000
      || source.negativePrompt !== undefined && (typeof source.negativePrompt !== 'string' || source.negativePrompt.length > 24000)
      || source.model !== undefined && (typeof source.model !== 'string' || source.model.length > 240)) fail();
    const plan = planComfyCloudOperation(source.connection, 'submit');
    const workflow = typeof source.workflow === 'string'
      ? parseBoundedJson(source.workflow, { maxBytes: LIMIT, maxDepth: 40, maxNodes: 50000, label: '工作流' }) : source.workflow;
    const template = prepareComfyWorkflow(workflow, { ...source, referenceCount: 0 });
    const graph = template.bind([]), execution = requireComfyExecution(auditComfyWorkflow(graph, source.execution), source.execution);
    const identity = { templateHash: hash(workflow), executionHash: hash(graph), ...(source.binding ? { binding: normalizeComfyRouteBinding(source.binding) } : {}) };
    // Keep the shared output receipt small; admission flags are hashed below,
    // not misrepresented as provider output evidence.
    const stillOutput = { version: 1, model: source.model || 'workflow', previewNodeIds: Object.entries(graph).filter(([, node]) => node.class_type === 'PreviewImage').map(([id]) => id),
      execution: { version: 1, automatic: execution.automatic, maxImages: execution.maxImages,
        outputNodeIds: execution.outputNodeIds, ...(execution.expectedImages != null ? { expectedImages: execution.expectedImages } : {}) } };
    const body = plan.provider === 'comfy-cloud' ? { workflow: graph } : { workflow: JSON.stringify(graph) };
    if (source.runninghub !== undefined) {
      if (plan.provider !== 'runninghub') fail();
      fields(source.runninghub, ['workflowId']);
      if (typeof source.runninghub.workflowId !== 'string' || !/^[0-9]{1,64}$/.test(source.runninghub.workflowId)) fail();
      body.workflowId = source.runninghub.workflowId;
    }
    const bodyBytes = Buffer.byteLength(JSON.stringify(body)); if (bodyBytes > LIMIT) fail();
    const { requestDigest } = describeImageServiceRequest({ connection: source.connection, body, workflow: identity, execution });
    const intent = normalizeComfyCloudIntent({ schema: COMFY_CLOUD_INTENT_SCHEMA, connection: source.connection, requestDigest, workflow: identity, stillOutput });
    return freeze({ body, bodyBytes, intent });
  } catch (_) { fail(); }
}
