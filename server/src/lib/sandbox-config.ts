/**
 * Sandbox configuration helpers.
 *
 * §26 B4 — the legacy HTTP path was removed; the in-process
 * `@kubernetes/client-node` SDK (`src/lib/k8s-sandbox.ts`) is now the sole
 * path. The previous toggle + env-probe helpers were dropped; only the K8s
 * capability check remains.
 */

/**
 * True when the cloud process has *some* way to authenticate to a K8s
 * cluster:
 *
 *   - `KUBERNETES_SERVICE_HOST` set → we're in-cluster, service account token
 *     auto-mounted at /var/run/secrets/kubernetes.io/serviceaccount/token
 *   - `K8S_CLUSTER_URL` + `K8S_SERVICE_ACCOUNT_TOKEN` set → explicit remote
 *     cluster (typical dev path: cloud pod running outside the EKS cluster
 *     it's managing)
 *
 * Does NOT verify the credentials actually work — that's `testK8sConnection`'s
 * job and incurs an HTTP round-trip.
 */
export function hasK8sConfig(): boolean {
  return Boolean(
    process.env.KUBERNETES_SERVICE_HOST || (process.env.K8S_CLUSTER_URL && process.env.K8S_SERVICE_ACCOUNT_TOKEN),
  );
}
