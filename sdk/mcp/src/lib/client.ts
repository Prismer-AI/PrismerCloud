const BASE_URL = process.env.PRISMER_BASE_URL || 'https://prismer.cloud';
const API_KEY = process.env.PRISMER_API_KEY || '';

export function getApiKey(): string {
  return API_KEY;
}

export async function prismerFetch(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string> } = {}
): Promise<unknown> {
  if (!API_KEY) {
    throw new Error('PRISMER_API_KEY environment variable is required');
  }

  const url = new URL(path, BASE_URL);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    let message: string;
    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || text;
    } catch {
      message = text;
    }
    throw new Error(`Prismer API ${response.status}: ${message}`);
  }

  return response.json();
}
