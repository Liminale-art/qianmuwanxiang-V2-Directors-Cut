import {readFile} from 'node:fs/promises';

const consumer = new URL('../../qianmu-storyboard-compiler-result.js', import.meta.url);
const source = await readFile(consumer, 'utf8');
const specifier = /from ['"]([^'"]*qianmu-ensemble-handoff\.js(?:\?[^'"]*)?)['"]/.exec(source)?.[1];
if (!specifier) throw Error('Missing production ensemble handoff import');

// The execution record is private to one ESM instance. Fixtures must use the
// same release-qualified URL as the real compiler/recovery consumers, not an
// old version (or an unqualified copy) with an independent WeakMap.
export const {
    attachEnsembleCompilerResult, sealEnsembleCompilerResult,
    resolveEnsembleCompiledRoutes, readEnsembleCompilerProof, ensembleShotContent,
} = await import(new URL(specifier, consumer));
