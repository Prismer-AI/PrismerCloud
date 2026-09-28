// pi-core-fs-capability.test.ts — full filesystem-capability regression for the
// pi-core runtime-engine adapter, exercised through the REAL runtime dispatch
// path (AdapterDef.ensureService → RuntimeAgentEngineDriver → CodeAgentDriver →
// PiAgentCoreSession) driven by the faux model provider — no gateway credentials.
//
// Oracle discipline: every claim is backed by a side effect — FS terminal
// state, recorder calls, or structured TaskResult fields. Chat text is never
// the sole evidence.
//
// Coverage matrix (see each `it`):
//  1. happy-path tool matrix: write new / write overwrite / read / edit
//  2. multi-turn FS task (read A + read B → write C → edit A → final reply)
//  3. jail negative matrix: read escape / edit escape / absolute-path write
//     escape (the `../` write escape is already covered in
//     pi-core-adapter.test.ts and is deliberately NOT duplicated here)
//  4. deny surface: unbound tool names (bash / createTempFile) refused
//  5. abort: deterministic slow stream + task.signal → canceled result, no
//     in-flight residue
//  6. error path: injected throwing Models.streamSimple + scripted faux error
//  7. usage evidence: faux estimated usage → recordUsage + result.metrics
//  8. reasoning timeline: faux thinking block → recordReasoningChunk
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { Api, Context, Model, Models, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterService, AgentProfile, StepRecorderHandle } from "../src/adapters/contract.js";
import { createPiCoreAdapter } from "../src/adapters/runtime-engine/pi-core/index.js";

function makeProfile(cwd: string): AgentProfile {
  return {
    id: "profile-pi-fs",
    workspaceId: "ws-pi-fs",
    agentImUserId: "agent-pi",
    adapterName: "pi-core",
    name: "Pi Core FS",
    config: {
      cwd,
      model: "faux/faux-1",
      systemPrompt: "You are a focused test agent.",
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

type MockRecorder = StepRecorderHandle & {
  recordToolCall: ReturnType<typeof vi.fn>;
  recordToolResult: ReturnType<typeof vi.fn>;
  recordReasoningChunk: ReturnType<typeof vi.fn>;
  recordError: ReturnType<typeof vi.fn>;
  recordUsage: ReturnType<typeof vi.fn>;
  recordTodo: ReturnType<typeof vi.fn>;
};

function makeRecorder(): MockRecorder {
  return {
    recordPhaseChange: vi.fn(),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordReasoningChunk: vi.fn(),
    recordError: vi.fn(),
    recordTodo: vi.fn(),
    recordUsage: vi.fn(),
  };
}

/** Text payload of the most recent toolResult message with the given toolCallId. */
function toolResultTextById(context: Context, toolCallId: string): string {
  const message = [...context.messages]
    .reverse()
    .find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === toolCallId);
  if (!message) return "";
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** All toolResult messages in the context, reduced to {toolName, text}. */
function toolResultTexts(context: Context): Array<{ toolName: string; text: string }> {
  return context.messages
    .filter((m): m is ToolResultMessage => m.role === "toolResult")
    .map((m) => ({
      toolName: m.toolName,
      text: m.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    }));
}

describe("pi-core filesystem capability through the runtime dispatch path", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHarness(options?: { tokensPerSecond?: number }) {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-fs-"));
    tempDirs.push(cwd);

    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core Model" }],
      tokensPerSecond: options?.tokensPerSecond ?? 0,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const adapter = createPiCoreAdapter({
      models,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
    });
    return { adapter, faux, cwd };
  }

  async function dispatchRun(
    service: AdapterService,
    taskId: string,
    prompt: string,
    conversationId: string,
    recorder?: ReturnType<typeof makeRecorder>,
  ) {
    return service.dispatch({
      taskId,
      kind: "run",
      prompt,
      metadata: { conversationId, agentImUserId: "agent-pi" },
      ...(recorder ? { recorder } : {}),
    });
  }

  // ── 1. happy-path tool matrix ───────────────────────────────────────────

  it("write tool creates a new file (FS + recorder running→completed + write detail)", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const target = join(cwd, "out", "new.txt");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "out/new.txt", content: "NEW_FILE_OK" }, { id: "w-new" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("WRITE_NEW_DONE"),
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_write_new", "Write out/new.txt.", "conv-pi-write-new", recorder);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("WRITE_NEW_DONE");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("NEW_FILE_OK");
    expect(recorder.recordToolCall).toHaveBeenCalledWith(
      "write",
      { type: "write", filePath: "out/new.txt", content: "NEW_FILE_OK" },
      "w-new",
      {
        detail: { type: "write", filePath: "out/new.txt", content: "NEW_FILE_OK" },
        status: "running",
      },
    );
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "w-new",
      { type: "write", filePath: "out/new.txt", content: "NEW_FILE_OK" },
      {
        detail: { type: "write", filePath: "out/new.txt", content: "NEW_FILE_OK" },
        status: "completed",
      },
    );
    await service.shutdown?.();
  });

  it("write tool overwrites an existing file", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const target = join(cwd, "overwrite.txt");
    writeFileSync(target, "STALE_CONTENT");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "overwrite.txt", content: "FRESH_CONTENT" }, { id: "w-over" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("WRITE_OVER_DONE"),
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_write_over", "Overwrite overwrite.txt.", "conv-pi-write-over", recorder);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("WRITE_OVER_DONE");
    expect(readFileSync(target, "utf8")).toBe("FRESH_CONTENT");
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "w-over",
      { type: "write", filePath: "overwrite.txt", content: "FRESH_CONTENT" },
      {
        detail: { type: "write", filePath: "overwrite.txt", content: "FRESH_CONTENT" },
        status: "completed",
      },
    );
    await service.shutdown?.();
  });

  it("read tool returns file text (read detail carries the content)", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const target = join(cwd, "notes.txt");
    writeFileSync(target, "READ_ME_OK\nsecond line\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }, { id: "r-txt" }), { stopReason: "toolUse" }),
      (context) => fauxAssistantMessage(`READ_DONE ${toolResultTextById(context, "r-txt")}`),
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_read", "Read notes.txt.", "conv-pi-read", recorder);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("READ_DONE READ_ME_OK\nsecond line\n");
    expect(readFileSync(target, "utf8")).toBe("READ_ME_OK\nsecond line\n");
    expect(recorder.recordToolCall).toHaveBeenCalledWith(
      "read",
      { type: "read", filePath: "notes.txt" },
      "r-txt",
      { detail: { type: "read", filePath: "notes.txt" }, status: "running" },
    );
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "r-txt",
      { type: "read", filePath: "notes.txt", content: "READ_ME_OK\nsecond line\n" },
      {
        detail: { type: "read", filePath: "notes.txt", content: "READ_ME_OK\nsecond line\n" },
        status: "completed",
      },
    );
    await service.shutdown?.();
  });

  it("edit tool applies a unified diff (FS + edit detail with unifiedDiff)", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const target = join(cwd, "doc.txt");
    writeFileSync(target, "line1\nTOK_OLD\nline3\n");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "edit",
          { path: "doc.txt", edits: [{ oldText: "TOK_OLD", newText: "TOK_NEW" }] },
          { id: "e-diff" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("EDIT_DONE"),
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_edit", "Replace TOK_OLD in doc.txt.", "conv-pi-edit", recorder);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("EDIT_DONE");
    expect(readFileSync(target, "utf8")).toBe("line1\nTOK_NEW\nline3\n");
    expect(recorder.recordToolCall).toHaveBeenCalledWith(
      "edit",
      { type: "edit", filePath: "doc.txt" },
      "e-diff",
      { detail: { type: "edit", filePath: "doc.txt" }, status: "running" },
    );
    const editResultCall = recorder.recordToolResult.mock.calls.find((c: unknown[]) => c[0] === "e-diff");
    expect(editResultCall).toBeDefined();
    const editDetail = editResultCall![1] as { type: string; filePath: string; unifiedDiff?: string };
    expect(editDetail.type).toBe("edit");
    expect(editDetail.filePath).toBe("doc.txt");
    expect(editDetail.unifiedDiff).toContain("-TOK_OLD");
    expect(editDetail.unifiedDiff).toContain("+TOK_NEW");
    const editOpts = editResultCall![2] as { detail: unknown; status?: string };
    expect(editOpts.status).toBe("completed");
    expect(editOpts.detail).toEqual(editDetail);
    await service.shutdown?.();
  });

  // ── 2. multi-turn FS task ──────────────────────────────────────────────

  it("multi-turn FS task: read A + read B → write C → edit A → final reply references C and edited A", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const aPath = "data/a.txt";
    const bPath = "data/b.txt";
    const cPath = "data/c.txt";
    mkdirSync(join(cwd, "data"), { recursive: true });
    writeFileSync(join(cwd, aPath), "A_INIT\n");
    writeFileSync(join(cwd, bPath), "B_INIT\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: aPath }, { id: "mt-read-a" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: bPath }, { id: "mt-read-b" }), { stopReason: "toolUse" }),
      (context) => {
        const a = toolResultTextById(context, "mt-read-a").trim();
        const b = toolResultTextById(context, "mt-read-b").trim();
        return fauxAssistantMessage(
          fauxToolCall("write", { path: cPath, content: `${a}|${b}` }, { id: "mt-write-c" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall(
          "edit",
          { path: aPath, edits: [{ oldText: "A_INIT", newText: "A_EDITED" }] },
          { id: "mt-edit-a" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const a = toolResultTextById(context, "mt-read-a").trim();
        const b = toolResultTextById(context, "mt-read-b").trim();
        return fauxAssistantMessage(`MULTI_DONE C=${a}|${b} A=A_EDITED`);
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(
      service,
      "run_pi_multiturn",
      "Read a and b, write their join to c, then edit a.",
      "conv-pi-multiturn",
      recorder,
    );

    expect(result.ok).toBe(true);
    // The final reply references C's content (derived from the two read tool
    // results — the model could only obtain A_INIT|B_INIT through the read
    // tools) and A's edited state.
    expect(result.output).toBe("MULTI_DONE C=A_INIT|B_INIT A=A_EDITED");
    // FS terminal state: C holds the join of the two reads; A holds the edit.
    expect(readFileSync(join(cwd, cPath), "utf8")).toBe("A_INIT|B_INIT");
    expect(readFileSync(join(cwd, aPath), "utf8")).toBe("A_EDITED\n");
    // Timeline order: read, read, write, edit — every step completed.
    expect(recorder.recordToolCall.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "read",
      "read",
      "write",
      "edit",
    ]);
    expect(recorder.recordToolResult.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "mt-read-a",
      "mt-read-b",
      "mt-write-c",
      "mt-edit-a",
    ]);
    for (const call of recorder.recordToolResult.mock.calls) {
      expect((call[2] as { status?: string }).status).toBe("completed");
    }
    await service.shutdown?.();
  });

  // ── 3. jail negative matrix ────────────────────────────────────────────
  //
  // The `../` write escape is already covered by pi-core-adapter.test.ts
  // ("keeps Pi Core filesystem tools jailed to the runtime cwd") and is
  // deliberately NOT duplicated here. This matrix adds read escape, edit
  // escape, and absolute-path write escape.
  //
  // Gap (reported, not skipped): the read tool has no directory-listing branch
  // (pi-agent-core read.js only reads file bytes), so a `listDir` filter
  // escape is NOT reachable through any bound tool parameter; likewise
  // createTempFile/createTempDir are ExecutionEnv methods, not bound tools
  // (createBoundTools binds read/write/edit only), so they are reachable only
  // via unbound tool names — covered by the deny-surface test below.

  it("jail negative matrix: read/edit/absolute-write escapes fail without touching outside FS", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const outsideBase = join(cwd, "..", `${basename(cwd)}-fs-escape`);
    const secretFile = `${outsideBase}-secret.txt`;
    const editFile = `${outsideBase}-edit.txt`;
    const absWriteFile = `${outsideBase}-abs-write.txt`;
    tempDirs.push(secretFile, editFile, absWriteFile);
    writeFileSync(secretFile, "TOP_SECRET_XYZ\n");
    writeFileSync(editFile, "OUTSIDE_EDIT_OLD\n");
    writeFileSync(absWriteFile, "OUTSIDE_ABS_OLD\n");

    const secretRel = `../${basename(secretFile)}`;
    const editRel = `../${basename(editFile)}`;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: secretRel }, { id: "esc-read" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall(
          "edit",
          { path: editRel, edits: [{ oldText: "OUTSIDE_EDIT_OLD", newText: "OUTSIDE_EDIT_HACKED" }] },
          { id: "esc-edit" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("write", { path: absWriteFile, content: "OUTSIDE_ABS_HACKED" }, { id: "esc-abs-write" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const texts = toolResultTexts(context).map((t) => t.text).join("\n");
        return fauxAssistantMessage(texts.includes("TOP_SECRET_XYZ") ? "JAIL_LEAKED" : "JAIL_DONE");
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(
      service,
      "run_pi_jail",
      "Try to read and modify files outside cwd.",
      "conv-pi-jail",
      recorder,
    );

    expect(result.ok).toBe(true);
    // The model received every failed tool result and still finished; no
    // outside byte leaked into the conversation.
    expect(result.output).toBe("JAIL_DONE");
    // Outside FS untouched by all three attempts.
    expect(readFileSync(secretFile, "utf8")).toBe("TOP_SECRET_XYZ\n");
    expect(readFileSync(editFile, "utf8")).toBe("OUTSIDE_EDIT_OLD\n");
    expect(readFileSync(absWriteFile, "utf8")).toBe("OUTSIDE_ABS_OLD\n");
    // Each escape surfaced as a failed tool result.
    const failedCalls = new Map(
      recorder.recordToolResult.mock.calls.map((c: unknown[]) => [c[0], c] as const),
    );
    const readCall = failedCalls.get("esc-read");
    expect(readCall).toBeDefined();
    expect((readCall![2] as { status?: string }).status).toBe("failed");
    const readDetail = readCall![1] as { type: string; filePath: string; content?: string };
    expect(readDetail.type).toBe("read");
    expect(readDetail.filePath).toBe(secretRel);
    expect(readDetail.content).toContain("jailed");
    expect(readDetail.content).not.toContain("TOP_SECRET_XYZ");
    const editCall = failedCalls.get("esc-edit");
    expect(editCall).toBeDefined();
    expect((editCall![2] as { status?: string }).status).toBe("failed");
    expect((editCall![1] as { type: string }).type).toBe("edit");
    const absWriteCall = failedCalls.get("esc-abs-write");
    expect(absWriteCall).toBeDefined();
    expect((absWriteCall![2] as { status?: string }).status).toBe("failed");
    const absWriteDetail = absWriteCall![1] as { type: string; filePath: string; content?: string };
    expect(absWriteDetail).toEqual({
      type: "write",
      filePath: absWriteFile,
      content: "OUTSIDE_ABS_HACKED",
    });
    await service.shutdown?.();
  });

  it("symlink escape: in-cwd symlink to an outside dir denies read + new-file write + overwrite", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const outsideDir = join(cwd, "..", `${basename(cwd)}-symlink-target`);
    mkdirSync(outsideDir, { recursive: true });
    tempDirs.push(outsideDir);
    const knownFile = join(outsideDir, "known.txt");
    writeFileSync(knownFile, "SYMLINK_SECRET_XYZ\n");
    symlinkSync(outsideDir, join(cwd, "link-out"));

    faux.setResponses([
      // read an existing outside file THROUGH the in-cwd symlink
      fauxAssistantMessage(
        fauxToolCall("read", { path: "link-out/known.txt" }, { id: "sym-read" }),
        { stopReason: "toolUse" },
      ),
      // write a NEW file through the symlink
      fauxAssistantMessage(
        fauxToolCall("write", { path: "link-out/escaped.txt", content: "SYMLINK_WRITE_HACK" }, { id: "sym-write" }),
        { stopReason: "toolUse" },
      ),
      // overwrite the existing outside file through the symlink
      fauxAssistantMessage(
        fauxToolCall("write", { path: "link-out/known.txt", content: "SYMLINK_OVERWRITE_HACK" }, { id: "sym-over" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const texts = toolResultTexts(context).map((t) => t.text).join("\n");
        return fauxAssistantMessage(texts.includes("SYMLINK_SECRET_XYZ") ? "SYMLINK_LEAKED" : "SYMLINK_DONE");
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(
      service,
      "run_pi_symlink",
      "Read and write through the link-out directory.",
      "conv-pi-symlink",
      recorder,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("SYMLINK_DONE");
    // Outside target untouched: no new file, no overwrite, no leaked content.
    expect(existsSync(join(outsideDir, "escaped.txt"))).toBe(false);
    expect(readFileSync(knownFile, "utf8")).toBe("SYMLINK_SECRET_XYZ\n");
    const failedCalls = new Map(
      recorder.recordToolResult.mock.calls.map((c: unknown[]) => [c[0], c] as const),
    );
    for (const id of ["sym-read", "sym-write", "sym-over"]) {
      const call = failedCalls.get(id);
      expect(call, `expected a tool result for ${id}`).toBeDefined();
      expect((call![2] as { status?: string }).status).toBe("failed");
    }
    const readDetail = failedCalls.get("sym-read")![1] as { type: string; filePath: string; content?: string };
    expect(readDetail.type).toBe("read");
    expect(readDetail.filePath).toBe("link-out/known.txt");
    expect(readDetail.content).toContain("jailed");
    expect(readDetail.content).not.toContain("SYMLINK_SECRET_XYZ");
    const writeDetail = failedCalls.get("sym-write")![1] as { type: string; filePath: string; content?: string };
    expect(writeDetail).toEqual({
      type: "write",
      filePath: "link-out/escaped.txt",
      content: "SYMLINK_WRITE_HACK",
    });
    const overDetail = failedCalls.get("sym-over")![1] as { type: string; filePath: string; content?: string };
    expect(overDetail).toEqual({
      type: "write",
      filePath: "link-out/known.txt",
      content: "SYMLINK_OVERWRITE_HACK",
    });
    await service.shutdown?.();
  });

  it("broken-symlink escape: writing through a dangling in-cwd link must not create the target outside", async () => {
    const { adapter, faux, cwd } = makeHarness();
    const outsideTarget = join(cwd, "..", `${basename(cwd)}-broken-link-target.txt`);
    tempDirs.push(outsideTarget);
    // Target does not exist → the link is dangling; existsSync reports false,
    // but an OS write through the link would CREATE the target outside cwd.
    symlinkSync(outsideTarget, join(cwd, "link-dangling"));

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "link-dangling", content: "PI_BROKEN_LINK_HACK" }, { id: "dangle-write" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const text = toolResultTexts(context)
          .map((t) => t.text)
          .join("\n");
        return fauxAssistantMessage(text.includes("PI_BROKEN_LINK_HACK") ? "DANGLE_LEAKED" : "DANGLE_DONE");
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(
      service,
      "run_pi_dangle",
      "Write through the link-dangling link.",
      "conv-pi-dangle",
      recorder,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("DANGLE_DONE");
    expect(existsSync(outsideTarget)).toBe(false);
    const failed = recorder.recordToolResult.mock.calls.find(
      (call: unknown[]) => call[0] === "dangle-write",
    );
    expect(failed, "expected a tool result for dangle-write").toBeDefined();
    expect((failed![2] as { status?: string }).status).toBe("failed");
    await service.shutdown?.();
  });

  // ── 4. deny surface ────────────────────────────────────────────────────

  it("deny surface: unbound bash / createTempFile tool names are refused, model recovers, no FS side effects", async () => {
    const { adapter, faux, cwd } = makeHarness();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "cat /etc/passwd" }, { id: "deny-bash" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("createTempFile", { prefix: "leak" }, { id: "deny-temp" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const texts = toolResultTexts(context).map((t) => t.text).join("\n");
        return fauxAssistantMessage(`DENY_DONE ${texts}`);
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(
      service,
      "run_pi_deny",
      "Run a shell command and create a temp file.",
      "conv-pi-deny",
      recorder,
    );

    expect(result.ok).toBe(true);
    // The model saw the refusal semantics ("Tool <name> not found") and
    // completed its turn.
    expect(result.output).toContain("DENY_DONE");
    expect(result.output).toContain("Tool bash not found");
    expect(result.output).toContain("Tool createTempFile not found");
    // No side effects: the cwd stays empty (no temp file, no command output).
    expect(readdirSync(cwd)).toEqual([]);
    // bash refusal surfaces as a failed shell-typed tool result.
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "deny-bash",
      { type: "shell", command: "cat /etc/passwd", output: "Tool bash not found", exitCode: null },
      {
        detail: { type: "shell", command: "cat /etc/passwd", output: "Tool bash not found", exitCode: null },
        status: "failed",
      },
    );
    // Unknown tool names fall through to the unknown-detail shape.
    expect(recorder.recordToolResult).toHaveBeenCalledWith(
      "deny-temp",
      expect.objectContaining({ type: "unknown", input: { prefix: "leak" } }),
      expect.objectContaining({ status: "failed" }),
    );
    await service.shutdown?.();
  });

  // ── 5. abort ───────────────────────────────────────────────────────────
  //
  // Coverage level: faux's tokensPerSecond delays every streamed chunk via
  // setTimeout, and the agent loop checks the abort signal between chunks —
  // so a long scripted message plus task.signal.abort() deterministically
  // lands mid-stream. This exercises the REAL abort chain: driver onAbort →
  // session.interrupt() → agent.abort() → aborted stream → canceled result.

  it("abort: task.signal cancels a slow stream, returns canceled, leaves no in-flight residue", async () => {
    const { adapter, faux, cwd } = makeHarness({ tokensPerSecond: 20 });
    const service = await adapter.ensureService!(makeProfile(cwd));
    // ~1200 chars → dozens of streamed chunks (~150-250ms each at 20 tps):
    // the stream cannot finish before the abort fires at 700ms.
    faux.setResponses([fauxAssistantMessage("SLOW_TURN_".repeat(120))]);

    const recorder = makeRecorder();
    const controller = new AbortController();
    const pending = service.dispatch({
      taskId: "run_pi_abort",
      kind: "run",
      prompt: "Produce a long, slow response.",
      metadata: { conversationId: "conv-pi-abort", agentImUserId: "agent-pi" },
      signal: controller.signal,
      recorder,
    });
    const signaled = new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 700);
    });
    const result = await Promise.all([pending.then((r) => r), signaled]).then(([r]) => r);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("task_cancelled");
    expect(result.error?.message).toBe("Task cancelled by client");
    expect(result.metadata?.modelUsed).toBe("faux-1");
    expect(result.metadata?.providerUsed).toBe("faux");
    // Abort is not an error path: no recordError, and the scripted response
    // was consumed (nothing pending on the provider).
    expect(recorder.recordError).not.toHaveBeenCalled();
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(faux.state.callCount).toBe(1);

    // No in-flight residue: the same (conversation × agent) session accepts a
    // fresh turn. If the agent still considered a run active, prompt() would
    // throw "Agent is already processing" and this dispatch would fail.
    faux.setResponses([fauxAssistantMessage("POST_ABORT_OK")]);
    const after = await dispatchRun(
      service,
      "run_pi_abort_after",
      "Are you idle?",
      "conv-pi-abort",
    );
    expect(after.ok).toBe(true);
    expect(after.output).toBe("POST_ABORT_OK");
    expect(faux.state.callCount).toBe(2);
    await service.shutdown?.();
  });

  // ── 6. error path ──────────────────────────────────────────────────────

  it("error path: injected throwing Models.streamSimple → failed dispatch + recordError(pi_core_model_error)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-fs-err-"));
    tempDirs.push(cwd);
    const faux: FauxProviderHandle = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core Model" }],
    });
    // Injection seam: a Models collection whose streamSimple throws. Model
    // resolution still works through getModel/getModels so the session is
    // built, and the failure is deterministic (no network, no faux encoding).
    const boomModels = {
      getModel: (_provider: string, id: string) => faux.getModel(id),
      getModels: (_provider?: string) => [faux.getModel("faux-1")] as Model<Api>[],
      streamSimple: () => {
        throw new Error("injected-stream-boom");
      },
    } as unknown as Models;
    const adapter = createPiCoreAdapter({
      models: boomModels,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
    });

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_err_boom", "Say something.", "conv-pi-err-boom", recorder);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("task_cancelled");
    expect(result.error?.message).toContain("Code-agent turn failed: injected-stream-boom");
    expect(recorder.recordError).toHaveBeenCalledWith("injected-stream-boom", { code: "pi_core_model_error" });
    await service.shutdown?.();
  });

  it("error path: scripted faux factory throw → failed dispatch + recordError(pi_core_model_error)", async () => {
    const { adapter, faux, cwd } = makeHarness();
    faux.setResponses([
      () => {
        throw new Error("scripted-faux-failure");
      },
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_err_faux", "Say something.", "conv-pi-err-faux", recorder);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("task_cancelled");
    expect(result.error?.message).toContain("Code-agent turn failed: scripted-faux-failure");
    expect(recorder.recordError).toHaveBeenCalledWith("scripted-faux-failure", { code: "pi_core_model_error" });
    await service.shutdown?.();
  });

  // ── 7. usage evidence ──────────────────────────────────────────────────
  //
  // Mapping location (verified against code-agent-driver.ts): the full mapped
  // AgentUsage (inputTokens / cachedInputTokens / outputTokens / totalCostUsd /
  // contextWindowUsedTokens) is surfaced via recorder.recordUsage on
  // turn_completed; TaskResult carries only metrics.tokensUsed (the summed
  // token count). Faux estimates usage from the serialized context, so every
  // value is deterministic and non-zero except cost (faux models cost 0).

  it("usage evidence: recordUsage carries mapped usage and result.metrics.tokensUsed > 0", async () => {
    const { adapter, faux, cwd } = makeHarness();
    faux.setResponses([fauxAssistantMessage("USAGE_PROBE_DONE")]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_usage", "Report your usage.", "conv-pi-usage", recorder);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("USAGE_PROBE_DONE");
    expect(result.metrics?.tokensUsed).toBeGreaterThan(0);
    expect(recorder.recordUsage).toHaveBeenCalled();
    const usageCall = recorder.recordUsage.mock.calls.at(-1)?.[0] as
      | { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalCostUsd?: number; contextWindowUsedTokens?: number }
      | undefined;
    expect(usageCall).toBeDefined();
    expect(usageCall!.inputTokens).toBeGreaterThan(0);
    expect(usageCall!.outputTokens).toBeGreaterThan(0);
    expect(usageCall!.totalCostUsd).toBe(0); // faux models have zero cost
    expect(usageCall!.contextWindowUsedTokens).toBeGreaterThan(0);
    await service.shutdown?.();
  });

  // ── 8. reasoning timeline ──────────────────────────────────────────────

  it("reasoning timeline: faux thinking block reaches recordReasoningChunk", async () => {
    const { adapter, faux, cwd } = makeHarness();
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("THINK_ABOUT_FS"), fauxText("REASONED_DONE")]),
    ]);

    const recorder = makeRecorder();
    const service = await adapter.ensureService!(makeProfile(cwd));
    const result = await dispatchRun(service, "run_pi_reasoning", "Think before answering.", "conv-pi-reasoning", recorder);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("REASONED_DONE");
    expect(recorder.recordReasoningChunk).toHaveBeenCalled();
    const reasoningTexts = recorder.recordReasoningChunk.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(reasoningTexts.some((text) => text === "THINK_ABOUT_FS")).toBe(true);
    await service.shutdown?.();
  });
});
