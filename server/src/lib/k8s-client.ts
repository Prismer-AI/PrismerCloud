/**
 * Cloud-side Kubernetes client (lazy-loaded)
 *
 * Ported from the deleted controller's `k8sClient.ts` as part of §26 B1;
 * the controller microservice was removed in §26 B4. See
 * `docs/54release/26-controller-removal-architecture-pivot.md`.
 *
 * Lazy-imports `@kubernetes/client-node` so the K8s SDK is NOT pulled into
 * the cloud bundle on docker-only / no-sandbox setups. Every getter below
 * is `async` for the same reason — the first call awaits the dynamic
 * import; subsequent calls hit the cached singletons.
 *
 * Auth resolution order (B1 decision §5):
 *   1. In-cluster (`KUBERNETES_SERVICE_HOST` present, e.g. cloud pod inside
 *      the same EKS cluster as the sandbox pods) — `loadFromCluster()`
 *   2. Explicit remote (`K8S_CLUSTER_URL` + `K8S_SERVICE_ACCOUNT_TOKEN`,
 *      Nacos-injected for cloud pods that manage a *different* cluster than
 *      the one they run in)
 *   3. Kubeconfig file (`K8S_KUBECONFIG_PATH`, dev override)
 *   4. `loadFromDefault()` — picks up `~/.kube/config` or `KUBECONFIG` env
 *
 * Existing Nacos env vars preserved unchanged (`K8S_CLUSTER_URL`,
 * `K8S_SERVICE_ACCOUNT_TOKEN`, `K8S_NAMESPACE`, `K8S_NODE_EXTERNAL_IP`,
 * `K8S_IMAGE_PULL_SECRET`). No new keys introduced (B1 decision §4, §6).
 */

import { logger } from '@/lib/logger';

// ============================================================
// Lazy SDK import
// ============================================================

type K8sModule = typeof import('@kubernetes/client-node');

let _k8sModule: K8sModule | null = null;

async function loadK8sModule(): Promise<K8sModule> {
  if (_k8sModule) return _k8sModule;
  _k8sModule = await import('@kubernetes/client-node');
  return _k8sModule;
}

// ============================================================
// Configuration
// ============================================================

export interface K8sClientConfig {
  clusterUrl?: string;
  serviceAccountToken?: string;
  namespace: string;
  nodeExternalIp?: string;
  kubeconfigPath?: string;
  /** True when `KUBERNETES_SERVICE_HOST` is set (the cloud process is itself a pod). */
  inCluster: boolean;
}

export function getK8sClientConfig(): K8sClientConfig {
  return {
    clusterUrl: process.env.K8S_CLUSTER_URL,
    serviceAccountToken: process.env.K8S_SERVICE_ACCOUNT_TOKEN,
    namespace: process.env.K8S_NAMESPACE || 'prismer-sandbox',
    nodeExternalIp: process.env.K8S_NODE_EXTERNAL_IP,
    kubeconfigPath: process.env.K8S_KUBECONFIG_PATH,
    inCluster: Boolean(process.env.KUBERNETES_SERVICE_HOST),
  };
}

// ============================================================
// Singleton caches
// ============================================================

let _kubeConfig: import('@kubernetes/client-node').KubeConfig | null = null;
let _coreV1Api: import('@kubernetes/client-node').CoreV1Api | null = null;
let _batchV1Api: import('@kubernetes/client-node').BatchV1Api | null = null;
let _exec: import('@kubernetes/client-node').Exec | null = null;

/**
 * Build (or reuse) the KubeConfig.
 *
 * NB: `loadFromDefault()` covers both `KUBECONFIG` env and `~/.kube/config`,
 * which is why §5 of the B1 decision matrix lets us collapse three legacy
 * branches into a single fallback. We keep the explicit
 * `K8S_CLUSTER_URL + K8S_SERVICE_ACCOUNT_TOKEN` branch because Nacos prod/test
 * still ships those — yanking them would silently re-route to the in-cluster
 * service account, which has different RBAC.
 */
export async function getKubeConfig(): Promise<import('@kubernetes/client-node').KubeConfig> {
  if (_kubeConfig) return _kubeConfig;

  const k8s = await loadK8sModule();
  const config = getK8sClientConfig();
  const kc = new k8s.KubeConfig();

  if (config.inCluster) {
    kc.loadFromCluster();
  } else if (config.clusterUrl && config.serviceAccountToken) {
    kc.loadFromOptions({
      clusters: [
        {
          name: 'prismer-cluster',
          server: config.clusterUrl,
          skipTLSVerify: true,
        },
      ],
      users: [
        {
          name: 'prismer-admin',
          token: config.serviceAccountToken,
        },
      ],
      contexts: [
        {
          name: 'prismer-context',
          cluster: 'prismer-cluster',
          user: 'prismer-admin',
          namespace: config.namespace,
        },
      ],
      currentContext: 'prismer-context',
    });
  } else if (config.kubeconfigPath) {
    kc.loadFromFile(config.kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }

  _kubeConfig = kc;
  return kc;
}

export async function getCoreV1Api(): Promise<import('@kubernetes/client-node').CoreV1Api> {
  if (_coreV1Api) return _coreV1Api;
  const k8s = await loadK8sModule();
  const kc = await getKubeConfig();
  _coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  return _coreV1Api;
}

export async function getBatchV1Api(): Promise<import('@kubernetes/client-node').BatchV1Api> {
  if (_batchV1Api) return _batchV1Api;
  const k8s = await loadK8sModule();
  const kc = await getKubeConfig();
  _batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
  return _batchV1Api;
}

export async function getK8sExec(): Promise<import('@kubernetes/client-node').Exec> {
  if (_exec) return _exec;
  const k8s = await loadK8sModule();
  const kc = await getKubeConfig();
  _exec = new k8s.Exec(kc);
  return _exec;
}

/**
 * Re-export of the dynamically-imported `@kubernetes/client-node` module.
 *
 * Use this when you need a class/constructor that's not wrapped by one of the
 * accessors above (e.g. `KubernetesObjectApi`, `Watch`). Avoids each caller
 * having to re-do the lazy-import dance.
 */
export async function getK8sSdk(): Promise<K8sModule> {
  return loadK8sModule();
}

// ============================================================
// Namespace / IP / Secret helpers
// ============================================================

export function getK8sNamespace(): string {
  return getK8sClientConfig().namespace;
}

export function getNodeExternalIp(): string | null {
  return getK8sClientConfig().nodeExternalIp ?? null;
}

export function getImagePullSecret(): string {
  return process.env.K8S_IMAGE_PULL_SECRET || 'prismer-registry-secret';
}

/**
 * Probe the cluster by listing pods in the target namespace (limit=1, the
 * cheapest non-trivial call). Returns void on success; throws on any error.
 *
 * B1 decision §1 deviation from the controller's `Promise<boolean>` — the
 * task spec asks for `Promise<void>` so that callers don't have to second-
 * guess what `false` means. Errors are descriptive (RBAC vs DNS vs auth).
 *
 * Post-§26 review A4: cached for 30s. Every `createContainer` call probes
 * before doing real work; at 50 concurrent provisions that was 50 redundant
 * LIST calls into the apiserver. Once we've proven the cluster is reachable
 * we trust it for 30s — kube-apiserver outages of < 30s are rare enough that
 * the next createContainer's real call surfaces them, and longer outages
 * resurface on the next 30s probe anyway.
 *
 * Failure path is NOT cached — a probe that throws is allowed to throw again
 * on the next call (and most likely will, immediately, until the apiserver
 * is back). We only cache the success signal.
 */
let _lastProbeSuccessAt: number | null = null;
const PROBE_CACHE_MS = 30_000;

export async function testK8sConnection(): Promise<void> {
  if (_lastProbeSuccessAt !== null && Date.now() - _lastProbeSuccessAt < PROBE_CACHE_MS) {
    return;
  }
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();
  await api.listNamespacedPod({ namespace, limit: 1 });
  _lastProbeSuccessAt = Date.now();
}

/**
 * Ensure the target namespace exists; create it if missing.
 *
 * Idempotent. Swallows permission errors (cloud pod may lack
 * `namespaces.create` and that's fine — the namespace was almost certainly
 * pre-provisioned by infra).
 */
export async function ensureNamespace(): Promise<void> {
  const api = await getCoreV1Api();
  const namespace = getK8sNamespace();

  try {
    await api.readNamespace({ name: namespace });
    return;
  } catch {
    // Fall through to create.
  }

  try {
    await api.createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: {
            'app.kubernetes.io/part-of': 'prismer',
            'prismer.managed': 'true',
          },
        },
      },
    });
    logger.info({ namespace }, '[K8sClient] Created namespace');
  } catch (createErr) {
    logger.warn(
      {
        namespace,
        err: createErr instanceof Error ? createErr.message : String(createErr),
      },
      '[K8sClient] Failed to create namespace (may exist with stricter RBAC)',
    );
  }
}

/**
 * Ensure the Docker registry pull secret exists in the target namespace and
 * its `.dockerconfigjson` payload matches what env says.
 *
 * Returns true on success / already-up-to-date, false when registry creds
 * aren't configured (a legit dev path — k3d / kind run with public images).
 *
 * Reads:
 *   K8S_REGISTRY_URL       comma-separated list of registry URLs
 *   K8S_REGISTRY_USER      comma-separated list of usernames
 *   K8S_REGISTRY_PASSWORD  comma-separated list of passwords
 *   K8S_IMAGE_PULL_SECRET  secret name (default: prismer-registry-secret)
 */
export async function ensureImagePullSecret(): Promise<boolean> {
  const registryUrl = process.env.K8S_REGISTRY_URL;
  const registryUser = process.env.K8S_REGISTRY_USER;
  const registryPassword = process.env.K8S_REGISTRY_PASSWORD;

  if (!registryUrl || !registryUser || !registryPassword) {
    logger.debug('[K8sClient] Registry credentials not configured, skipping pull secret');
    return false;
  }

  const secretName = getImagePullSecret();
  const namespace = getK8sNamespace();
  const api = await getCoreV1Api();

  const urls = registryUrl.split(',').map((s) => s.trim());
  const users = registryUser.split(',').map((s) => s.trim());
  const passwords = registryPassword.split(',').map((s) => s.trim());

  const auths: Record<string, { username: string; password: string; auth: string }> = {};
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const user = users[Math.min(i, users.length - 1)];
    const pass = passwords[Math.min(i, passwords.length - 1)];
    auths[url] = {
      username: user,
      password: pass,
      auth: Buffer.from(`${user}:${pass}`).toString('base64'),
    };
  }

  const dockerConfigJson = JSON.stringify({ auths });
  const encodedConfig = Buffer.from(dockerConfigJson).toString('base64');

  try {
    const existing = (await api.readNamespacedSecret({ name: secretName, namespace })) as {
      data?: Record<string, string>;
    };
    if (existing?.data?.['.dockerconfigjson'] === encodedConfig) {
      logger.debug({ secretName }, '[K8sClient] Image pull secret already up-to-date');
      return true;
    }
    await api.replaceNamespacedSecret({
      name: secretName,
      namespace,
      body: {
        metadata: { name: secretName, namespace },
        type: 'kubernetes.io/dockerconfigjson',
        data: { '.dockerconfigjson': encodedConfig },
      },
    });
    logger.info({ secretName, registries: urls }, '[K8sClient] Updated image pull secret');
    return true;
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 404) {
      try {
        await api.createNamespacedSecret({
          namespace,
          body: {
            metadata: { name: secretName, namespace },
            type: 'kubernetes.io/dockerconfigjson',
            data: { '.dockerconfigjson': encodedConfig },
          },
        });
        logger.info({ secretName, registries: urls }, '[K8sClient] Created image pull secret');
        return true;
      } catch (createErr) {
        logger.error(
          {
            secretName,
            err: createErr instanceof Error ? createErr.message : String(createErr),
          },
          '[K8sClient] Failed to create image pull secret',
        );
        return false;
      }
    }

    logger.error(
      { secretName, err: err instanceof Error ? err.message : String(err) },
      '[K8sClient] Failed to update image pull secret',
    );
    return false;
  }
}

/**
 * Reset singleton caches. Tests only.
 */
export function resetK8sClient(): void {
  _kubeConfig = null;
  _coreV1Api = null;
  _batchV1Api = null;
  _exec = null;
  _lastProbeSuccessAt = null;
}
