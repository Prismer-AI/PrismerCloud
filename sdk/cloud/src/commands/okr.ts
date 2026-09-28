// `cloud okr (objective|kr|link|insights)` — OKR charter control loop (release203 Task 3).
//
// Agent-facing port of the daemon `prismer okr` namespace. The canonical
// "agent drafts an OKR charter" path: from a human's plain-language goal an agent
// drafts ONE Objective + 2-5 KRs, links existing tasks, and asks the human sponsor
// to COMMIT. Hard rules (enforced server-side, mirrored in the okr SKILL.md):
//   - an agent may PROPOSE but never COMMIT (`commit` → AGENT_CANNOT_COMMIT 403);
//   - a committed-type objective REQUIRES a human/admin sponsor (SPONSOR_MUST_BE_HUMAN);
//   - a qualitative KR may only be scored with an explicit human-confirmed value+evidence.
// Reuses the already-committed `/api/im/okr/*` endpoints (IM `{ok,data}` envelope).

import { Command } from 'commander';
import { PrismerClient } from '../index';

type ClientFactory = () => PrismerClient;

interface OkrEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

function emit(payload: unknown, json: boolean | undefined): void {
  // The cloud CLI prints JSON for OKR payloads (structured, never fabricated).
  // `--json` is accepted for parity but the human/JSON output is identical here.
  void json;
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function fail(res: OkrEnvelope, fallback: string): never {
  process.stderr.write(`Error: ${res.error?.message ?? fallback}\n`);
  process.exit(1);
}

function buildObjectiveCommand(getIMClient: ClientFactory): Command {
  const cmd = new Command('objective').description('Draft / inspect / commit OKR objectives');

  cmd
    .command('create')
    .description('Draft an objective (agent proposes; a HUMAN sponsor must `objective commit` it)')
    .requiredOption('--workspace <id>', 'Workspace id')
    .requiredOption('--title <text>', 'Objective title (an observable outcome)')
    .option('--type <type>', "'committed' | 'aspirational'", 'aspirational')
    .option('--narrative <text>', 'Why this objective exists / definition of done')
    .option('--cycle <label>', 'Cycle label (e.g. 2026-Q3)')
    .option('--owner <imUserId>', 'Owner IMUser.id')
    .option('--sponsor <imUserId>', 'Sponsor IMUser.id (committed-type REQUIRES a human/admin sponsor)')
    .option('--parent <objectiveId>', 'Parent objective id (for tree alignment)')
    .option('--confidence <n>', '0..1 confidence', (v) => Number.parseFloat(v))
    .option('--json', 'output raw JSON response')
    .action(async (opts: {
      workspace: string; title: string; type?: string; narrative?: string; cycle?: string;
      owner?: string; sponsor?: string; parent?: string; confidence?: number; json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {
          workspaceId: opts.workspace,
          title: opts.title,
          type: opts.type,
        };
        if (opts.narrative) body.narrative = opts.narrative;
        if (opts.cycle) body.cycleLabel = opts.cycle;
        if (opts.owner) body.ownerImUserId = opts.owner;
        if (opts.sponsor) body.sponsorImUserId = opts.sponsor;
        if (opts.parent) body.parentObjectiveId = opts.parent;
        if (opts.confidence != null && !Number.isNaN(opts.confidence)) body.confidence = opts.confidence;
        const res = await client.im.request<OkrEnvelope>('POST', '/api/im/okr/objectives', body);
        if (!res.ok || !res.data) fail(res, 'okr objective create failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .description("List a workspace's objectives (optionally filter by state)")
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--state <state>', 'Filter by objective state')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { workspace: string; state?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const query: Record<string, string> = { workspaceId: opts.workspace };
        if (opts.state) query.state = opts.state;
        const res = await client.im.request<OkrEnvelope>('GET', '/api/im/okr/objectives', undefined, query);
        if (!res.ok || !res.data) fail(res, 'okr objective list failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('get <objectiveId>')
    .description('Fetch a single objective (+ its key results)')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'GET',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}`,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective get failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('commit <objectiveId>')
    .description('Commit an objective — HUMAN/SPONSOR ONLY. An agent caller gets AGENT_CANNOT_COMMIT (403).')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/commit`,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective commit failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('close <objectiveId>')
    .description('Close an objective, optionally recording a final score')
    .option('--score <n>', 'Final score 0..1', (v) => Number.parseFloat(v))
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { score?: number; json?: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {};
        if (opts.score != null && !Number.isNaN(opts.score)) body.score = opts.score;
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/close`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective close failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  // ── Lifecycle back-half (release203/05 Phase 5-8) ──────────────────────────

  cmd
    .command('checkin <objectiveId>')
    .description('Record a check-in (snapshots score + each KR). Agents MAY draft check-ins.')
    .option('--note <text>', 'Free-text note on this check-in')
    .option('--confidence <n>', '0..1 confidence', (v) => Number.parseFloat(v))
    .option('--decision <d>', "'continue' | 'rescope' | 'add-resource' | 'pause' | 'cancel'")
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { note?: string; confidence?: number; decision?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {};
        if (opts.note) body.note = opts.note;
        if (opts.confidence != null && !Number.isNaN(opts.confidence)) body.confidence = opts.confidence;
        if (opts.decision) body.decision = opts.decision;
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/checkins`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective checkin failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('grade <objectiveId>')
    .description('Grade an objective (formal evaluation) — HUMAN ONLY. An agent caller gets AGENT_CANNOT_GRADE (403).')
    .option('--score <n>', 'Final score 0..1 (defaults to the computed rollup)', (v) => Number.parseFloat(v))
    .option('--narrative <text>', 'Evaluation narrative')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { score?: number; narrative?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {};
        if (opts.score != null && !Number.isNaN(opts.score)) body.score = opts.score;
        if (opts.narrative) body.narrative = opts.narrative;
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/grade`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective grade failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('archive <objectiveId>')
    .description('Archive a graded/closed objective (read-only carry-over source) — HUMAN ONLY (AGENT_CANNOT_GRADE).')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/archive`,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective archive failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('retro <objectiveId>')
    .description('Record a post-grade retro on a graded/archived objective (NARRATIVE only). Agents MAY draft.')
    .requiredOption('--narrative <text>', 'What happened / reflection (required)')
    .option('--worked <text>', 'What worked')
    .option('--failed <text>', 'What failed')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { narrative: string; worked?: string; failed?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = { narrative: opts.narrative };
        if (opts.worked) body.whatWorked = opts.worked;
        if (opts.failed) body.whatFailed = opts.failed;
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/retro`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective retro failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('carry-over <objectiveId>')
    .description('Carry a graded/archived/closed objective forward into a successor DRAFT (then commit normally).')
    .requiredOption('--target-cycle <label>', 'Target cycle label for the successor (e.g. 2026-Q4)')
    .option('--kr <id...>', 'Key result id(s) to carry forward (baseline = source current)')
    .option('--reason <text>', 'Why this carries over')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: { targetCycle: string; kr?: string[]; reason?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {
          targetCycle: opts.targetCycle,
          keyResultIds: Array.isArray(opts.kr) ? opts.kr : [],
        };
        if (opts.reason) body.reason = opts.reason;
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/carry-over`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr objective carry-over failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

function buildKrCommand(getIMClient: ClientFactory): Command {
  const cmd = new Command('kr').description('Add / recompute key results on an objective');

  cmd
    .command('add <objectiveId>')
    .description('Propose a key result (baseline→target + a measurable evidence source)')
    .requiredOption('--title <text>', 'Key result title')
    .option('--type <type>', "'metric' | 'task' | 'milestone' | 'qualitative'", 'metric')
    .option('--baseline <n>', 'Baseline numeric', (v) => Number.parseFloat(v))
    .option('--target <n>', 'Target numeric', (v) => Number.parseFloat(v))
    .option('--unit <unit>', 'Measurement unit')
    .option('--direction <dir>', "'increase' | 'decrease' | 'maintain' | 'binary'")
    .option('--weight <n>', 'Weight (relative importance)', (v) => Number.parseFloat(v))
    .option('--metric-namespace <ns>', 'IMMetricEvent namespace (binds KR to a metric source)')
    .option('--metric-name <name>', 'IMMetricEvent metric name')
    .option('--metric-agg <agg>', "Metric aggregation: 'avg' | 'sum' | 'last' | 'count'")
    .option('--evidence <policy>', 'Evidence policy text (how this KR is proven)')
    .option('--source <source>', "'assigned' | 'agent-proposed'", 'agent-proposed')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, opts: {
      title: string; type?: string; baseline?: number; target?: number; unit?: string;
      direction?: string; weight?: number; metricNamespace?: string; metricName?: string;
      metricAgg?: string; evidence?: string; source?: string; json?: boolean;
    }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {
          title: opts.title,
          type: opts.type,
        };
        if (opts.baseline != null && !Number.isNaN(opts.baseline)) body.baselineNumeric = opts.baseline;
        if (opts.target != null && !Number.isNaN(opts.target)) body.targetNumeric = opts.target;
        if (opts.unit) body.unit = opts.unit;
        if (opts.direction) body.direction = opts.direction;
        if (opts.weight != null && !Number.isNaN(opts.weight)) body.weight = opts.weight;
        if (opts.evidence) body.evidencePolicy = opts.evidence;
        if (opts.source) body.source = opts.source;
        // Assemble metricBinding from the metric-* flags. Bind ONLY to a real
        // IMMetricEvent source — namespace + name are required together.
        if (opts.metricNamespace || opts.metricName) {
          if (!opts.metricNamespace || !opts.metricName) {
            process.stderr.write(
              'Error: --metric-namespace and --metric-name must be provided together to bind a metric source\n',
            );
            process.exit(1);
          }
          const binding: Record<string, unknown> = {
            namespace: opts.metricNamespace,
            name: opts.metricName,
          };
          if (opts.metricAgg) binding.agg = opts.metricAgg;
          body.metricBinding = binding;
        }
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/key-results`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr kr add failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('recompute <keyResultId>')
    .description('Recompute a KR. For a qualitative KR you MUST pass a human-confirmed --value + --evidence.')
    .option('--value <n>', 'Human-confirmed numeric value (qualitative KR)', (v) => Number.parseFloat(v))
    .option('--evidence <ref>', 'Evidence reference (asset:<id> / url / note)')
    .option('--json', 'output raw JSON response')
    .action(async (keyResultId: string, opts: { value?: number; evidence?: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const body: Record<string, unknown> = {};
        if (opts.value != null && !Number.isNaN(opts.value)) body.value = opts.value;
        if (opts.evidence) body.evidenceRef = opts.evidence;
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/key-results/${encodeURIComponent(keyResultId)}/recompute`,
          body,
        );
        if (!res.ok || !res.data) fail(res, 'okr kr recompute failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

function buildPackCommand(getIMClient: ClientFactory): Command {
  // `okr pack` — Scenario Packs (release203/04 §6, R4). Packs are global,
  // data-driven OKR templates. `software` is deliverable; `sales`/`marketing`
  // are DATA-ONLY spec (deliverable:false) and adopt → PACK_NOT_DELIVERABLE.
  const cmd = new Command('pack').description('List / inspect / adopt scenario OKR packs');

  cmd
    .command('list')
    .description('List scenario packs (domain / version / deliverable + archetypes)')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>('GET', '/api/im/okr/packs');
        if (!res.ok || !res.data) fail(res, 'okr pack list failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('get <domain>')
    .description('Fetch a full scenario pack (archetypes + KR catalog + evidence policy)')
    .option('--json', 'output raw JSON response')
    .action(async (domain: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'GET',
          `/api/im/okr/packs/${encodeURIComponent(domain)}`,
        );
        if (!res.ok || !res.data) fail(res, 'okr pack get failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  cmd
    .command('adopt <domain> <archetypeId>')
    .description('Seed a draft Objective + KRs from a pack archetype (stamps the commit-time pack snapshot). Spec-only packs → PACK_NOT_DELIVERABLE.')
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--json', 'output raw JSON response')
    .action(async (domain: string, archetypeId: string, opts: { workspace: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          `/api/im/okr/packs/${encodeURIComponent(domain)}/archetypes/${encodeURIComponent(archetypeId)}/adopt`,
          { workspaceId: opts.workspace },
        );
        if (!res.ok || !res.data) fail(res, 'okr pack adopt failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

export function register(parent: Command, getIMClient: ClientFactory, _getAPIClient: ClientFactory): void {
  const okr = parent.command('okr').description('Draft and track OKR objectives + key results');

  okr.addCommand(buildObjectiveCommand(getIMClient));
  okr.addCommand(buildKrCommand(getIMClient));
  okr.addCommand(buildPackCommand(getIMClient));

  okr
    .command('link <objectiveId> <keyResultId> <taskId>')
    .description('Link an existing task to a KR (scope strategic work to a measurable result)')
    .option('--json', 'output raw JSON response')
    .action(async (objectiveId: string, keyResultId: string, taskId: string, opts: { json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'POST',
          '/api/im/okr/work-links',
          { objectiveId, keyResultId, taskId },
        );
        if (!res.ok || !res.data) fail(res, 'okr link failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  okr
    .command('insights')
    .description('Read the workspace OKR tree (objectives + KR progress, never fabricated)')
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--json', 'output raw JSON response')
    .action(async (opts: { workspace: string; json?: boolean }) => {
      const client = getIMClient();
      try {
        const res = await client.im.request<OkrEnvelope>(
          'GET',
          '/api/im/insights/okr',
          undefined,
          { workspaceId: opts.workspace },
        );
        if (!res.ok || !res.data) fail(res, 'okr insights failed');
        emit(res.data, opts.json);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
