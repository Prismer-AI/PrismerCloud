// runtime210/09 §3.1b (C3c ruling, Path B) — pi text delta stream production
// contract. The §3.1a spike measured both candidate channels (progress vs
// steps); the ruling kept Path B: pi-native text_delta/thinking_delta frames
// ride the steps channel as `text_delta` steps, batched 500ms like
// reasoning_chunk, with the progress channel reserved for turn/tool
// heartbeats. This suite pins the production shape end to end:
//
//   pi-agent-core + pi-ai faux provider (REAL delta source)
//     → PiAgentCoreClient → RuntimeAgentEngine adapter (textDeltaChannel
//       'steps' + progressHeartbeat — the pi-core opt-ins)
//     → CodeAgentDriver.forwardEvent → StepRecorder (real batcher + wire)
//
//   - batching collapses the raw delta storm (wire frames < raw deltas)
//   - batched frames concatenate to the full body in seq order (flush tail)
//   - thinking deltas carry deltaKind='thinking'
//   - default channel 'off': engines without the pi-core opt-in forward zero
//     delta frames (existing hermes/coding behaviour unchanged)
//   - turn/tool heartbeats carry a legal placeholder progress, never stream
//     text (no per-delta progress frames)
//   - the settled assistant message is still recorded after the stream

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile, StepRecorderHandle } from "../src/adapters/contract.js";
import { CodeAgentDriver } from "../src/adapters/coding/shared/code-agent-driver.js";
import { createPiCoreAdapter } from "../src/adapters/runtime-engine/pi-core/index.js";
import { PiAgentCoreClient } from "../src/adapters/runtime-engine/pi-core/agent.js";
import { StepRecorder } from "../src/daemon/step-recorder.js";

interface WireFrame {
  kind: string;
  text: string;
  deltaKind: string;
  seq: number;
}

interface ProgressFrame {
  progress: number;
  message: string;
  detail: Record<string, unknown>;
}

function makeProfile(cwd: string): AgentProfile {
  return {
    id: "profile-pi-stream",
    workspaceId: "ws-pi-stream",
    agentImUserId: "agent-pi-stream",
    adapterName: "pi-core",
    name: "Pi Core",
    config: { cwd, systemPrompt: "You are a focused test agent." },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("runtime210/09 §3.1b — pi text delta stream (Path B production contract)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFaux(models: ReturnType<typeof createModels>, tokensPerSecond = 0) {
    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core Model" }],
      tokensPerSecond,
    });
    models.setProvider(faux.provider);
    return faux;
  }

  interface Harness {
    rawDeltas: { text: string; deltaKind: string }[];
    wireFrames: WireFrame[];
    progressFrames: ProgressFrame[];
  }

  /** Real production path: adapter facade (pi-core opt-ins) → real StepRecorder. */
  async function runThroughAdapter(opts: {
    tokensPerSecond?: number;
    textLength?: number;
    thinkingLength?: number;
    withToolTurn?: boolean;
  }): Promise<Harness & { output: string | undefined }> {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-stream-"));
    tempDirs.push(cwd);
    const models = createModels();
    const faux = makeFaux(models, opts.tokensPerSecond ?? 0);
    const adapter = createPiCoreAdapter({
      models,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
    });

    const body = "A".repeat(opts.textLength ?? 600);
    if (opts.withToolTurn) {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt" }, { id: "read-1" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(
          opts.thinkingLength
            ? [fauxThinking("T".repeat(opts.thinkingLength)), fauxText(body)]
            : fauxText(body),
        ),
      ]);
    } else {
      faux.setResponses([
        fauxAssistantMessage(
          opts.thinkingLength
            ? [fauxThinking("T".repeat(opts.thinkingLength)), fauxText(body)]
            : fauxText(body),
        ),
      ]);
    }

    const rawDeltas: Harness["rawDeltas"] = [];
    const wireFrames: Harness["wireFrames"] = [];
    const stepRecorder = new StepRecorder({
      ws: {
        isOpen: () => true,
        send: (msg) => {
          const step = (msg as { payload?: { step?: { kind?: string; seq?: number; payload?: Record<string, unknown> } } })
            .payload?.step;
          if (!step || step.kind !== "text_delta") return;
          wireFrames.push({
            kind: step.kind,
            seq: step.seq ?? 0,
            text: typeof step.payload?.text === "string" ? step.payload.text : "",
            deltaKind: typeof step.payload?.deltaKind === "string" ? step.payload.deltaKind : "",
          });
        },
      },
      taskRunId: "run_pi_stream",
    });
    // Mirrors dispatch.ts: the recorder shim is a thin passthrough; the raw
    // capture lets the test count the un-batched delta storm.
    const recorder: StepRecorderHandle = {
      recordPhaseChange: () => undefined,
      recordToolCall: () => undefined,
      recordToolResult: () => undefined,
      recordReasoningChunk: () => undefined,
      recordError: () => undefined,
      recordTextDelta: (text, o) => {
        rawDeltas.push({ text, deltaKind: o?.deltaKind ?? "" });
        stepRecorder.recordTextDelta(text, o);
      },
    };

    const progressFrames: Harness["progressFrames"] = [];
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await service.dispatch({
      taskId: "run_pi_stream",
      kind: "run",
      prompt: "Stream a long response.",
      metadata: { conversationId: "conv-pi-stream", agentImUserId: "agent-pi-stream" },
      recorder,
      onProgress: (p) => {
        progressFrames.push({
          progress: p.progress,
          message: p.message ?? "",
          detail: (p.detail ?? {}) as Record<string, unknown>,
        });
      },
    });
    // Mirror dispatch.ts finally: the recorder is flushed on teardown so a
    // short turn still emits its trailing batch.
    stepRecorder.flush();
    await service.shutdown?.();
    return { rawDeltas, wireFrames, progressFrames, output: result.output };
  }

  it("pi-core opts into the steps channel: deltas reach the recorder as batched text_delta steps", async () => {
    // 40tps × 1200 chars paced ~8s of real sleeps; 300 chars keeps the same
    // streaming shape (≥5 deltas, ≥2 500ms batches) in ~2s.
    const textLength = 300;
    const r = await runThroughAdapter({ tokensPerSecond: 40, textLength });
    expect(r.output).toBe("A".repeat(textLength));
    expect(r.rawDeltas.length).toBeGreaterThanOrEqual(5);
    expect(r.wireFrames.length).toBeGreaterThan(0);
    // Batching must collapse the delta storm (the 500ms window joins many
    // deltas into one frame) — the Path B ruling's whole point.
    expect(r.wireFrames.length).toBeLessThan(r.rawDeltas.length);
    for (const frame of r.wireFrames) {
      expect(frame.kind).toBe("text_delta");
      expect(frame.text.length).toBeGreaterThan(0);
    }
  });

  it("batched frames concatenate to the full streamed body in seq order (flush tail included)", async () => {
    const r = await runThroughAdapter({ tokensPerSecond: 0, textLength: 600 });
    const joined = [...r.wireFrames]
      .sort((a, b) => a.seq - b.seq)
      .map((f) => f.text)
      .join("");
    expect(joined).toBe("A".repeat(600));
    expect(r.wireFrames.map((f) => f.seq)).toEqual(
      [...r.wireFrames.map((f) => f.seq)].sort((a, b) => a - b),
    );
  });

  it("thinking deltas arrive with deltaKind='thinking' on the steps channel", async () => {
    const r = await runThroughAdapter({ textLength: 300, thinkingLength: 200 });
    expect(r.rawDeltas.some((d) => d.deltaKind === "thinking")).toBe(true);
    expect(r.rawDeltas.some((d) => d.deltaKind === "text")).toBe(true);
    // The first batch starts with the thinking deltas (pi streams them first).
    expect(r.wireFrames[0]?.deltaKind).toBe("thinking");
  });

  it("default channel 'off': engines without the pi-core opt-in forward zero delta frames", async () => {
    // Driver constructed WITHOUT the pi-core opt-ins — the hermes/coding
    // behaviour baseline: no text_delta forwarding, no progress heartbeat.
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-off-"));
    tempDirs.push(cwd);
    const models = createModels();
    const faux = makeFaux(models);
    const client = new PiAgentCoreClient({ models, defaultProvider: "faux", defaultModelId: "faux-1" });
    const driver = new CodeAgentDriver(client, { cwd });
    faux.setResponses([fauxAssistantMessage("A".repeat(300))]);

    let recordTextDeltaCalls = 0;
    let progressCalls = 0;
    const result = await driver.dispatch({
      taskId: "run_pi_off",
      kind: "run",
      prompt: "Stream.",
      metadata: { conversationId: "conv-pi-off", agentImUserId: "agent-pi-off" },
      recorder: {
        recordPhaseChange: () => undefined,
        recordToolCall: () => undefined,
        recordToolResult: () => undefined,
        recordReasoningChunk: () => undefined,
        recordError: () => undefined,
        recordTextDelta: () => {
          recordTextDeltaCalls++;
        },
      },
      onProgress: () => {
        progressCalls++;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("A".repeat(300));
    expect(recordTextDeltaCalls).toBe(0);
    expect(progressCalls).toBe(0);
    await driver.shutdown();
  });

  it("heartbeat: turn + tool events emit onProgress with a legal placeholder progress", async () => {
    const r = await runThroughAdapter({ withToolTurn: true, textLength: 200 });
    expect(r.progressFrames.length).toBeGreaterThanOrEqual(2);
    const turnFrame = r.progressFrames.find((f) => f.detail.event === "turn_started");
    const toolFrame = r.progressFrames.find((f) => f.detail.event === "tool_call.running");
    expect(turnFrame).toBeDefined();
    expect(toolFrame).toBeDefined();
    // Legal placeholder semantics: a finite monotonic ratio in [0.05, 0.95]
    // — the dispatcher owns 1.0. Normalized to the SAME 0..1 progress contract
    // the rest of the daemon uses (hermes sessions-sse 0.01–0.99 clamp,
    // dispatch retry 0.05), never the legacy 5..95 scale, and never the
    // spike's fixed 0.5 wart.
    let last = 0;
    for (const frame of r.progressFrames) {
      expect(Number.isFinite(frame.progress)).toBe(true);
      expect(frame.progress).toBeGreaterThanOrEqual(0.05);
      expect(frame.progress).toBeLessThan(1);
      expect(frame.progress).toBeGreaterThan(last);
      last = frame.progress;
    }
    expect(r.progressFrames[0]?.progress).toBe(0.05);
    expect(toolFrame?.message).toBe("read");
    expect(toolFrame?.detail.tool).toBe("read");
  });

  it("heartbeat never carries stream text: delta frames do not ride the progress channel", async () => {
    const r = await runThroughAdapter({ textLength: 400 });
    // Every progress frame must be a turn/tool heartbeat — none may carry the
    // streamed text (the C3c ruling: progress keeps heartbeat semantics, the
    // text rides steps only).
    for (const frame of r.progressFrames) {
      expect(frame.detail.delta).toBeUndefined();
      expect(frame.detail.partialText).toBeUndefined();
      expect(frame.detail.text).toBeUndefined();
      expect(typeof frame.detail.kind).toBe("string");
    }
    // A pure text turn emits exactly the turn_started heartbeat (no tool
    // events, no per-delta frames).
    expect(r.progressFrames.length).toBe(1);
    expect(r.progressFrames[0]?.message).toBe("thinking");
  });

  it("the settled assistant message is still recorded after the stream (message_end unchanged)", async () => {
    const r = await runThroughAdapter({ textLength: 250 });
    // The settled reply lands via TaskResult.output — identical to the
    // streamed body — so the persisted message is complete even if a client
    // never renders the incremental stream.
    expect(r.output).toBe("A".repeat(250));
  });
});
