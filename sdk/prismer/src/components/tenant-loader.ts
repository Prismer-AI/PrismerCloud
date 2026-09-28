import { DefaultResourceLoader, SettingsManager, type ExtensionFactory, type RegisteredTool } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureComponent, type ComponentStageManifest, type ComponentStageReceipt } from './tenant-package.js';

export type ActiveTenantComponent = ComponentStageManifest & {
  enabled: boolean;
  relativePath: string;
  loader: ComponentStageReceipt['loader'];
};
export type TenantComponentContext = Pick<ComponentStageManifest, 'environmentId' | 'sandboxId' | 'bindingHash' | 'environmentEpoch'>;
export async function loadTenantComponent(
  declaration: ActiveTenantComponent,
  context: TenantComponentContext,
  root: string,
  authorize: (tool?: string) => Promise<boolean>,
): Promise<RegisteredTool[]> {
  const denied = (): never => { throw new Error('tenant component unavailable'); };
  const active = structuredClone(declaration);
  if (active.enabled !== true || typeof authorize !== 'function') denied();
  for (const key of ['environmentId', 'sandboxId', 'bindingHash', 'environmentEpoch'] as const)
    if (active[key] !== context[key]) denied();
  if (await authorize() !== true) denied();
  const captured = await captureComponent(active, root);
  if (captured.unsupportedResources.length) denied();
  if (active.relativePath !== captured.receipt.relativePath || !isDeepStrictEqual(active.loader, captured.receipt.loader)) denied();
  if (await authorize() !== true) denied();
  // Import captured bytes, not a path that tenant code can replace between verification and import.
  const url = `data:text/javascript;base64,${captured.entry.toString('base64')}#${randomUUID()}`;
  const extensionModule = await import(/* @vite-ignore */ url) as { default?: ExtensionFactory };
  if (typeof extensionModule.default !== 'function') denied();
  const privateDirectory = await mkdtemp(join(tmpdir(), 'prismer-tenant-loader-'));
  try {
    const loader = new DefaultResourceLoader({
      cwd: privateDirectory, agentDir: privateDirectory, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: `${active.componentId}:${active.generation}`, factory: extensionModule.default! }],
    });
    await loader.reload();
    const result = loader.getExtensions();
    if (result.errors.length || result.extensions.length !== 1) denied();
    const extension = result.extensions[0]!;
    if (extension.handlers.size || extension.commands.size || extension.flags.size || extension.shortcuts.size ||
      !isDeepStrictEqual([...extension.tools.keys()].sort(), [...active.tools].sort())) denied();
    return [...extension.tools.values()].map(tool => ({
      ...tool,
      definition: {
        ...tool.definition,
        async execute(...args: Parameters<typeof tool.definition.execute>) {
          if (args[2]?.aborted || await authorize(tool.definition.name) !== true) denied();
          await captureComponent(active, root);
          if (args[2]?.aborted || await authorize(tool.definition.name) !== true) denied();
          const result = await tool.definition.execute(...args);
          return {
            ...result,
            details: {
              ...(result.details && typeof result.details === 'object' ? result.details : {}),
              tenantComponent: {
                componentId: active.componentId, generation: active.generation,
                treeSha256: active.treeSha256, archiveSha256: active.archiveSha256,
              },
            },
          };
        },
      },
    }));
  } finally { await rm(privateDirectory, { recursive: true, force: true }); }
}
