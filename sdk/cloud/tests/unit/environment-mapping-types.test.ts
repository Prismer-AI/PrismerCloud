import ts from 'typescript';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('typechecks configured sizing and the complete mapping projections', () => {
  const file = resolve('src/__eaas_mapping_typecheck__.ts');
  const source = `
    import type { EnvironmentCreateSpec, EnvironmentStatus, EaasContextProjection, ProjectPoolStatus, ProjectPoolsPage } from './environment-contract';
    declare const page: ProjectPoolsPage;
    page.activation.desiredRevision = null;
    const create: EnvironmentCreateSpec = { profile: '4c8g' };
    declare const context: EaasContextProjection;
    context.defaults.profile = '4c8g';
    context.capabilities.profiles.push('4c8g');
    context.capabilities.pools.filter(p => p.available && !p.reason).map(p => [
      p.mappingRevision, p.templateVersion, p.profileRevision,
      p.networkPolicyRevision, p.storagePolicyRevision, p.resources?.cpuLimit,
    ]);
    declare const environment: EnvironmentStatus;
    [environment.mappingRevision, environment.profileRevision, environment.networkPolicyRevision, environment.storagePolicyRevision];
    declare const pool: ProjectPoolStatus;
    [pool.available, pool.mappingRevision, pool.templateVersion, pool.profileRevision,
      pool.networkPolicyRevision, pool.storagePolicyRevision, pool.resources?.memoryLimit];
    pool.reason = 'mapping_not_activated';
    pool.reason = 'template_binding_required';
    pool.reason = 'pricing_unavailable';
  `;
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === file ? ts.createSourceFile(path, source, languageVersion, true) :
      getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});
