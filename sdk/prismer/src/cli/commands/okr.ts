// `prismer okr (objective|kr|link|insights)` — OKR charter control loop (release203 Task 3).
//
// The canonical "agent drafts an OKR charter" path: from a human's plain-language
// goal an agent drafts ONE Objective + 2-5 KRs, links existing tasks, and asks the
// human sponsor to COMMIT. Hard rules (enforced server-side, mirrored in SKILL.md):
//   - an agent may PROPOSE but never COMMIT (`commit` → AGENT_CANNOT_COMMIT 403);
//   - a committed-type objective REQUIRES a human/admin sponsor (SPONSOR_MUST_BE_HUMAN);
//   - a qualitative KR may only be scored with an explicit human-confirmed value+evidence.
// Endpoints (`/api/im/okr/*`, IM `{ok,data}`) are already committed; this command USES them.

import { Command } from 'commander';
import { CloudClient } from '../../auth.js';
import { loadConfig, resolvePaths } from '../../config.js';
import { exitWithError, printJson, runAction } from '../util.js';

function describeStatus(status: number): string {
  return status === 0 ? 'network error' : `HTTP ${status}`;
}

function mkCloud(): CloudClient {
  const cfg = loadConfig(resolvePaths());
  return new CloudClient({ baseUrl: cfg.cloud_api_base, apiKey: cfg.api_key });
}

/** POST/PATCH/DELETE with uniform error→exit, returning the `{ok,data}` envelope's data. */
async function send(
  cloud: CloudClient,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: Record<string, unknown> | undefined,
  failCode: string,
): Promise<unknown> {
  const res = await cloud.request<{ data?: unknown }>(method, path, body ? { body } : undefined);
  if (!res.ok) {
    exitWithError(
      `${failCode} (${describeStatus(res.status)}): ${res.error?.message ?? 'request failed'}`,
      { code: res.error?.code ?? failCode },
    );
  }
  return res.data && typeof res.data === 'object' && 'data' in (res.data as object)
    ? (res.data as { data?: unknown }).data
    : res.data;
}

function buildObjectiveCommand(): Command {
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
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{
      workspace: string; title: string; type?: string; narrative?: string; cycle?: string;
      owner?: string; sponsor?: string; parent?: string; confidence?: number;
    }]>(async (opts) => {
      const cloud = mkCloud();
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
      const data = await send(cloud, 'POST', '/api/im/okr/objectives', body, 'okr_objective_create_failed');
      printJson(data);
    }, { code: 'okr_objective_create_failed' }));

  cmd
    .command('list')
    .description('List a workspace\'s objectives (optionally filter by state)')
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--state <state>', 'Filter by objective state')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{ workspace: string; state?: string }]>(async (opts) => {
      const cloud = mkCloud();
      const query = new URLSearchParams({ workspaceId: opts.workspace });
      if (opts.state) query.set('state', opts.state);
      const data = await cloud.get(`/api/im/okr/objectives?${query.toString()}`);
      printJson(data);
    }, { code: 'okr_objective_list_failed' }));

  cmd
    .command('get <objectiveId>')
    .description('Fetch a single objective (+ its key results)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (objectiveId) => {
      const cloud = mkCloud();
      const data = await cloud.get(`/api/im/okr/objectives/${encodeURIComponent(objectiveId)}`);
      printJson(data);
    }, { code: 'okr_objective_get_failed' }));

  cmd
    .command('commit <objectiveId>')
    .description('Commit an objective — HUMAN/SPONSOR ONLY. An agent caller gets AGENT_CANNOT_COMMIT (403).')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (objectiveId) => {
      const cloud = mkCloud();
      const data = await send(
        cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/commit`,
        undefined, 'okr_objective_commit_failed',
      );
      printJson(data);
    }, { code: 'okr_objective_commit_failed' }));

  cmd
    .command('close <objectiveId>')
    .description('Close an objective, optionally recording a final score')
    .option('--score <n>', 'Final score 0..1', (v) => Number.parseFloat(v))
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { score?: number }]>(async (objectiveId, opts) => {
      const cloud = mkCloud();
      const body: Record<string, unknown> = {};
      if (opts.score != null && !Number.isNaN(opts.score)) body.score = opts.score;
      const data = await send(
        cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/close`,
        body, 'okr_objective_close_failed',
      );
      printJson(data);
    }, { code: 'okr_objective_close_failed' }));

  // ── Lifecycle back-half (release203/05 Phase 5-8) ──────────────────────────

  cmd
    .command('checkin <objectiveId>')
    .description('Record a check-in (snapshots score + each KR). Agents MAY draft check-ins.')
    .option('--note <text>', 'Free-text note on this check-in')
    .option('--confidence <n>', '0..1 confidence', (v) => Number.parseFloat(v))
    .option('--decision <d>', "'continue' | 'rescope' | 'add-resource' | 'pause' | 'cancel'")
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { note?: string; confidence?: number; decision?: string }]>(
      async (objectiveId, opts) => {
        const cloud = mkCloud();
        const body: Record<string, unknown> = {};
        if (opts.note) body.note = opts.note;
        if (opts.confidence != null && !Number.isNaN(opts.confidence)) body.confidence = opts.confidence;
        if (opts.decision) body.decision = opts.decision;
        const data = await send(
          cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/checkins`,
          body, 'okr_objective_checkin_failed',
        );
        printJson(data);
      }, { code: 'okr_objective_checkin_failed' }));

  cmd
    .command('grade <objectiveId>')
    .description('Grade an objective (formal evaluation) — HUMAN ONLY. An agent caller gets AGENT_CANNOT_GRADE (403).')
    .option('--score <n>', 'Final score 0..1 (defaults to the computed rollup)', (v) => Number.parseFloat(v))
    .option('--narrative <text>', 'Evaluation narrative')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { score?: number; narrative?: string }]>(async (objectiveId, opts) => {
      const cloud = mkCloud();
      const body: Record<string, unknown> = {};
      if (opts.score != null && !Number.isNaN(opts.score)) body.score = opts.score;
      if (opts.narrative) body.narrative = opts.narrative;
      const data = await send(
        cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/grade`,
        body, 'okr_objective_grade_failed',
      );
      printJson(data);
    }, { code: 'okr_objective_grade_failed' }));

  cmd
    .command('archive <objectiveId>')
    .description('Archive a graded/closed objective (read-only carry-over source) — HUMAN ONLY (AGENT_CANNOT_GRADE).')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (objectiveId) => {
      const cloud = mkCloud();
      const data = await send(
        cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/archive`,
        undefined, 'okr_objective_archive_failed',
      );
      printJson(data);
    }, { code: 'okr_objective_archive_failed' }));

  cmd
    .command('retro <objectiveId>')
    .description('Record a post-grade retro on a graded/archived objective (NARRATIVE only). Agents MAY draft.')
    .requiredOption('--narrative <text>', 'What happened / reflection (required)')
    .option('--worked <text>', 'What worked')
    .option('--failed <text>', 'What failed')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { narrative: string; worked?: string; failed?: string }]>(
      async (objectiveId, opts) => {
        const cloud = mkCloud();
        const body: Record<string, unknown> = { narrative: opts.narrative };
        if (opts.worked) body.whatWorked = opts.worked;
        if (opts.failed) body.whatFailed = opts.failed;
        const data = await send(
          cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/retro`,
          body, 'okr_objective_retro_failed',
        );
        printJson(data);
      }, { code: 'okr_objective_retro_failed' }));

  cmd
    .command('carry-over <objectiveId>')
    .description('Carry a graded/archived/closed objective forward into a successor DRAFT (then commit normally).')
    .requiredOption('--target-cycle <label>', 'Target cycle label for the successor (e.g. 2026-Q4)')
    .option('--kr <id...>', 'Key result id(s) to carry forward (baseline = source current)')
    .option('--reason <text>', 'Why this carries over')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { targetCycle: string; kr?: string[]; reason?: string }]>(
      async (objectiveId, opts) => {
        const cloud = mkCloud();
        const body: Record<string, unknown> = {
          targetCycle: opts.targetCycle,
          keyResultIds: Array.isArray(opts.kr) ? opts.kr : [],
        };
        if (opts.reason) body.reason = opts.reason;
        const data = await send(
          cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/carry-over`,
          body, 'okr_objective_carry_over_failed',
        );
        printJson(data);
      }, { code: 'okr_objective_carry_over_failed' }));

  return cmd;
}

function buildKrCommand(): Command {
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
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, {
      title: string; type?: string; baseline?: number; target?: number; unit?: string;
      direction?: string; weight?: number; metricNamespace?: string; metricName?: string;
      metricAgg?: string; evidence?: string; source?: string;
    }]>(async (objectiveId, opts) => {
      const cloud = mkCloud();
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
          exitWithError(
            '--metric-namespace and --metric-name must be provided together to bind a metric source',
            { code: 'okr_kr_metric_binding_incomplete' },
          );
        }
        const binding: Record<string, unknown> = {
          namespace: opts.metricNamespace,
          name: opts.metricName,
        };
        if (opts.metricAgg) binding.agg = opts.metricAgg;
        body.metricBinding = binding;
      }
      const data = await send(
        cloud, 'POST', `/api/im/okr/objectives/${encodeURIComponent(objectiveId)}/key-results`,
        body, 'okr_kr_add_failed',
      );
      printJson(data);
    }, { code: 'okr_kr_add_failed' }));

  cmd
    .command('recompute <keyResultId>')
    .description('Recompute a KR. For a qualitative KR you MUST pass a human-confirmed --value + --evidence.')
    .option('--value <n>', 'Human-confirmed numeric value (qualitative KR)', (v) => Number.parseFloat(v))
    .option('--evidence <ref>', 'Evidence reference (asset:<id> / url / note)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, { value?: number; evidence?: string }]>(async (keyResultId, opts) => {
      const cloud = mkCloud();
      const body: Record<string, unknown> = {};
      if (opts.value != null && !Number.isNaN(opts.value)) body.value = opts.value;
      if (opts.evidence) body.evidenceRef = opts.evidence;
      const data = await send(
        cloud, 'POST', `/api/im/okr/key-results/${encodeURIComponent(keyResultId)}/recompute`,
        body, 'okr_kr_recompute_failed',
      );
      printJson(data);
    }, { code: 'okr_kr_recompute_failed' }));

  return cmd;
}

function buildPackCommand(): Command {
  // `okr pack` — Scenario Packs (release203/04 §6, R4). Packs are global,
  // data-driven OKR templates. `software` is deliverable; `sales`/`marketing`
  // are DATA-ONLY spec (deliverable:false) and adopt → PACK_NOT_DELIVERABLE.
  const cmd = new Command('pack').description('List / inspect / adopt scenario OKR packs');

  cmd
    .command('list')
    .description('List scenario packs (domain / version / deliverable + archetypes)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[]>(async () => {
      const cloud = mkCloud();
      const data = await cloud.get('/api/im/okr/packs');
      printJson(data);
    }, { code: 'okr_pack_list_failed' }));

  cmd
    .command('get <domain>')
    .description('Fetch a full scenario pack (archetypes + KR catalog + evidence policy)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string]>(async (domain) => {
      const cloud = mkCloud();
      const data = await cloud.get(`/api/im/okr/packs/${encodeURIComponent(domain)}`);
      printJson(data);
    }, { code: 'okr_pack_get_failed' }));

  cmd
    .command('adopt <domain> <archetypeId>')
    .description('Seed a draft Objective + KRs from a pack archetype (stamps the commit-time pack snapshot). Spec-only packs → PACK_NOT_DELIVERABLE.')
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, string, { workspace: string }]>(async (domain, archetypeId, opts) => {
      const cloud = mkCloud();
      const data = await send(
        cloud, 'POST',
        `/api/im/okr/packs/${encodeURIComponent(domain)}/archetypes/${encodeURIComponent(archetypeId)}/adopt`,
        { workspaceId: opts.workspace }, 'okr_pack_adopt_failed',
      );
      printJson(data);
    }, { code: 'okr_pack_adopt_failed' }));

  return cmd;
}

export function buildOkrCommand(): Command {
  const cmd = new Command('okr').description('Draft and track OKR objectives + key results');

  cmd.addCommand(buildObjectiveCommand());
  cmd.addCommand(buildKrCommand());
  cmd.addCommand(buildPackCommand());

  cmd
    .command('link <objectiveId> <keyResultId> <taskId>')
    .description('Link an existing task to a KR (scope strategic work to a measurable result)')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[string, string, string]>(async (objectiveId, keyResultId, taskId) => {
      const cloud = mkCloud();
      const data = await send(
        cloud, 'POST', '/api/im/okr/work-links',
        { objectiveId, keyResultId, taskId }, 'okr_link_failed',
      );
      printJson(data);
    }, { code: 'okr_link_failed' }));

  cmd
    .command('insights')
    .description('Read the workspace OKR tree (objectives + KR progress, never fabricated)')
    .requiredOption('--workspace <id>', 'Workspace id')
    .option('--json', 'Output JSON (default)')
    .action(runAction<[{ workspace: string }]>(async (opts) => {
      const cloud = mkCloud();
      const query = new URLSearchParams({ workspaceId: opts.workspace });
      const data = await cloud.get(`/api/im/insights/okr?${query.toString()}`);
      printJson(data);
    }, { code: 'okr_insights_failed' }));

  return cmd;
}
