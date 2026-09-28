// WS-C — StepRecorder structured-detail / altitude / status / spill tests.

import { describe, it, expect, vi } from "vitest";
import { StepRecorder, altitudeForDetail } from "../src/daemon/step-recorder.js";
import type { StepFrame } from "../src/daemon/step-recorder.js";
import type { ToolCallDetail } from "../src/adapters/coding/engine/agent-sdk-types.js";
import type { AssetRef } from "../src/types/im-events.js";

function makeRecorder(extra: Partial<ConstructorParameters<typeof StepRecorder>[0]> = {}) {
  const frames: StepFrame[] = [];
  const ws = { send: vi.fn(), isOpen: () => true };
  const recorder = new StepRecorder({
    ws,
    taskRunId: "run-1",
    onSend: (f) => frames.push(f),
    ...extra,
  });
  return { recorder, frames };
}

describe("StepRecorder WS-C", () => {
  it("carries detail + status and derives altitude='action' for code tool details", () => {
    const { recorder, frames } = makeRecorder();
    const detail: ToolCallDetail = { type: "edit", filePath: "a.ts", unifiedDiff: "@@ -1 +1 @@" };
    recorder.recordToolCall("Edit", { file: "a.ts" }, "c-1", { detail, status: "running" });

    const f = frames.at(-1)!;
    expect(f.kind).toBe("tool_call");
    expect(f.payload.detail).toMatchObject({ type: "edit", filePath: "a.ts" });
    expect(f.payload.status).toBe("running");
    expect(f.payload.altitude).toBe("action");
    // Back-compat: inputSummary still present.
    expect(typeof f.payload.inputSummary).toBe("string");
  });

  it("hermes-style recordToolCall (no detail) defaults altitude='milestone' + unchanged shape", () => {
    const { recorder, frames } = makeRecorder();
    recorder.recordToolCall("memory_search", { q: "x" }, "h-1");
    const f = frames.at(-1)!;
    expect(f.payload.altitude).toBe("milestone");
    expect(f.payload.detail).toBeUndefined();
    expect(f.payload).toMatchObject({ toolName: "memory_search", toolCallId: "h-1" });
  });

  it("recordPhaseChange / recordTodo / recordUsage are milestones", () => {
    const { recorder, frames } = makeRecorder();
    recorder.recordPhaseChange("thinking");
    recorder.recordTodo([{ text: "do", completed: false }]);
    recorder.recordUsage({ inputTokens: 10, outputTokens: 5 });
    expect(frames.map((f) => f.payload.altitude)).toEqual(["milestone", "milestone", "milestone"]);
    expect(frames[1].kind).toBe("todo");
    expect(frames[2].kind).toBe("usage");
    expect(frames[2].payload.usage).toMatchObject({ inputTokens: 10 });
  });

  it("inline-caps large detail bodies with truncated flag when no spill hook", () => {
    const { recorder, frames } = makeRecorder();
    const big = "x".repeat(20_000);
    const detail: ToolCallDetail = { type: "shell", command: "cat big", output: big };
    recorder.recordToolResult("c-2", "ok", { detail, status: "completed" });
    const d = frames.at(-1)!.payload.detail as Record<string, unknown>;
    expect((d.output as string).length).toBeLessThan(big.length);
    expect(d.outputTruncated).toBe(true);
    expect(d.outputSpill).toBeUndefined();
  });

  it("spills oversized detail body to an AssetRef when spill hook is provided", () => {
    const ref: AssetRef = {
      assetId: "asset-1",
      contentHash: "h",
      mime: "text/plain",
      sizeBytes: 20_000,
      kind: "step-spill",
      workspaceId: "w-1",
      role: "attachment",
    };
    const assetSpill = vi.fn().mockReturnValue(ref);
    const { recorder, frames } = makeRecorder({ assetSpill });
    const big = "y".repeat(20_000);
    const detail: ToolCallDetail = { type: "write", filePath: "out.txt", content: big };
    recorder.recordToolCall("Write", {}, "c-3", { detail });

    expect(assetSpill).toHaveBeenCalledWith(
      expect.objectContaining({ taskRunId: "run-1", field: "content", seq: 1 }),
    );
    const d = frames.at(-1)!.payload.detail as Record<string, unknown>;
    expect(d.contentSpill).toEqual(ref);
    expect(d.contentTruncated).toBe(true);
  });

  it("altitudeForDetail: action set vs milestone fallback", () => {
    expect(altitudeForDetail({ type: "shell", command: "x" })).toBe("action");
    expect(altitudeForDetail({ type: "plan", text: "p" })).toBe("milestone");
    expect(altitudeForDetail({ type: "sub_agent", log: "" })).toBe("milestone");
    expect(altitudeForDetail(undefined)).toBe("milestone");
  });
});
