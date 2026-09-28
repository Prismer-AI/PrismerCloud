// WS-B (PP-1) — persistence shim for the lifted Paseo engine.
//
// Paseo's `agent-manager` (the session-lifecycle registry, NOT yet ported in
// this step) expects two persistence collaborators:
//   - `AgentTimelineStore` (agent-timeline-store-types.ts) — the per-agent
//     committed timeline (user/assistant/reasoning/tool_call rows) backing
//     streamHistory()/resume.
//   - `AgentStorage` — the session-config registry (which agents exist, their
//     AgentSessionConfig + persistence handle).
//
// The WS-B `CodeAgentDriver` bridge (code-agent-driver.ts) holds its own
// `Map<sessionKey, AgentSession>` and drives provider clients directly, so it
// does NOT consume these stores. They exist so that when `agent-manager` is
// ported in a later workstream the storage seam is already defined and
// swappable.
//
// ▶ IMPLEMENTATION CHOICE: IN-MEMORY (per-process, non-durable).
//   Wiring the daemon's local SQLite (`local.db`, see daemon/memory/store.ts)
//   would be premature for this step — no consumer in WS-B exercises these
//   stores, so a real schema would be speculative (CLAUDE.md "Simplicity
//   First"). `local.db` is explicitly a rebuildable cache (per the agent-rt
//   ephemeral-emptyDir constraint), so the timeline can always be re-pulled
//   from cloud outbox; an in-memory store is a correct local-first default.
//   Both impls are constructed via the factory functions below, so swapping to
//   a SQLite-backed impl later is a single call-site change.
//
// See docs/release203/08-paseo-port-unified-agent-engine.md §7.6 ⑤, §7.7 WS-B.

import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "../agent-timeline-store-types.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const MODULE = "[PaseoPersistence]";

// ───────────────────────────────────────────────────────────
// AgentStorage — session-config registry (agent-manager consumes this).
// Defined here because B1 left it type-only / unported; minimal surface only.
// ───────────────────────────────────────────────────────────

export interface StoredAgentRecord {
  agentId: string;
  provider: AgentProvider;
  config: AgentSessionConfig;
  persistence: AgentPersistenceHandle | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStorage {
  put(record: StoredAgentRecord): Promise<void>;
  get(agentId: string): Promise<StoredAgentRecord | null>;
  list(): Promise<StoredAgentRecord[]>;
  delete(agentId: string): Promise<void>;
  setPersistence(agentId: string, handle: AgentPersistenceHandle | null): Promise<void>;
}

// ───────────────────────────────────────────────────────────
// In-memory AgentTimelineStore.
// ───────────────────────────────────────────────────────────

const DEFAULT_EPOCH = "0";

class InMemoryAgentTimelineStore implements AgentTimelineStore {
  // agentId → ordered committed rows (seq is 1-based, contiguous).
  private rows = new Map<string, AgentTimelineRow[]>();

  private forAgent(agentId: string): AgentTimelineRow[] {
    let list = this.rows.get(agentId);
    if (!list) {
      list = [];
      this.rows.set(agentId, list);
    }
    return list;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    const list = this.forAgent(agentId);
    const row: AgentTimelineRow = {
      seq: list.length + 1,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
    };
    list.push(row);
    return row;
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const list = this.forAgent(agentId);
    const direction = options?.direction ?? "tail";
    const limit = options?.limit;
    const cursorSeq = options?.cursor?.seq;

    let selected: AgentTimelineRow[];
    if (direction === "before" && cursorSeq != null) {
      selected = list.filter((r) => r.seq < cursorSeq);
      if (limit && limit > 0) selected = selected.slice(-limit);
    } else if (direction === "after" && cursorSeq != null) {
      selected = list.filter((r) => r.seq > cursorSeq);
      if (limit && limit > 0) selected = selected.slice(0, limit);
    } else {
      // tail
      selected = limit && limit > 0 ? list.slice(-limit) : list.slice();
    }

    const minSeq = list.length ? list[0]!.seq : 0;
    const maxSeq = list.length ? list[list.length - 1]!.seq : 0;
    const firstSel = selected.length ? selected[0]!.seq : maxSeq;
    const lastSel = selected.length ? selected[selected.length - 1]!.seq : maxSeq;

    return {
      epoch: DEFAULT_EPOCH,
      direction,
      reset: false,
      // Cursor is stale only if it referenced an epoch we no longer hold; we
      // never roll epochs in-memory, so always false here.
      staleCursor: false,
      gap: false,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      hasOlder: firstSel > minSeq,
      hasNewer: lastSel < maxSeq,
      rows: selected,
    };
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const list = this.rows.get(agentId);
    return list && list.length ? list[list.length - 1]!.seq : 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return this.forAgent(agentId).slice();
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const list = this.rows.get(agentId);
    return list && list.length ? list[list.length - 1]!.item : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const list = this.rows.get(agentId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]!.item;
      if (item.type === "assistant_message") return item.text;
    }
    return null;
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.rows.delete(agentId);
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    // Replace wholesale — bulkInsert is used to re-hydrate a fresh agent from
    // canonical cloud rows. Preserve the provided seq ordering.
    this.rows.set(agentId, [...rows].sort((a, b) => a.seq - b.seq));
    console.log(`${MODULE} bulkInsert agent=${agentId} rows=${rows.length}`);
  }
}

// ───────────────────────────────────────────────────────────
// In-memory AgentStorage.
// ───────────────────────────────────────────────────────────

class InMemoryAgentStorage implements AgentStorage {
  private records = new Map<string, StoredAgentRecord>();

  async put(record: StoredAgentRecord): Promise<void> {
    this.records.set(record.agentId, { ...record });
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async list(): Promise<StoredAgentRecord[]> {
    return [...this.records.values()];
  }

  async delete(agentId: string): Promise<void> {
    this.records.delete(agentId);
  }

  async setPersistence(
    agentId: string,
    handle: AgentPersistenceHandle | null,
  ): Promise<void> {
    const rec = this.records.get(agentId);
    if (!rec) return;
    rec.persistence = handle;
    rec.updatedAt = new Date().toISOString();
  }
}

// ───────────────────────────────────────────────────────────
// Factories — single swap point for a future SQLite-backed impl.
// ───────────────────────────────────────────────────────────

export function createInMemoryTimelineStore(): AgentTimelineStore {
  return new InMemoryAgentTimelineStore();
}

export function createInMemoryAgentStorage(): AgentStorage {
  return new InMemoryAgentStorage();
}
