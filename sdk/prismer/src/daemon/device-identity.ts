// desktop204 D204-3 — device identity the daemon declares to the cloud.
//
// Until now `agent.host.declare` carried only `daemonId / daemonVersion /
// platform`, so the cloud had to GUESS the device identity it stores on
// `im_agent_bindings`:
//   kind  ← `daemonId.startsWith('daemon-') ? 'local' : 'k8s'`
//   label ← the daemonId suffix
// (see src/im/ws/handler.ts). Both guesses are wrong for any daemon whose id
// doesn't follow that prefix convention, and neither can ever surface a
// user-chosen device name.
//
// The daemon is the only process that actually KNOWS these two facts, so it
// declares them. The cloud keeps its guess as a fallback for legacy daemons
// that don't send the fields (fully additive, no migration — the columns
// `boundDaemonKind` / `boundDaemonLabel` already exist).
//
// Precedence (both resolvers):
//   env override  >  config.toml  >  auto-detected  >  last-resort daemonId
// The env tier is what k8s uses (entrypoint injects PRISMER_DEVICE_KIND); the
// config tier is what the desktop app writes when the user renames the device.

import { hostname } from 'node:os';

export type DaemonKind = 'k8s' | 'local' | 'edge';

const DAEMON_KINDS: readonly string[] = ['k8s', 'local', 'edge'];

/**
 * Where the daemon runs. K8s pods always get `KUBERNETES_SERVICE_HOST`
 * injected by the kubelet; everything else is `local`. `edge` has no reliable
 * automatic signal — it is opt-in via `PRISMER_DEVICE_KIND` only.
 *
 * NOTE: `process.platform` alone cannot answer this (a linux daemon may be a
 * pod OR a user's linux box), which is why the env probe leads.
 */
export function resolveDaemonKind(env: NodeJS.ProcessEnv = process.env): DaemonKind {
  const explicit = env.PRISMER_DEVICE_KIND?.trim();
  if (explicit && DAEMON_KINDS.includes(explicit)) return explicit as DaemonKind;
  if (env.KUBERNETES_SERVICE_HOST) return 'k8s';
  return 'local';
}

/**
 * Human-readable device name shown in the cloud Devices panel.
 *
 * `configLabel` is `config.toml`'s `daemon_label` — the user-customisable
 * value (desktop Preferences ▸ 设备名称). Falls back to the OS hostname, and
 * finally to the daemonId so the field is NEVER empty (an empty label would
 * make the cloud fall back to its guess, defeating the point).
 */
export function resolveDaemonLabel(
  input: { configLabel?: string | null; daemonId: string; env?: NodeJS.ProcessEnv },
): string {
  const env = input.env ?? process.env;
  const fromEnv = env.PRISMER_DAEMON_LABEL?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = input.configLabel?.trim();
  if (fromConfig) return fromConfig;
  const host = safeHostname();
  if (host) return host;
  return input.daemonId;
}

function safeHostname(): string {
  try {
    return hostname().trim();
  } catch {
    return '';
  }
}
