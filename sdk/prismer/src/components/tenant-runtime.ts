import type { ActiveTenantComponent, TenantComponentContext } from './tenant-loader.js';

/** Untrusted turn selection, never an executable path or load authority. */
export interface TenantComponentReference {
  componentId: string;
  generation: string;
  treeSha256: string;
}

/** Trusted host contract. Resolve from authenticated server state, never disk receipts/envelope config.
 * authorize must check current owner grant, enabled generation, expiry/deletion, epoch,
 * sandbox and binding on EVERY call. Offline/error/unknown must deny; no cached allow.
 * Cloud sender/authorization transport is a separate integration, not implemented here.
 */
export interface TenantComponentHost {
  root: string;
  context: TenantComponentContext;
  components: ActiveTenantComponent[];
  authorize(query: {
    turnId: string;
    context: TenantComponentContext;
    component: ActiveTenantComponent;
    phase: 'load' | 'invoke';
    tool?: string;
  }): Promise<boolean>;
}

export interface TenantComponentSelection {
  turnId: string;
  components: TenantComponentReference[];
}

export interface TenantComponentBinding extends TenantComponentSelection {
  host: TenantComponentHost;
}

export function parseTenantComponentReferences(raw: unknown): TenantComponentReference[] {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error('tenant component selection invalid');
  const seen = new Set<string>();
  return raw.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['componentId', 'generation', 'treeSha256'].includes(key)) ||
      ![value.componentId, value.generation].every(
        (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id),
      ) ||
      typeof value.treeSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.treeSha256) ||
      seen.has(value.componentId)
    )
      throw new Error('tenant component selection invalid');
    seen.add(value.componentId);
    return { componentId: value.componentId, generation: value.generation, treeSha256: value.treeSha256 };
  });
}

export async function loadTenantRuntimeTools(
  binding: TenantComponentBinding | undefined,
  tools: readonly { name: string; kind: string; enabled?: boolean }[] | undefined,
) {
  const unavailable = (): never => {
    throw new Error('tenant component unavailable');
  };
  const declared = tools?.filter((tool) => tool.kind === 'tenant-component') ?? [];
  if (!binding) {
    if (declared.length) unavailable();
    return [];
  }
  const references = parseTenantComponentReferences(binding.components);
  const host = binding.host;
  if (!host || typeof host.authorize !== 'function' || !binding.turnId) unavailable();
  const context = structuredClone(host.context);
  const components = structuredClone(host.components);
  const root = host.root;
  const authorize = host.authorize.bind(host);
  const turnId = binding.turnId;
  if (components.length !== references.length) unavailable();
  const names = new Set<string>();
  // Validate the entire selection before importing any tenant code.
  for (const ref of references) {
    const matches = components.filter((component) => component.componentId === ref.componentId);
    const component = matches[0];
    if (
      matches.length !== 1 ||
      !component ||
      component.enabled !== true ||
      component.generation !== ref.generation ||
      component.treeSha256 !== ref.treeSha256
    )
      unavailable();
    for (const key of ['environmentId', 'sandboxId', 'bindingHash', 'environmentEpoch'] as const)
      if (component![key] !== context[key]) unavailable();
    for (const name of component!.tools) {
      if (
        names.has(name) ||
        tools?.filter((tool) => tool.name === name).length !== 1 ||
        !declared.some((tool) => tool.name === name && tool.enabled === true)
      )
        unavailable();
      names.add(name);
    }
  }
  if (names.size !== declared.length) unavailable();
  const { loadTenantComponent } = await import('./tenant-loader.js');
  const loaded = [];
  for (const component of components) {
    loaded.push(
      ...(await loadTenantComponent(component, context, root, async (tool) => {
        try {
          return (
            (await authorize({
              turnId,
              context: structuredClone(context),
              component: structuredClone(component),
              phase: tool === undefined ? 'load' : 'invoke',
              ...(tool === undefined ? {} : { tool }),
            })) === true
          );
        } catch {
          return false;
        }
      })),
    );
  }
  return loaded;
}
