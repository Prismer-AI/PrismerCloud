#!/usr/bin/env -S npx tsx
/**
 * Cloud 3 / S3 — daemon-first task→sandbox→asset roundtrip.
 *
 * What this validates (Phase 1, S3 scope):
 *   1. POST /api/im/tasks with runtimeRoute=sandbox, adapter=hermes,
 *      metadata.shellCommand="echo ... > /workspace/_outbox/hello.md"
 *   2. TaskService.dispatchToSandbox spawns/reuses IMContainer, calls
 *      sandbox-client.daemonDispatch
 *   3. Controller proxies to in-pod daemon localhost:7878/v1/runs (ack)
 *   4. Phase 1 daemon spawns the shellCommand directly (test escape
 *      hatch — see sdk/prismer-cloud/runtime/src/daemon/local-server.ts
 *      DispatchPayload). S4 will replace this with WS-mediated adapter
 *      dispatch + completion.
 *   5. Outbox watcher detects file in /workspace/_outbox/, POSTs
 *      /api/im/assets kind=sandbox-output (metadata.{taskId,
 *      containerId, adapter})
 *   6. We verify asset arrived + bytes match
 *
 * Phase 1 assumption: task stays in 'running' (no S4 daemon-completion
 * handler yet). Asset presence + content match IS the PASS signal —
 * the task lifecycle close is S4 work and is explicitly deferred.
 *
 * Daemon image build no longer blocked — drift #5 (pre-rebuild npm
 * 1.9.x) is unblocked via local-pack tarballs (see docs/54release/
 * 14-daemon-runtime-roadmap.md). Run `bash infra/sandbox-image/
 * build.sh` to build the image used here.
 *
 * Run:
 *   PRISMER_API_KEY=... WORKSPACE_ID=... \
 *     npx tsx scripts/e2e-task-sandbox-roundtrip.ts --env local
 */

const CLOUD_URL = process.env.CLOUD_URL ?? 'http://localhost:3000';
const PRISMER_API_KEY = process.env.PRISMER_API_KEY;
const DEV_USER_ID = process.env.DEV_USER_ID;
const WORKSPACE_ID = process.env.WORKSPACE_ID;

if (!WORKSPACE_ID) {
  console.error('[s3-roundtrip] WORKSPACE_ID env required');
  process.exit(1);
}
if (!PRISMER_API_KEY && !DEV_USER_ID) {
  console.error('[s3-roundtrip] PRISMER_API_KEY or DEV_USER_ID env required');
  process.exit(1);
}
const workspaceId: string = WORKSPACE_ID;

const headers: Record<string, string> = {
  'content-type': 'application/json',
};
if (PRISMER_API_KEY) headers.authorization = `Bearer ${PRISMER_API_KEY}`;
else if (DEV_USER_ID) headers['X-Dev-User-Id'] = DEV_USER_ID;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('[s3-roundtrip] Cloud 3 S3 — daemon-first roundtrip');

  // 1. Verify cloud is reachable (smoke /api/health)
  const healthRes = await fetch(`${CLOUD_URL}/api/health`).catch(() => null);
  if (!healthRes) {
    console.error('[s3-roundtrip] cloud unreachable at', CLOUD_URL);
    process.exit(2);
  }

  // 2. POST task with runtimeRoute=sandbox + adapter=hermes.
  //
  // Phase 1 escape hatch — metadata.shellCommand is forwarded by
  // task.service.dispatchToSandbox to the daemon, which spawns it via
  // `bash -c` with cwd=/workspace. S4 replaces this with real adapter
  // dispatch over the WS upstream channel.
  const expectedContent = `hello-from-daemon-${Date.now()}`;
  const shellCommand = `echo '${expectedContent}' > /workspace/_outbox/hello.md`;
  const taskInputObj = {
    prompt: `write the string '${expectedContent}' to /workspace/_outbox/hello.md`,
  };

  const taskRes = await fetch(`${CLOUD_URL}/api/im/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 's3-roundtrip',
      input: JSON.stringify(taskInputObj),
      runtimeRoute: 'sandbox',
      workspaceId,
      timeoutMs: 60_000,
      metadata: { adapter: 'hermes', shellCommand },
    }),
  });

  if (!taskRes.ok) {
    console.error('[s3-roundtrip] task create failed:', taskRes.status, await taskRes.text());
    process.exit(3);
  }

  const taskJson = (await taskRes.json()) as { task: { id: string; status: string; containerId?: string | null } };
  const task = taskJson.task;
  console.log(`[s3-roundtrip] task ${task.id} created, status=${task.status}`);

  // 3. Poll until task transitions out of 'pending'/'running' OR timeout
  // (S3 Phase 1 leaves task in 'running' on dispatch ack; full transition
  // to 'done' requires daemon WS-upstream handler in S4. So we treat
  // 'running' + IMSandboxRunLog row presence as PASS for Phase 1.)
  const deadline = Date.now() + 120_000;
  let final = task;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch(`${CLOUD_URL}/api/im/tasks/${task.id}`, { headers });
    if (!r.ok) continue;
    const { task: t } = (await r.json()) as { task: { id: string; status: string; containerId?: string | null } };
    console.log(`[s3-roundtrip] task status=${t.status}, containerId=${t.containerId ?? '—'}`);
    if (['completed', 'failed', 'cancelled'].includes(t.status)) {
      final = t;
      break;
    }
    // Phase 1 heuristic: if status is 'running' + containerId set, treat as
    // dispatch-acked + waiting for async completion. Continue polling but
    // record the marker.
    if (t.status === 'running' && t.containerId) {
      final = t;
      // Don't break — keep polling for actual completion
    }
  }

  console.log(`[s3-roundtrip] final task status=${final.status}`);

  // 4. Verify daemon heartbeat surfaced (Cloud 2.5 endpoint)
  // GET /api/im/workspaces/:wsId/runtime should list devices, including
  // a container-mode entry deviceId='container:<podName>' if daemon is alive.
  const runtimeRes = await fetch(
    `${CLOUD_URL}/api/im/workspaces/${encodeURIComponent(workspaceId)}/runtime`,
    { headers },
  );
  if (runtimeRes.ok) {
    const runtime = (await runtimeRes.json()) as { devices?: Array<{ deviceId?: string; lastSeenAt?: string }> };
    const containerDevice = runtime.devices?.find((d) => d.deviceId?.startsWith('container:'));
    if (containerDevice) {
      console.log(`[s3-roundtrip] container device seen: ${containerDevice.deviceId} @ ${containerDevice.lastSeenAt}`);
    } else {
      console.log('[s3-roundtrip] no container device in runtime endpoint (daemon may not have started)');
    }
  } else {
    console.log('[s3-roundtrip] /api/im/workspaces/:wsId/runtime not reachable; skipping heartbeat check');
  }

  // 5. Verify asset uploaded with kind=sandbox-output
  const assetsRes = await fetch(
    `${CLOUD_URL}/api/im/assets?workspaceId=${encodeURIComponent(workspaceId)}&kind=sandbox-output&limit=10`,
    { headers },
  );
  if (!assetsRes.ok) {
    console.error('[s3-roundtrip] assets list failed:', assetsRes.status);
    process.exit(4);
  }
  const assetsJson = (await assetsRes.json()) as {
    data?: Array<{ id: string; kind: string; sourceTaskId?: string | null; metadata?: Record<string, unknown> | string }>;
  };
  const taskAsset = (assetsJson.data ?? []).find((a) => {
    if (a.sourceTaskId === task.id) return true;
    try {
      const meta = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : (a.metadata ?? {});
      return (meta as { taskId?: string }).taskId === task.id;
    } catch { return false; }
  });

  if (!taskAsset) {
    console.warn('[s3-roundtrip] no asset found with kind=sandbox-output for this task');
    console.warn('[s3-roundtrip] (expected if daemon image not built yet — @prismer/runtime publish blocker)');
    process.exit(5);
  }

  console.log(`[s3-roundtrip] taskAsset id=${taskAsset.id}`);

  // 6. Download bytes + verify
  const detailRes = await fetch(`${CLOUD_URL}/api/im/assets/${taskAsset.id}`, { headers });
  if (!detailRes.ok) {
    console.error('[s3-roundtrip] asset detail failed:', detailRes.status);
    process.exit(6);
  }
  const detail = (await detailRes.json()) as { data?: { storageUri?: string; servingUrl?: string } };
  const url = detail.data?.servingUrl ?? `${CLOUD_URL}/api/im/assets/${taskAsset.id}/blob`;
  const bytesRes = await fetch(url, { headers });
  if (!bytesRes.ok) {
    console.error('[s3-roundtrip] asset bytes failed:', bytesRes.status);
    process.exit(7);
  }
  const text = await bytesRes.text();
  console.log(`[s3-roundtrip] asset bytes: ${text.slice(0, 80)}`);

  if (!text.includes(expectedContent)) {
    console.error(`[s3-roundtrip] content mismatch — expected to contain '${expectedContent}'`);
    process.exit(8);
  }

  console.log('[s3-roundtrip] ✅ PASS — daemon roundtrip closed');
  process.exit(0);
}

main().catch((err) => {
  console.error('[s3-roundtrip] error:', err);
  process.exit(1);
});
