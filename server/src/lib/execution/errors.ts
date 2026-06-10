/**
 * Provider-agnostic error model for sandbox/execution-environment routes.
 *
 * See `docs/release200/08-execution-environment-design.md` §6.3.
 *
 * Background: pre-v200, sandbox routes throw / catch `K8sSandboxError`
 * (defined in `src/lib/k8s-sandbox.ts`). That ties the API surface to the
 * K8s provider — for v200 we want routes to be provider-agnostic so e2b /
 * daytona / docker-host can plug in without touching every route.
 *
 * Adapters (k8s-provider, docker-host-provider, e2b-provider) catch their
 * provider-native errors at the provider boundary and translate to
 * `ProviderError`. Routes catch `ProviderError` and surface HTTP status via
 * `httpStatusForProviderError`.
 */

/**
 * Stable, provider-agnostic error codes. Extending this union is a
 * backwards-compatible change; rename / remove is a breaking change for
 * any consumer that switches on the code.
 *
 * `not_found` / `forbidden` were added beyond the 08 §6.3 base set because
 * existing sandbox routes have explicit 404 / 403 paths (container missing,
 * workspace ownership failure) that need to round-trip through ProviderError
 * when adapters surface them.
 */
export type ProviderErrorCode =
  | 'image_pull_failed'
  | 'quota_exceeded'
  | 'capacity_exhausted'
  | 'daemon_unreachable'
  | 'auth_failed'
  | 'timeout'
  | 'invalid_config'
  | 'snapshot_failed'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retriable: boolean,
    public readonly providerRef?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Map a `ProviderErrorCode` to the HTTP status the route should surface.
 *
 * Convention (kept parallel with the legacy `statusForCode` in
 * `k8s-sandbox.ts` so the wire-level shape doesn't drift for K8s callers):
 *   - 404: not_found
 *   - 403: forbidden
 *   - 409: conflict (already-exists / busy)
 *   - 408: timeout
 *   - 502: daemon_unreachable / image_pull_failed (downstream infra broken)
 *   - 503: capacity_exhausted (cluster overloaded — try later)
 *   - 401: auth_failed
 *   - 400: invalid_config (caller-supplied data wrong)
 *   - 429: quota_exceeded
 *   - 500: snapshot_failed / unknown (catch-all infra failure)
 */
export function httpStatusForProviderError(err: ProviderError): number {
  switch (err.code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'conflict':
      return 409;
    case 'timeout':
      return 408;
    case 'daemon_unreachable':
    case 'image_pull_failed':
      return 502;
    case 'capacity_exhausted':
      return 503;
    case 'auth_failed':
      return 401;
    case 'invalid_config':
      return 400;
    case 'quota_exceeded':
      return 429;
    case 'snapshot_failed':
    case 'unknown':
    default:
      return 500;
  }
}

/**
 * Map a K8s-native `K8sSandboxError` (or unknown error) into a
 * `ProviderError`. Used by k8s-provider at the adapter boundary so routes
 * see a uniform error type regardless of which provider was resolved.
 *
 * Note: we import the K8sSandboxError class lazily (via runtime instanceof
 * check on the constructor name) to avoid pulling in `k8s-sandbox.ts`'s
 * 1500-line module just to type-check this helper from a non-K8s adapter.
 * The structural check (`err.code`, `err.status`, `err.body`) is sufficient
 * — the class itself is single-source-of-truth in `src/lib/k8s-sandbox.ts`.
 */
export function fromK8sSandboxError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  // Structural duck-type to avoid importing K8sSandboxError directly here.
  const e = err as
    | {
        name?: string;
        code?: string;
        message?: string;
        status?: number;
        body?: string;
        containerId?: string;
      }
    | null
    | undefined;

  if (!e) {
    return new ProviderError('unknown', 'Unknown error from K8s provider', false);
  }

  const message = typeof e.message === 'string' ? e.message : 'k8s provider failure';
  const providerRef: Record<string, unknown> = {};
  if (e.containerId) providerRef.containerId = e.containerId;
  if (typeof e.status === 'number') providerRef.k8sStatus = e.status;
  if (typeof e.body === 'string') providerRef.k8sBody = e.body;
  if (typeof e.code === 'string') providerRef.k8sCode = e.code;

  // K8sSandboxErrorCode → ProviderErrorCode
  switch (e.code) {
    case 'CONTAINER_NOT_FOUND':
      return new ProviderError('not_found', message, false, providerRef);
    case 'CONTAINER_ALREADY_EXISTS':
      return new ProviderError('conflict', message, false, providerRef);
    case 'K8S_NOT_AVAILABLE':
      return new ProviderError('capacity_exhausted', message, true, providerRef);
    case 'DAEMON_UNREACHABLE':
    case 'POD_IP_UNAVAILABLE':
    case 'HEALTHZ_FAILED':
      return new ProviderError('daemon_unreachable', message, true, providerRef);
    case 'CONTAINER_START_FAILED':
      // K8sSandbox folds image-pull failures into CONTAINER_START_FAILED; sniff
      // the message body to surface a more specific code when possible.
      if (/image pull failed|imagepullbackoff|errimagepull/i.test(message)) {
        return new ProviderError('image_pull_failed', message, true, providerRef);
      }
      return new ProviderError('unknown', message, true, providerRef);
    case 'CONTAINER_STOP_FAILED':
      return new ProviderError('unknown', message, true, providerRef);
    case 'SNAPSHOT_FAILED':
      return new ProviderError('snapshot_failed', message, false, providerRef);
    case 'UNKNOWN_ERROR':
    default:
      return new ProviderError('unknown', message, false, providerRef);
  }
}
