// S5 §3.4-1b (docs/organization/specs/05 Task 2) — narrow daemon→cloud IO seam.
//
// The hermes adapter needs two cloud calls that are NOT part of the daemon wire
// protocol:
//   • read a conversation's recent IM rows — to find the anchor (`metadata.taskId`)
//     of OUR last agent_reply, which is what the transcript reconciliation
//     compares the hermes transcript against;
//   • post a `system_event` visibility row — the only channel that reaches the
//     human timeline without polluting the model context (all three consumers
//     strip it: envelope recent / compaction L2 / channel-outbound).
//
// Wiring the authenticated CloudClient into the adapter directly would invert
// the dependency (the adapter is statically imported by the daemon, not owned
// by it). Instead this follows the `setHermesSessionMapper` precedent
// (sessions-mapper.ts:245): runner.ts, which already owns an authenticated
// CloudClient, installs the implementation at boot and clears it in shutdown.
// With the seam unwired (unit tests, standalone adapter use) every consumer
// degrades to a silent no-op — the adapter never hard-depends on cloud.

export interface HermesCloudMessageRow {
  id: string;
  senderId: string;
  type: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface HermesCloudIO {
  /** `GET /api/im/messages/{conversationId}?limit=N` — newest-last tail. */
  readRecentMessages(conversationId: string, limit: number): Promise<HermesCloudMessageRow[]>;
  /** `POST /api/im/messages/{conversationId}` with `type='system_event'`. */
  postSystemEvent(
    conversationId: string,
    content: string,
    meta: Record<string, unknown>,
  ): Promise<void>;
}

let SINGLETON: HermesCloudIO | null = null;

export function setHermesCloudIO(io: HermesCloudIO | null): void {
  SINGLETON = io;
}

export function getHermesCloudIO(): HermesCloudIO | null {
  return SINGLETON;
}
