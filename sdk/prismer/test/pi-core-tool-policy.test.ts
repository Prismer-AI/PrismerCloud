import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentCoreClient, type PiCoreToolPolicy } from "../src/adapters/runtime-engine/pi-core/agent.js";
import type { ToolEventInput } from "../src/turn/protocol.js";

describe("PI core execution policy (not a shell filesystem sandbox)", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  async function attempt(policy?: PiCoreToolPolicy, tool = "bash", mutate?: () => void) {
    const root = mkdtempSync(join(tmpdir(), "pi-policy-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    const path = tool === "bash" ? join(root, "outside.txt") : join(cwd, "inside.txt");
    const faux = fauxProvider({ provider: "faux", api: "faux", models: [{ id: "test", name: "Policy test" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let results: unknown[] = [];
    const events: ToolEventInput[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(tool, tool === "bash" ? { command: `printf marker > '${path}'` } : tool === "memory_context" ? {} : { path, content: "marker" }, { id: "call" }), { stopReason: "toolUse" }),
      (context) => {
        results = context.messages.filter((message) => message.role === "toolResult");
        return fauxAssistantMessage("done");
      },
    ]);
    const session = await new PiAgentCoreClient({ models, allowShell: true, toolPolicy: policy,
      onToolEvent: (event) => { events.push(event); throw new Error("observer unavailable"); },
    }).createSession({ provider: "pi-core", cwd, model: "faux/test",
      ...(tool === "memory_context" ? { runtimeTools: [{ name: tool, kind: "component", source: "prismer-native", version: "1.0.0", config: { memoryBlock: "PROTECTED_MEMORY" } }] } : {}),
    });
    mutate?.();
    try { await session.run("perform the tool call"); } finally { await session.close(); }
    return { path, results, events };
  }

  it("documents that allowShell alone permits writes outside cwd", async () => {
    const { path } = await attempt();
    expect(readFileSync(path, "utf8")).toBe("marker");
  });

  it.each([
    { deny: ["bash"] },
    { allow: [] },
    { allow: ["bash"], deny: ["bash"] },
    { authorize: async () => false },
    { authorize: async () => { throw new Error("secret backend failure"); } },
    { authorize: async () => undefined as unknown as boolean },
  ])("blocks real shell side effects fail-closed: %j", async (policy) => {
    const { path, results, events } = await attempt(policy);
    expect(existsSync(path)).toBe(false);
    expect(results).toEqual([expect.objectContaining({ isError: true })]);
    expect(JSON.stringify(results)).toContain("Pi Core tool policy denied");
    expect(JSON.stringify(results)).not.toContain("secret backend failure");
    expect(events.map((event) => event.kind)).toEqual(["tool_started", "tool_finished"]);
    expect(events[1]).toMatchObject({ isError: true });
  });

  it("applies the same gate to file tools", async () => {
    const { path } = await attempt({ deny: ["write"] }, "write");
    expect(existsSync(path)).toBe(false);
  });

  it("allows explicitly authorized execution and passes validated call context", async () => {
    const authorize = vi.fn(async () => true);
    const { path } = await attempt({ allow: ["bash"], authorize });
    expect(readFileSync(path, "utf8")).toBe("marker");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ name: "bash", args: expect.objectContaining({ command: expect.any(String) }), cwd: expect.any(String) }), expect.anything());
  });

  it("snapshots static deny rules at session creation", async () => {
    const deny = ["bash"];
    const { path } = await attempt({ deny }, "bash", () => deny.splice(0));
    expect(existsSync(path)).toBe(false);
  });

  it("checks live authorization at execution time", async () => {
    let granted = true;
    const { path } = await attempt({ authorize: async () => granted }, "bash", () => { granted = false; });
    expect(existsSync(path)).toBe(false);
  });

  it("denies component tools before returning protected content", async () => {
    const { results } = await attempt({ deny: ["memory_context"] }, "memory_context");
    expect(JSON.stringify(results)).toContain("Pi Core tool policy denied");
    expect(JSON.stringify(results)).not.toContain("PROTECTED_MEMORY");
  });

  it("never invokes authorization to override a static deny", async () => {
    const authorize = vi.fn(async () => true);
    const { path } = await attempt({ deny: ["bash"], authorize });
    expect(authorize).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("does not let the authorization callback rewrite executed arguments", async () => {
    const { path } = await attempt({ authorize: ({ args }) => {
      (args as { command: string }).command = "exit 0";
      return true;
    } });
    expect(readFileSync(path, "utf8")).toBe("marker");
  });
});
