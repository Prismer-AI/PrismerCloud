import { CloudClient } from '../../auth.js';

export interface TakeAdminObservabilityCloudInput {
  env: Record<string, string | undefined>;
  baseUrl: string;
  generalCloud: CloudClient;
}

/**
 * Capture the dedicated Admin key into a daemon-owned client, then erase the
 * inherited environment copy before any coding provider can spawn.
 */
export function takeAdminObservabilityCloud(input: TakeAdminObservabilityCloudInput): CloudClient | undefined {
  const dedicated = input.env.PRISMER_ADMIN_API_KEY?.trim();
  delete input.env.PRISMER_ADMIN_API_KEY;
  if (dedicated) return new CloudClient({ baseUrl: input.baseUrl, apiKey: dedicated });

  const production =
    input.env.APP_ENV === 'prod' || (!input.env.APP_ENV && input.env.NODE_ENV === 'production');
  if (!production && input.env.ADMIN_API_KEY_ALLOW_OWNER_FALLBACK === 'true') return input.generalCloud;
  return undefined;
}
