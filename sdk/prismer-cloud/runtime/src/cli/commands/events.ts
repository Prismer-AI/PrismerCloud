// `prismer events` and `prismer events:stats` — local PARA event log reader.

import { Command } from 'commander';
import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { printJson } from '../util.js';
import { getUI } from '../ui.js';

type JsonObject = Record<string, unknown>;

interface EventFilters {
  limit: number;
  agentId?: string;
  sessionId?: string;
  family?: string;
  type?: string;
}

interface LocalEvent {
  [key: string]: unknown;
}

const DEFAULT_LIMIT = 50;

export function buildEventsCommand(): Command {
  return addEventOptions(new Command('events').description('Read local PARA events from ~/.prismer/para/events.jsonl'))
    .action(async (opts: EventFilters) => {
      const file = eventsPath();
      if (!existsSync(file)) {
        printJson(unavailable(file));
        process.exitCode = 1;
        return;
      }
      const filters = normalizeFilters(opts);
      const events = await readEvents(file, filters);
      printJson({
        ok: true,
        data: { events, count: events.length, limit: filters.limit },
        checks: { file, exists: true, filters: cleanFilters(filters) },
      });
    });
}

export function buildEventsStatsCommand(): Command {
  return addEventOptions(new Command('events:stats').description('Summarize local PARA events from ~/.prismer/para/events.jsonl'))
    .action(async (opts: EventFilters) => {
      const file = eventsPath();
      if (!existsSync(file)) {
        printJson(unavailable(file));
        process.exitCode = 1;
        return;
      }
      const filters = normalizeFilters(opts);
      const events = await readEvents(file, filters);
      printJson({
        ok: true,
        data: { stats: summarize(events), count: events.length, limit: filters.limit },
        checks: { file, exists: true, filters: cleanFilters(filters) },
      });
    });
}

function addEventOptions(cmd: Command): Command {
  return cmd
    .option('--limit <n>', 'Max events to return/read', parsePositiveInt, DEFAULT_LIMIT)
    .option('--agent-id <id>', 'Filter by agent id')
    .option('--session-id <id>', 'Filter by session id')
    .option('--family <name>', 'Filter by event family')
    .option('--type <name>', 'Filter by event type')
    .option('--json', 'Output JSON (default)');
}

function eventsPath(): string {
  return join(process.env.PRISMER_HOME ?? join(homedir(), '.prismer'), 'para', 'events.jsonl');
}

function unavailable(file: string): JsonObject {
  return {
    ok: false,
    error: {
      code: 'events_unavailable',
      message: 'Local PARA event log is unavailable because ~/.prismer/para/events.jsonl does not exist.',
    },
    checks: { file, exists: false },
    fix: 'Start a daemon/runtime that writes PARA events, or enable the local PARA event sink so events are appended to ~/.prismer/para/events.jsonl.',
  };
}

async function readEvents(file: string, filters: EventFilters): Promise<LocalEvent[]> {
  const out: LocalEvent[] = [];
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: LocalEvent;
    try {
      event = JSON.parse(trimmed) as LocalEvent;
    } catch {
      continue;
    }
    if (!matches(event, filters)) continue;
    out.push(event);
    if (out.length > filters.limit) out.shift();
  }
  return out.reverse();
}

function matches(event: LocalEvent, filters: EventFilters): boolean {
  if (filters.agentId && field(event, ['agentId', 'agent_id', 'agentID']) !== filters.agentId) return false;
  if (filters.sessionId && field(event, ['sessionId', 'session_id']) !== filters.sessionId) return false;
  if (filters.family && field(event, ['family', 'eventFamily']) !== filters.family) return false;
  if (filters.type && field(event, ['type', 'eventType', 'name']) !== filters.type) return false;
  return true;
}

function field(event: LocalEvent, names: string[]): string | undefined {
  for (const name of names) {
    const value = event[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function summarize(events: LocalEvent[]): JsonObject {
  const byFamily: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byAgentId: Record<string, number> = {};
  const bySessionId: Record<string, number> = {};

  for (const event of events) {
    bump(byFamily, field(event, ['family', 'eventFamily']) ?? 'unknown');
    bump(byType, field(event, ['type', 'eventType', 'name']) ?? 'unknown');
    const agentId = field(event, ['agentId', 'agent_id', 'agentID']);
    const sessionId = field(event, ['sessionId', 'session_id']);
    if (agentId) bump(byAgentId, agentId);
    if (sessionId) bump(bySessionId, sessionId);
  }

  return { total: events.length, byFamily, byType, byAgentId, bySessionId };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function normalizeFilters(opts: EventFilters): EventFilters {
  return {
    limit: Math.max(1, Math.min(10_000, Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT)),
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    family: opts.family,
    type: opts.type,
  };
}

function cleanFilters(filters: EventFilters): JsonObject {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

function parsePositiveInt(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}
