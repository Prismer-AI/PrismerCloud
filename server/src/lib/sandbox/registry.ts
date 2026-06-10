/**
 * Sandbox provider registry.
 *
 * Two shapes coexist:
 *
 * 1. Legacy class-based registry (`SandboxProviderRegistry` /
 *    `sandboxProviderRegistry`) — used by older callers that want a
 *    type-narrow `SandboxProvider`. Kept as-is to avoid breaking anyone.
 *
 * 2. v200 top-level functions (`registerPersistent` / `resolvePersistent`
 *    + ephemeral siblings) — the API spelled out in
 *    `docs/release200/08-execution-environment-design.md` §4.5 and used
 *    by sandbox routes after S3. These functions delegate to the same
 *    singleton instances, so both shapes see the same providers.
 *
 * Bootstrap: the module top-level IIFE auto-registers `k8s`,
 * `docker-host`, and (when `E2B_API_KEY` is set) `e2b` on first import.
 * `let registered` guards against accidental double-register if the
 * module is imported across multiple compilation units (e.g. ESM/CJS
 * mixed in Next.js dev with HMR).
 */

import { DockerHostSandboxProvider } from './docker-host-provider';
import { E2bSandboxProvider } from './e2b-provider';
import { K8sSandboxProvider } from './k8s-provider';
import type { EphemeralExecutor, PersistentRuntime, SandboxProvider, SandboxProviderKind } from './types';

export class SandboxProviderRegistry {
  private readonly providers = new Map<SandboxProviderKind, SandboxProvider>();

  register(provider: SandboxProvider): this {
    this.providers.set(provider.kind, provider);
    return this;
  }

  get(kind: SandboxProviderKind): SandboxProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`Sandbox provider is not registered: ${kind}`);
    }
    return provider;
  }

  maybeGet(kind: SandboxProviderKind): SandboxProvider | null {
    return this.providers.get(kind) ?? null;
  }

  list(): SandboxProvider[] {
    return Array.from(this.providers.values());
  }
}

export function createDefaultSandboxProviderRegistry(): SandboxProviderRegistry {
  // Class-registry retains placeholder e2b entry (uses dev fallback API key
  // when E2B_API_KEY missing). Real e2b activation happens in the v200
  // functional registry below, gated on a non-empty E2B_API_KEY.
  const reg = new SandboxProviderRegistry()
    .register(new K8sSandboxProvider())
    .register(new DockerHostSandboxProvider());
  const e2bKey = process.env.E2B_API_KEY;
  if (e2bKey) {
    reg.register(new E2bSandboxProvider(e2bKey));
  }
  return reg;
}

export const sandboxProviderRegistry = createDefaultSandboxProviderRegistry();

// ============================================================
// v200 top-level functional registry API (08 §4.5)
// ============================================================

const persistentRegistry = new Map<string, PersistentRuntime>();
const ephemeralRegistry = new Map<string, EphemeralExecutor>();

export function registerPersistent(id: string, provider: PersistentRuntime): void {
  persistentRegistry.set(id, provider);
}

export function registerEphemeral(id: string, provider: EphemeralExecutor): void {
  ephemeralRegistry.set(id, provider);
}

export function resolvePersistent(id: string): PersistentRuntime {
  const provider = persistentRegistry.get(id);
  if (!provider) {
    const known = Array.from(persistentRegistry.keys()).join(', ') || '(none)';
    throw new Error(`Persistent runtime '${id}' is not registered (known: ${known})`);
  }
  return provider;
}

export function resolveEphemeral(id: string): EphemeralExecutor {
  const provider = ephemeralRegistry.get(id);
  if (!provider) {
    const known = Array.from(ephemeralRegistry.keys()).join(', ') || '(none)';
    throw new Error(`Ephemeral executor '${id}' is not registered (known: ${known})`);
  }
  return provider;
}

export function maybeResolvePersistent(id: string): PersistentRuntime | null {
  return persistentRegistry.get(id) ?? null;
}

export function maybeResolveEphemeral(id: string): EphemeralExecutor | null {
  return ephemeralRegistry.get(id) ?? null;
}

export function listRegisteredPersistent(): string[] {
  return Array.from(persistentRegistry.keys());
}

export function listRegisteredEphemeral(): string[] {
  return Array.from(ephemeralRegistry.keys());
}

// ============================================================
// Self-registering bootstrap (IIFE — runs at module-import time)
// ============================================================

let registered = false;

function bootstrapRegistry(): void {
  if (registered) return;
  registered = true;

  // k8s is the v200 main path — always register so `resolvePersistent('k8s')`
  // succeeds even when the K8s client is unavailable at runtime (the call
  // will surface an out-of-cluster error from the adapter, which then maps
  // to a ProviderError; the route layer is unaware).
  registerPersistent('k8s', new K8sSandboxProvider());

  // docker-host: persistent-shaped but currently a stub (08 §4.6 ⚠️ 可选).
  // We keep it ephemeral here to match the existing class shape; routes can
  // resolveEphemeral('docker-host') in S4+ once the adapter is real.
  registerEphemeral('docker-host', new DockerHostSandboxProvider());

  // e2b is registered only when an API key is present (08 §4.5 example).
  // The provider takes the key in its constructor so it can fail fast at
  // bootstrap if the env var is malformed (e.g. empty string from K8s
  // ConfigMap accidents) rather than at first run().
  const e2bKey = process.env.E2B_API_KEY;
  if (e2bKey) {
    registerEphemeral('e2b', new E2bSandboxProvider(e2bKey));
  }
}

bootstrapRegistry();
