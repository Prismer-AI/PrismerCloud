// pi-core-hitl-acl-injection.test.ts — EaaS PI agent core HITL/ACL static guidance.
//
// Regression target:
//   - PI core is the actual in-pod EaaS turn engine, so the model must see the
//     platform HITL and ACL rules even when Cloud only sends a terse base
//     systemPrompt.
//   - This is a local agent infra test: pi-agent-core + pi-ai faux provider,
//     no gateway credentials and no mocked session facade.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { PiAgentCoreClient } from "../src/adapters/runtime-engine/pi-core/agent.js";

describe("pi-core EaaS HITL/ACL static injection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeHarness() {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-hitl-acl-"));
    tempDirs.push(cwd);
    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core HITL/ACL Model" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const client = new PiAgentCoreClient({
      models,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
      allowShell: true,
    });
    return { client, faux, cwd };
  }

  it("injects EaaS HITL and ACL rules into the PI core system prompt while preserving the cloud prompt", async () => {
    const { client, faux, cwd } = makeHarness();
    let capturedSystemPrompt = "";
    faux.setResponses([
      (context) => {
        capturedSystemPrompt = String((context as { systemPrompt?: unknown }).systemPrompt ?? "");
        return fauxAssistantMessage("PROMPT_CAPTURED");
      },
    ]);

    const session = await client.createSession({
      provider: "pi-core",
      cwd,
      systemPrompt: "You are the hosted agent inside a Prismer EaaS environment.",
      model: "faux/faux-1",
    });
    const result = await session.run("Capture prompt.");
    await session.close();

    expect(result.finalText).toBe("PROMPT_CAPTURED");
    expect(capturedSystemPrompt).toContain("You are the hosted agent inside a Prismer EaaS environment.");
    expect(capturedSystemPrompt).toContain("[Prismer EaaS HITL and ACL]");
    expect(capturedSystemPrompt).toContain("Ask a human clarification question");
    expect(capturedSystemPrompt).toContain("Never invent or bypass approval");
    expect(capturedSystemPrompt).toContain("Treat filesystem, asset, memory, MCP, web, and shell access as ACL-scoped");
    expect(capturedSystemPrompt).toContain("If an ACL blocks access, report the denial");
  });

  it("does not inject EaaS HITL/ACL rules into the default daemon PI core path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-hitl-acl-default-"));
    tempDirs.push(cwd);
    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core Default Model" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const client = new PiAgentCoreClient({
      models,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
    });
    let capturedSystemPrompt = "";
    faux.setResponses([
      (context) => {
        capturedSystemPrompt = String((context as { systemPrompt?: unknown }).systemPrompt ?? "");
        return fauxAssistantMessage("DEFAULT_CAPTURED");
      },
    ]);

    const session = await client.createSession({
      provider: "pi-core",
      cwd,
      systemPrompt: "You are a normal local PI core agent.",
      model: "faux/faux-1",
    });
    const result = await session.run("Capture prompt.");
    await session.close();

    expect(result.finalText).toBe("DEFAULT_CAPTURED");
    expect(capturedSystemPrompt).toBe("You are a normal local PI core agent.");
    expect(capturedSystemPrompt).not.toContain("[Prismer EaaS HITL and ACL]");
  });
});
