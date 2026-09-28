import {importCurrentRuntime} from './current-runtime.mjs';

// The execution record is private to one ESM instance. Fixtures must use the
// same release-qualified URL as the real compiler/recovery consumers, not an
// old version (or an unqualified copy) with an independent WeakMap.
export const {
    attachEnsembleCompilerResult, sealEnsembleCompilerResult,
    resolveEnsembleCompiledRoutes, readEnsembleCompilerProof, ensembleShotContent,
} = await importCurrentRuntime('qianmu-ensemble-handoff.js');
