import Redis from 'ioredis';

function getRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const host = process.env.REDIS_HOST || 'localhost';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD || '';
  const db = process.env.REDIS_DB || '0';
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  return `redis://${auth}${host}:${port}/${db}`;
}

export async function loadRuntimeDaemonPresence(
  workspaceId: string,
  daemonIds: Iterable<string>,
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(Array.from(daemonIds).filter(Boolean)));
  const out = new Map<string, number>();
  if (ids.length === 0) return out;

  const redis = new Redis(getRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await redis.connect();
    const pipeline = redis.pipeline();
    for (const daemonId of ids) {
      pipeline.ttl(`runtime:device:${workspaceId}:${daemonId}`);
    }
    const results = await pipeline.exec();
    results?.forEach(([err, res], index) => {
      if (err) return;
      const ttl = typeof res === 'number' ? res : -2;
      if (ttl > 0) out.set(ids[index]!, 0);
    });
  } catch {
    // Presence is advisory; callers fall back to durable heartbeat columns.
  } finally {
    redis.disconnect();
  }

  return out;
}
