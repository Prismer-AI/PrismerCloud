import { ensureNacosConfig } from '@/lib/nacos-config';

/**
 * Resolve backend API base URL for internal Next.js API routes
 * that need to proxy to the background service.
 *
 * Priority:
 * 1. BACKEND_API_BASE (full base, may already include /api/v1)
 * 2. BACKGROUND_BASE_URL (root domain, we append /api/v1)
 * 3. Fallback: empty (self-host mode uses local implementations)
 *
 * Nacos will typically provide BACKGROUND_BASE_URL if configured.
 */
function resolveBackendBaseFromEnv(): string {
  const explicit = process.env.BACKEND_API_BASE;
  const background = process.env.BACKGROUND_BASE_URL;

  // If full base is explicitly provided, trust it
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  // If BACKGROUND_BASE_URL is provided, append /api/v1
  if (background) {
    const root = background.replace(/\/$/, '');
    // Avoid double /api/v1 if someone accidentally includes it
    if (root.match(/\/api\/v\d+$/)) {
      return root;
    }
    return `${root}/api/v1`;
  }

  // No backend configured — self-host mode uses local implementations via Feature Flags
  return '';
}

/**
 * Get backend API base URL, ensuring Nacos config is loaded first.
 */
export async function getBackendApiBase(): Promise<string> {
  // Load Nacos config (no-op if already initialized)
  await ensureNacosConfig();
  return resolveBackendBaseFromEnv();
}










