/**
 * GET /api/sandboxes/_admin/k8s-nodes — node-pool capacity overview.
 *
 * Lists nodes + all pods across namespaces, sums each pod's CPU/memory
 * `requests` against the node it's scheduled on, and exposes
 * `allocatable`/`allocated`/`remaining` so an admin can answer "why did this
 * pod hit FailedScheduling?" without reaching for kubectl.
 *
 * Quantity parsing is a deliberately minimal port of the K8s resource
 * library: just enough to cover the suffixes the cluster actually emits
 * (`m`, plain numeric for CPU; `Ki|Mi|Gi|Ti|K|M|G|T` for memory). Anything
 * unparseable falls back to 0 — the raw string is still returned so the
 * caller can flag drift.
 *
 * Auth: same `isSandboxAdmin(email)` gate as the other _admin routes.
 *
 * Query params:
 *   includePods=true|false   (default false; per-node pod breakdown)
 *
 * Spec: docs/release201/06-debug-pipeline-design.md §3.5.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveAdminEmail } from '@/lib/admin/resolve-admin-email';
import { isSandboxAdmin } from '@/lib/admin-rbac';
import { logger } from '@/lib/logger';
import { getCoreV1Api } from '@/lib/k8s-client';
import {
  checkRateLimit,
  rateLimitResponse,
  withRateLimitHeaders,
} from '@/lib/admin/debug-rate-limit';

interface NodeRaw {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { taints?: Array<{ key?: string; value?: string; effect?: string }> };
  status?: {
    allocatable?: Record<string, string>;
    capacity?: Record<string, string>;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string | Date | null;
    }>;
  };
}

interface PodRaw {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    nodeName?: string;
    containers?: Array<{
      resources?: { requests?: Record<string, string> };
    }>;
    initContainers?: Array<{
      resources?: { requests?: Record<string, string> };
    }>;
  };
  status?: { phase?: string };
}

interface NodeConditionOut {
  type: string | null;
  status: string | null;
  reason: string | null;
  message: string | null;
  lastTransitionTime: string | null;
}

interface NodeTaintOut {
  key: string | null;
  value: string | null;
  effect: string | null;
}

interface NodePodSummary {
  namespace: string | null;
  name: string | null;
  cpuRequest: string;
  memoryRequest: string;
  cpuRequestCores: number;
  memoryRequestBytes: number;
}

interface ResourceTotals {
  cpu: string;
  memory: string;
  pods: string;
  cpuCores: number;
  memoryBytes: number;
  podCount: number;
}

interface NodeOut {
  name: string | null;
  labels: Record<string, string>;
  taints: NodeTaintOut[];
  conditions: NodeConditionOut[];
  allocatable: ResourceTotals;
  allocated: ResourceTotals;
  remaining: ResourceTotals;
  pods?: NodePodSummary[];
}

/**
 * Parse a K8s CPU quantity to fractional cores.
 *   "100m" → 0.1
 *   "1"    → 1
 *   "1.5"  → 1.5
 *   ""     → 0
 */
function parseCpuToCores(raw: string | undefined): number {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  if (s.endsWith('m')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 1000 : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a K8s memory quantity to bytes.
 *   "512Mi" → 512 * 2^20
 *   "2Gi"   → 2 * 2^30
 *   "1G"    → 1 * 10^9
 *   "1500"  → 1500 (raw bytes)
 *
 * Recognized suffixes (kubectl resource model):
 *   Ki, Mi, Gi, Ti, Pi, Ei         (binary)
 *   K,  M,  G,  T,  P,  E          (decimal)
 *   ""                              (raw integer)
 */
const BIN_MULTS: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};
const DEC_MULTS: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};
function parseMemoryToBytes(raw: string | undefined): number {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  // Two-letter binary suffix first.
  const two = s.slice(-2);
  if (BIN_MULTS[two] !== undefined) {
    const n = Number(s.slice(0, -2));
    return Number.isFinite(n) ? n * BIN_MULTS[two] : 0;
  }
  // Single-letter decimal suffix.
  const one = s.slice(-1);
  if (DEC_MULTS[one] !== undefined) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n * DEC_MULTS[one] : 0;
  }
  // Plain numeric — assume bytes.
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isTrue(value: string | null | undefined): boolean {
  if (!value) return false;
  return value === 'true' || value === '1' || value === 'yes';
}

function formatCores(cores: number): string {
  // Match kubectl style: integer cores → plain; fractional → milli.
  if (cores === 0) return '0';
  if (Number.isInteger(cores)) return String(cores);
  return `${Math.round(cores * 1000)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0';
  // Pick the largest binary unit that yields a value >= 1.
  const units: Array<[string, number]> = [
    ['Ei', BIN_MULTS.Ei],
    ['Pi', BIN_MULTS.Pi],
    ['Ti', BIN_MULTS.Ti],
    ['Gi', BIN_MULTS.Gi],
    ['Mi', BIN_MULTS.Mi],
    ['Ki', BIN_MULTS.Ki],
  ];
  for (const [suffix, mult] of units) {
    if (bytes >= mult) {
      const v = bytes / mult;
      const rounded = Math.round(v * 100) / 100;
      return `${rounded}${suffix}`;
    }
  }
  return String(bytes);
}

function isoOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? String(v) : new Date(ms).toISOString();
}

/**
 * Pod's effective request: sum across all `containers[*].resources.requests`
 * (init containers are not summed — K8s uses max(init) instead of sum, but
 * the post-startup scheduling number is the regular container sum, which is
 * what we want for "what's currently consumed").
 */
function podRequests(pod: PodRaw): { cpuCores: number; memoryBytes: number } {
  let cpuCores = 0;
  let memoryBytes = 0;
  for (const c of pod.spec?.containers ?? []) {
    cpuCores += parseCpuToCores(c.resources?.requests?.cpu);
    memoryBytes += parseMemoryToBytes(c.resources?.requests?.memory);
  }
  return { cpuCores, memoryBytes };
}

function isPodConsumingResources(pod: PodRaw): boolean {
  const phase = pod.status?.phase;
  // Pending pods that have already been scheduled (nodeName present) still
  // hold reservations; Succeeded/Failed do not.
  return phase !== 'Succeeded' && phase !== 'Failed';
}

export async function GET(req: NextRequest): Promise<Response> {
  const adminEmail = await resolveAdminEmail(req);
  if (!isSandboxAdmin(adminEmail)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rl = checkRateLimit(adminEmail);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const includePods = isTrue(url.searchParams.get('includePods'));

  logger.info(
    {
      admin: adminEmail ?? null,
      action: 'k8s-nodes',
      filters: { includePods },
    },
    '[admin-debug] called',
  );

  let nodeItems: NodeRaw[] = [];
  let podItems: PodRaw[] = [];
  try {
    const api = await getCoreV1Api();
    const [nodes, pods] = await Promise.all([
      api.listNode() as unknown as Promise<{ items?: NodeRaw[] }>,
      api.listPodForAllNamespaces() as unknown as Promise<{ items?: PodRaw[] }>,
    ]);
    nodeItems = nodes.items ?? [];
    podItems = pods.items ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, '[admin/k8s-nodes] listNode/listPod failed');
    return NextResponse.json(
      { error: 'k8s_unavailable', message, nodes: [] },
      { status: 503 },
    );
  }

  // Group pods by nodeName.
  const podsByNode = new Map<string, PodRaw[]>();
  for (const pod of podItems) {
    const nodeName = pod.spec?.nodeName;
    if (!nodeName) continue;
    if (!isPodConsumingResources(pod)) continue;
    const list = podsByNode.get(nodeName);
    if (list) list.push(pod);
    else podsByNode.set(nodeName, [pod]);
  }

  const out: NodeOut[] = [];
  for (const node of nodeItems) {
    const nodeName = node.metadata?.name ?? null;
    const allocCpuRaw = node.status?.allocatable?.cpu ?? '';
    const allocMemRaw = node.status?.allocatable?.memory ?? '';
    const allocPodsRaw = node.status?.allocatable?.pods ?? '';
    const allocCpuCores = parseCpuToCores(allocCpuRaw);
    const allocMemBytes = parseMemoryToBytes(allocMemRaw);
    const allocPodCount = Number(allocPodsRaw) || 0;

    const assignedPods = nodeName ? podsByNode.get(nodeName) ?? [] : [];
    let usedCpu = 0;
    let usedMem = 0;
    const podSummaries: NodePodSummary[] = [];
    for (const pod of assignedPods) {
      const { cpuCores, memoryBytes } = podRequests(pod);
      usedCpu += cpuCores;
      usedMem += memoryBytes;
      if (includePods) {
        // Re-derive the raw strings from the totaled requests so downstream
        // consumers see the same shape as `kubectl describe`.
        podSummaries.push({
          namespace: pod.metadata?.namespace ?? null,
          name: pod.metadata?.name ?? null,
          cpuRequest: formatCores(cpuCores),
          memoryRequest: formatBytes(memoryBytes),
          cpuRequestCores: cpuCores,
          memoryRequestBytes: memoryBytes,
        });
      }
    }

    const remainingCpu = Math.max(allocCpuCores - usedCpu, 0);
    const remainingMem = Math.max(allocMemBytes - usedMem, 0);
    const remainingPodSlots = Math.max(allocPodCount - assignedPods.length, 0);

    const taints: NodeTaintOut[] = (node.spec?.taints ?? []).map((t) => ({
      key: t.key ?? null,
      value: t.value ?? null,
      effect: t.effect ?? null,
    }));
    const conditions: NodeConditionOut[] = (node.status?.conditions ?? []).map((c) => ({
      type: c.type ?? null,
      status: c.status ?? null,
      reason: c.reason ?? null,
      message: c.message ?? null,
      lastTransitionTime: isoOrNull(c.lastTransitionTime ?? null),
    }));

    const entry: NodeOut = {
      name: nodeName,
      labels: node.metadata?.labels ?? {},
      taints,
      conditions,
      allocatable: {
        cpu: allocCpuRaw,
        memory: allocMemRaw,
        pods: allocPodsRaw,
        cpuCores: allocCpuCores,
        memoryBytes: allocMemBytes,
        podCount: allocPodCount,
      },
      allocated: {
        cpu: formatCores(usedCpu),
        memory: formatBytes(usedMem),
        pods: String(assignedPods.length),
        cpuCores: usedCpu,
        memoryBytes: usedMem,
        podCount: assignedPods.length,
      },
      remaining: {
        cpu: formatCores(remainingCpu),
        memory: formatBytes(remainingMem),
        pods: String(remainingPodSlots),
        cpuCores: remainingCpu,
        memoryBytes: remainingMem,
        podCount: remainingPodSlots,
      },
    };
    if (includePods) entry.pods = podSummaries;
    out.push(entry);
  }

  return withRateLimitHeaders(NextResponse.json({ nodes: out }), rl);
}
