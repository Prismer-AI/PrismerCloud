// WS-B3 / WS-B2.6 — OPENCODE real-e2e through the CodeAgentDriver bridge. With the
// B2.6 custom-provider config injection (opencode.json declaring provider
// `prismer` → our gateway), the turn now COMPLETES through the gateway; we assert
// that rather than tolerating a model-blocked skip. Asserts listCommands() returns
// a non-empty slash list + a basic run returns non-empty output (TaskResult.ok).
//
// Run: npx vitest run --config /dev/null src/adapters/code-agent/e2e/opencode.real.e2e.test.ts

import { describe, it, expect, beforeAll } from "vitest";

import {
  binaryAvailable,
  makeService,
  makeTaskInput,
  tmpCwd,
  rmCwd,
} from "./harness.js";

const PROVIDER = "opencode" as const;
let available = false;

describe("WS-B3 opencode real-e2e (through CodeAgentDriver bridge)", () => {
  beforeAll(async () => {
    available = await binaryAvailable(PROVIDER);
    if (!available) console.log("[B3] SKIP opencode — binary not on PATH");
  });

  it("listCommands() returns a non-empty slash list", async (ctx) => {
    if (!available) return ctx.skip();
    const cwd = tmpCwd("b3-opencode-commands-");
    const service = await makeService(PROVIDER, cwd, { modeId: "build" });
    try {
      // establish a live session so listCommands delegates to it
      const { task } = makeTaskInput({ prompt: "Reply with exactly: OK" });
      const run = await service.dispatch(task);
      expect(
        run.ok,
        `opencode run must complete through the gateway: ${run.error?.code} ${run.error?.message}`,
      ).toBe(true);
      const commands = await service.listCommands();
      console.log(`[B3] opencode listCommands → ${commands.length} commands`);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands[0].name).toBeTruthy();
    } finally {
      await service.shutdown();
      rmCwd(cwd);
    }
  }, 120_000);

  it("basic run → ok with non-empty output through the gateway", async (ctx) => {
    if (!available) return ctx.skip();
    const cwd = tmpCwd("b3-opencode-run-");
    const service = await makeService(PROVIDER, cwd, { modeId: "build" });
    try {
      const { task } = makeTaskInput({ prompt: "Reply with exactly: PONG" });
      const result = await service.dispatch(task);
      expect(
        result.ok,
        `opencode basic run must complete through the gateway: ${result.error?.code} ${result.error?.message}`,
      ).toBe(true);
      expect((result.output ?? "").trim().length).toBeGreaterThan(0);
      console.log(`[B3] opencode basic run OK output=${JSON.stringify(result.output?.slice(0, 80))}`);
    } finally {
      await service.shutdown();
      rmCwd(cwd);
    }
  }, 120_000);
});
