const AUTH_STORAGE_KEY = 'prismer_auth';
const ACTIVE_API_KEY_STORAGE_KEY = 'prismer_active_api_key';

/** Resolve the bearer token used by IM HTTP and EventSource clients. */
export function getIMClientToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.token && typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
        return parsed.token as string;
      }
    }
  } catch {
    /* fall through to API key */
  }
  try {
    const stored = localStorage.getItem(ACTIVE_API_KEY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.key && parsed?.status === 'ACTIVE') return parsed.key as string;
    }
  } catch {
    /* ignore */
  }
  return null;
}
