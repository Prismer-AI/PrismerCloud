/**
 * sink.test.ts — Unit tests for src/para/sink.ts
 *
 * Verifies that:
 * - defaultJsonlSink appends valid PARA events as JSONL lines
 * - PRISMER_PARA_STDOUT=1 also writes to stdout
 * - stableAdapterId produces a deterministic hex string
 * - buildAgentDescriptor returns a valid AgentDescriptor shape
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Mock node:fs so we don't write to the real filesystem
// ---------------------------------------------------------------------------
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

import {
  defaultJsonlSink,
  stableAdapterId,
  buildAgentDescriptor,
  PARA_DIR,
} from "../../src/para/sink.js";
import type { ParaEvent } from "@prismer/wire";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionStartedEvent(): ParaEvent {
  return {
    type: "agent.session.started",
    sessionId: "test-session-id",
    scope: "/workspace",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stableAdapterId", () => {
  it("returns <adapter>-<16-hex> format per PARA spec §4.3", () => {
    const id = stableAdapterId("/workspace");
    expect(id).toMatch(/^openclaw-[0-9a-f]{16}$/);
  });

  it("different adapter names produce different IDs even with same workspace", () => {
    const openclawId = stableAdapterId("/workspace", "openclaw");
    const ccId = stableAdapterId("/workspace", "claude-code");
    expect(openclawId).not.toBe(ccId);
    expect(openclawId.startsWith("openclaw-")).toBe(true);
    expect(ccId.startsWith("claude-code-")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = stableAdapterId("/workspace");
    const b = stableAdapterId("/workspace");
    expect(a).toBe(b);
  });

  it("differs for different workspaces", () => {
    const a = stableAdapterId("/workspace-a");
    const b = stableAdapterId("/workspace-b");
    expect(a).not.toBe(b);
  });
});

describe("buildAgentDescriptor", () => {
  it("returns correct adapter field", () => {
    const desc = buildAgentDescriptor("2026.4.14");
    expect(desc.adapter).toBe("openclaw");
  });

  it("returns tiersSupported [1, 2]", () => {
    const desc = buildAgentDescriptor("2026.4.14");
    expect(desc.tiersSupported).toEqual([1, 2]);
  });

  it("includes required capabilityTags", () => {
    const desc = buildAgentDescriptor("2026.4.14");
    expect(desc.capabilityTags).toContain("message");
    expect(desc.capabilityTags).toContain("channel");
  });

  it("sets version from parameter", () => {
    const desc = buildAgentDescriptor("2026.4.14");
    expect(desc.version).toBe("2026.4.14");
  });

  it("id matches <openclaw>-<16-hex> format (PARA §4.3)", () => {
    const desc = buildAgentDescriptor("2026.4.14");
    expect(desc.id).toMatch(/^openclaw-[0-9a-f]{16}$/);
  });

  it("workspace is a string", () => {
    const desc = buildAgentDescriptor("2026.4.14");
    expect(typeof desc.workspace).toBe("string");
  });
});

describe("defaultJsonlSink", () => {
  const appendMock = vi.mocked(fs.appendFileSync);
  const mkdirMock = vi.mocked(fs.mkdirSync);

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PRISMER_PARA_STDOUT;
  });

  afterEach(() => {
    delete process.env.PRISMER_PARA_STDOUT;
  });

  it("calls mkdirSync with PARA_DIR and recursive: true", () => {
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    expect(mkdirMock).toHaveBeenCalledWith(PARA_DIR, { recursive: true, mode: 0o700 });
  });

  it("calls appendFileSync with the events file path", () => {
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    expect(appendMock).toHaveBeenCalledTimes(1);
    const [filePath] = appendMock.mock.calls[0] as [string, string, string];
    expect(filePath).toContain("events.jsonl");
    expect(filePath).toContain(".prismer");
  });

  it("writes a valid JSON line (ending with newline)", () => {
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    const [, line] = appendMock.mock.calls[0] as [string, string, string];
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    // Must be valid JSON
    expect(() => JSON.parse(line.trim())).not.toThrow();
  });

  it("emitted JSON contains the event type", () => {
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    const [, line] = appendMock.mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(line.trim());
    expect(parsed.type).toBe("agent.session.started");
  });

  it("emitted JSON contains _ts timestamp", () => {
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    const [, line] = appendMock.mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(line.trim());
    expect(typeof parsed._ts).toBe("number");
    expect(parsed._ts).toBeGreaterThan(0);
  });

  it("writes to stdout when PRISMER_PARA_STDOUT=1", () => {
    process.env.PRISMER_PARA_STDOUT = "1";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    expect(line.endsWith("\n")).toBe(true);
    writeSpy.mockRestore();
  });

  it("does NOT write to stdout when PRISMER_PARA_STDOUT is unset", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const evt = makeSessionStartedEvent();
    defaultJsonlSink(evt);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("does not throw if appendFileSync fails (non-fatal write error)", () => {
    appendMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const evt = makeSessionStartedEvent();
    // Should not throw — write errors are swallowed
    expect(() => defaultJsonlSink(evt)).not.toThrow();
  });
});
