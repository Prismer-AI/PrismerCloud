// pi-core-shell-gate.test.ts — 会话级 shell 开关 `allowShell`（design §3.1 修1）验收面。
//
// 钉住三件事：
//   1. **缺省 false**（daemon / desktop / engine registry 路径）：工具面逐字是
//      read/write/edit，`exec()` 与 temp 保留「审批接线前恒拒」的原文——零行为变化；
//   2. **allowShell=true**（EaaS turn）：额外绑 bash（真跑 echo 拿 stdout）、exec 委托
//      内层 env、temp 落在 `<cwd>/.eaas/tmp`（**jail 内**，不是系统 tmpdir）；
//   3. **hook 只记录不拦截**：事件成对产生、isError 如实透传、sink 抛错不改工具结果。
//
// Oracle 纪律：工具面断言取自**引擎真发给模型的请求体**（`context.tools`），不是自述；
// bash 断言取自真实 stdout 回流进后续模型回复。

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  AgentRunResult,
  AgentSessionConfig,
} from "../src/adapters/runtime-engine/shared/agent-engine-types.js";
import { afterEach, describe, expect, it } from "vitest";
import { CwdJailedExecutionEnv, PiAgentCoreClient } from "../src/adapters/runtime-engine/pi-core/agent.js";
import type { ToolEventInput } from "../src/turn/protocol.js";

type Models = ReturnType<typeof createModels>;

/** 最近一次 toolResult 消息的文本（按 toolCallId 取）。 */
function toolResultTextById(context: Context, toolCallId: string): string {
  const message = [...context.messages]
    .reverse()
    .find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === toolCallId);
  if (!message) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("pi-core 会话级 shell 开关（allowShell）", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeCwd(prefix = "prismer-pi-shell-"): string {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(cwd);
    return cwd;
  }

  function makeFaux() {
    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [{ id: "faux-1", name: "Faux Pi Core Shell Model" }],
    });
    const models: Models = createModels();
    models.setProvider(faux.provider);
    return { faux, models };
  }

  async function makeSession(options: {
    cwd: string;
    models: Models;
    allowShell?: boolean;
    runtimeTools?: AgentSessionConfig["runtimeTools"];
    events?: ToolEventInput[];
    sink?: (event: ToolEventInput) => void;
  }): Promise<{ run: (prompt: string) => Promise<AgentRunResult>; close: () => Promise<void> }> {
    const client = new PiAgentCoreClient({
      models: options.models,
      defaultProvider: "faux",
      defaultModelId: "faux-1",
      ...(options.allowShell ? { allowShell: true } : {}),
      ...(options.events
        ? { onToolEvent: (event: ToolEventInput) => options.events!.push(event) }
        : {}),
      ...(options.sink ? { onToolEvent: options.sink } : {}),
    });
    const session = await client.createSession({
      provider: "pi-core",
      cwd: options.cwd,
      systemPrompt: "You are a focused shell-gate test agent.",
      model: "faux/faux-1",
      ...(options.runtimeTools ? { runtimeTools: options.runtimeTools } : {}),
    });
    return {
      run: (prompt: string) => session.run(prompt) as Promise<AgentRunResult>,
      close: () => session.close(),
    };
  }

  // ── 1. 缺省路径：工具面与拒绝面逐字不变 ───────────────────────────────────

  it("缺省（allowShell 未设）：真发给模型的工具面**恰好**是 read/write/edit", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    let toolsSentToModel: string[] = [];
    faux.setResponses([
      (context) => {
        // 引擎真发给模型的请求体是绑定结果的唯一可信投影（不是我们的自述）。
        toolsSentToModel = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage("TOOLS_CAPTURED");
      },
    ]);

    const session = await makeSession({ cwd, models });
    const result = await session.run("Which tools do you have?");
    await session.close();

    expect(result.finalText).toBe("TOOLS_CAPTURED");
    expect(toolsSentToModel).toEqual(["read", "write", "edit"]);
    expect(toolsSentToModel).not.toContain("bash");
  });

  it("缺省：exec() 保留原文拒绝（spawn_error + 「disabled until runtime approval is wired」）", async () => {
    const cwd = makeCwd();
    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd);
    const result = await env.exec("echo SHOULD_NOT_RUN");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("spawn_error");
      expect(result.error.message).toBe("Pi Core shell execution is disabled until runtime approval is wired");
    }
    await env.cleanup();
  });

  it("缺省：createTempDir / createTempFile 保留原文拒绝（jail 外语义）", async () => {
    const cwd = makeCwd();
    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd);
    const dir = await env.createTempDir("bash-");
    const file = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
    expect(dir.ok).toBe(false);
    expect(file.ok).toBe(false);
    if (!dir.ok) expect(dir.error.message).toBe("Pi Core temp dirs are disabled outside the cwd jail");
    if (!file.ok) expect(file.error.message).toBe("Pi Core temp files are disabled outside the cwd jail");
    // 拒绝必须无副作用：jail 里连 .eaas/ 都不该被建出来。
    expect(existsSync(join(cwd, ".eaas"))).toBe(false);
    await env.cleanup();
  });

  it("缺省：模型请求 bash 时**无事件产生**（未绑定工具走不到 beforeToolCall）", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    const events: ToolEventInput[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo DENIED" }, { id: "gate-bash" }), {
        stopReason: "toolUse",
      }),
      (context) => fauxAssistantMessage(`GATE_DONE ${toolResultTextById(context, "gate-bash")}`),
    ]);

    const session = await makeSession({ cwd, models, events });
    const result = await session.run("Run a shell command.");
    await session.close();

    // 事件面只记真实执行：未绑定的工具在执行前就被上游拒了。
    expect(events).toEqual([]);
    expect(result.finalText).toContain("Tool bash not found");
  });

  // ── 2. allowShell=true：解禁面 ────────────────────────────────────────────

  it("allowShell=true：工具面 = read/write/edit/**bash**", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    let toolsSentToModel: string[] = [];
    faux.setResponses([
      (context) => {
        toolsSentToModel = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage("TOOLS_CAPTURED");
      },
    ]);

    const session = await makeSession({ cwd, models, allowShell: true });
    await session.run("Which tools do you have?");
    await session.close();

    expect(toolsSentToModel).toEqual(["read", "write", "edit", "bash"]);
  });

  it("runtimeTools 声明组件：真工具面按声明追加 pi-coding-agent grep/find/ls", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    let toolsSentToModel: string[] = [];
    faux.setResponses([
      (context) => {
        toolsSentToModel = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage("TOOLS_CAPTURED");
      },
    ]);

    const session = await makeSession({
      cwd,
      models,
      allowShell: true,
      runtimeTools: [
        { name: "bash", kind: "builtin", enabled: true },
        { name: "read", kind: "builtin", enabled: true },
        { name: "write", kind: "builtin", enabled: true },
        { name: "edit", kind: "builtin", enabled: true },
        {
          name: "grep",
          kind: "component",
          enabled: true,
          source: "@earendil-works/pi-coding-agent",
          version: "0.84.2",
        },
        {
          name: "find",
          kind: "component",
          enabled: true,
          source: "@earendil-works/pi-coding-agent",
          version: "0.84.2",
        },
        {
          name: "ls",
          kind: "component",
          enabled: true,
          source: "@earendil-works/pi-coding-agent",
          version: "0.84.2",
        },
      ],
    });
    await session.run("Which tools do you have?");
    await session.close();

    expect(toolsSentToModel).toEqual(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  });

  it("runtimeTools 声明 Prismer native 上下文工具：memory_context / pkf_context / asset_context 可被模型调用", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    let toolsSentToModel: string[] = [];
    faux.setResponses([
      (context) => {
        toolsSentToModel = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage(
          fauxToolCall("memory_context", { query: "roadmap" }, { id: "mem-ctx" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall("pkf_context", { query: "inline" }, { id: "pkf-ctx" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("asset_context", { assetId: "asset_1" }, { id: "asset-ctx" }),
        { stopReason: "toolUse" },
      ),
      (context) =>
        fauxAssistantMessage(
          `NATIVE_DONE ${toolResultTextById(context, "mem-ctx")} ${toolResultTextById(context, "pkf-ctx")} ${toolResultTextById(context, "asset-ctx")}`,
        ),
    ]);

    const session = await makeSession({
      cwd,
      models,
      allowShell: true,
      runtimeTools: [
        {
          name: "memory_context",
          kind: "component",
          enabled: true,
          source: "prismer-native",
          version: "1.0.0",
          config: { memoryBlock: "Memory says: ship EaaS locally first." },
        },
        {
          name: "asset_context",
          kind: "component",
          enabled: true,
          source: "prismer-native",
          version: "1.0.0",
          config: {
            assets: [{ assetId: "asset_1", mediaType: "image/png", path: "/w/input.png" }],
          },
        },
        {
          name: "pkf_context",
          kind: "component",
          enabled: true,
          source: "prismer-native",
          version: "1.0.0",
          config: { pkfContext: "PKF says: inline block pkf_1 is authorized." },
        },
      ],
    });
    const result = await session.run("Read native context.");
    await session.close();

    expect(toolsSentToModel).toEqual(["memory_context", "asset_context", "pkf_context"]);
    expect(result.finalText).toContain("Memory says: ship EaaS locally first.");
    expect(result.finalText).toContain("PKF says: inline block pkf_1 is authorized.");
    expect(result.finalText).toContain("asset_1");
    expect(result.finalText).toContain("/w/input.png");
  });

  it("runtimeTools 组件版本与 catalog pin 不符：session 创建 fail-closed", async () => {
    const cwd = makeCwd();
    const { models } = makeFaux();

    await expect(
      makeSession({
        cwd,
        models,
        allowShell: true,
        runtimeTools: [
          {
            name: "grep",
            kind: "component",
            enabled: true,
            source: "@earendil-works/pi-coding-agent",
            version: "0.87.0",
          },
        ],
      }),
    ).rejects.toThrow(/version mismatch/);
  });

  it("runtimeTools 声明组件：reviewed pi-web-access pack 的工具进入模型工具面", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    let toolsSentToModel: string[] = [];
    faux.setResponses([
      (context) => {
        toolsSentToModel = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage("TOOLS_CAPTURED");
      },
    ]);

    const session = await makeSession({
      cwd,
      models,
      allowShell: true,
      runtimeTools: [
        {
          name: "web_search",
          kind: "component",
          enabled: true,
          source: "pi-web-access",
          version: "0.30.0",
        },
        {
          name: "fetch_content",
          kind: "component",
          enabled: true,
          source: "pi-web-access",
          version: "0.30.0",
        },
      ],
    });
    await session.run("Which tools do you have?");
    await session.close();

    expect(toolsSentToModel).toEqual(["web_search", "fetch_content"]);
  });

  it("runtimeTools 声明组件：远端 MCP URL 通过 pi-mcp-adapter proxy 工具进入模型工具面", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    let toolsSentToModel: string[] = [];
    faux.setResponses([
      (context) => {
        toolsSentToModel = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage("TOOLS_CAPTURED");
      },
    ]);

    const session = await makeSession({
      cwd,
      models,
      allowShell: true,
      runtimeTools: [
        {
          name: "mcp",
          kind: "component",
          enabled: true,
          source: "pi-mcp-adapter",
          version: "2.36.0",
          config: { servers: [{ name: "docs", url: "https://mcp.example.test/rpc" }] },
        },
      ],
    });
    await session.run("Which tools do you have?");
    await session.close();

    expect(toolsSentToModel).toEqual(["mcp"]);
  });

  it("runtimeTools 声明组件：pi-mcp-adapter 缺少 server config 时 session 创建 fail-closed", async () => {
    const cwd = makeCwd();
    const { models } = makeFaux();

    await expect(
      makeSession({
        cwd,
        models,
        allowShell: true,
        runtimeTools: [
          {
            name: "mcp",
            kind: "component",
            enabled: true,
            source: "pi-mcp-adapter",
            version: "2.36.0",
          },
        ],
      }),
    ).rejects.toThrow(/requires at least one configured MCP HTTP server/);
  });

  it("allowShell=true：bash 真跑——`echo` 的 stdout 回流进后续模型回复（不是自述）", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    const events: ToolEventInput[] = [];
    const token = `PI_BASH_OK_${Date.now()}`;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${token}` }, { id: "gate-run" }), {
        stopReason: "toolUse",
      }),
      (context) => fauxAssistantMessage(`BASH_OUT=${toolResultTextById(context, "gate-run").trim()}`),
    ]);

    const session = await makeSession({ cwd, models, allowShell: true, events });
    const result = await session.run(`Run: echo ${token}`);
    await session.close();

    // 真执行的三重证据：stdout 进了工具结果 → 进了后续模型回复 → 成了终态文本。
    expect(result.finalText).toBe(`BASH_OUT=${token}`);
    expect(events.map((event) => `${event.kind}:${event.name}`)).toEqual([
      "tool_started:bash",
      "tool_finished:bash",
    ]);
    const started = events[0]!;
    const finished = events[1]!;
    expect(started.argsSummary).toContain(token);
    expect(finished.resultSummary).toContain(token);
    expect(finished.isError).toBe(false);
    expect(finished.durationMs).toBeTypeOf("number");
  });

  it("allowShell=true：exec 委托内层 env（ShellExecOptions 透传，退出码是真实退出码）", async () => {
    const cwd = makeCwd();
    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd, true);
    const ok = await env.exec(`basename "$PWD"`);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.exitCode).toBe(0);
      // 命令在**会话 cwd** 里跑（bash 工具的 execution.cwd 取自 env.cwd），不是进程 cwd。
      expect(ok.value.stdout.trim()).toBe(basename(cwd));
    }
    const failed = await env.exec(`exit 7`);
    expect(failed.ok).toBe(true);
    if (failed.ok) expect(failed.value.exitCode).toBe(7);
    await env.cleanup();
  });

  it("allowShell=true：createTempFile 落在 <cwd>/.eaas/tmp（jail 内）且保留前缀/后缀", async () => {
    const cwd = makeCwd();
    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd, true);
    const created = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected temp file creation to succeed");
    const path = created.value;
    // 路径必须在 jail 内（相对 jail 根不含 ..），且目录是 .eaas/tmp——不是系统 tmpdir。
    // jail 根是 **canonical** cwd（macOS /var → /private/var），故按 realpath 比。
    expect(path.startsWith(join(realpathSync(cwd), ".eaas", "tmp") + sep)).toBe(true);
    expect(relative(realpathSync(cwd), path).startsWith("..")).toBe(false);
    const name = path.slice(path.lastIndexOf(sep) + 1);
    expect(name.startsWith("bash-")).toBe(true);
    expect(name.endsWith(".log")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);

    // jail 内的 temp 必须能被**文件工具**（同一 jail）读到：bash 长输出截断靠它。
    const append = await env.appendFile(path, "TRUNCATED_TAIL\n");
    expect(append.ok).toBe(true);
    const read = await env.readTextFile(path);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toBe("TRUNCATED_TAIL\n");
    await env.cleanup();
  });

  it("allowShell=true：createTempDir 同样落在 jail 内且可写", async () => {
    const cwd = makeCwd();
    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd, true);
    const created = await env.createTempDir("bash-");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected temp dir creation to succeed");
    expect(created.value.startsWith(join(realpathSync(cwd), ".eaas", "tmp") + sep)).toBe(true);
    const name = created.value.slice(created.value.lastIndexOf(sep) + 1);
    expect(name.startsWith("bash-")).toBe(true);
    expect(statSync(created.value).isDirectory()).toBe(true);
    await env.cleanup();
  });

  it("allowShell=true：bash 仍受 cwd 约束（命令在 env.cwd 内跑，不是进程 cwd）", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    writeFileSync(join(cwd, "jail-marker.txt"), "JAIL_MARKER\n");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "cat jail-marker.txt" }, { id: "gate-rel" }), {
        stopReason: "toolUse",
      }),
      (context) => fauxAssistantMessage(`REL=${toolResultTextById(context, "gate-rel").trim()}`),
    ]);

    const session = await makeSession({ cwd, models, allowShell: true });
    const result = await session.run("Read the marker with a relative path.");
    await session.close();

    expect(result.finalText).toBe("REL=JAIL_MARKER");
  });

  // ── 3. hook 只记录不拦截 ──────────────────────────────────────────────────

  it("hook：write 调用产生成对事件，argsSummary/resultSummary 可读且 isError=false", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    const events: ToolEventInput[] = [];
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "out.txt", content: "HOOK_WRITE_OK" }, { id: "hook-w" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("HOOK_DONE"),
    ]);

    const session = await makeSession({ cwd, models, allowShell: true, events });
    const result = await session.run("Write out.txt.");
    await session.close();

    // 只记录不拦截：工具照常落盘（没有被 block）。
    expect(result.finalText).toBe("HOOK_DONE");
    expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("HOOK_WRITE_OK");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "tool_started", name: "write" });
    expect(events[0]!.argsSummary).toContain("out.txt");
    expect(events[1]).toMatchObject({ kind: "tool_finished", name: "write", isError: false });
    expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("hook：失败的命令 → isError=true 事件（不静默），工具结果仍回到模型", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    const events: ToolEventInput[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "exit 3" }, { id: "hook-fail" }), {
        stopReason: "toolUse",
      }),
      (context) => fauxAssistantMessage(`FAIL_SEEN=${toolResultTextById(context, "hook-fail").includes("exited with code 3")}`),
    ]);

    const session = await makeSession({ cwd, models, allowShell: true, events });
    const result = await session.run("Run a failing command.");
    await session.close();

    expect(result.finalText).toBe("FAIL_SEEN=true");
    const finished = events.find((event) => event.kind === "tool_finished");
    expect(finished?.isError).toBe(true);
    expect(finished?.name).toBe("bash");
  });

  it("hook：sink 抛错**不改** turn 结果（事件面污染 turn 是被禁止的失效模式）", async () => {
    const cwd = makeCwd();
    const { faux, models } = makeFaux();
    const boomMarker = "SINK_EXCEPTION_MARKER";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "sink-target.txt", content: "SINK_BOOM_OK" }, { id: "boom-w" }),
        { stopReason: "toolUse" },
      ),
      (context) => fauxAssistantMessage(`BOOM_DONE=${toolResultTextById(context, "boom-w")}`),
    ]);

    const session = await makeSession({
      cwd,
      models,
      allowShell: true,
      sink: () => {
        throw new Error(boomMarker);
      },
    });
    const result = await session.run("Write sink-target.txt.");
    await session.close();

    // 工具副作用照常落盘、模型拿到的是**工具自己的**结果（不是 sink 的异常文本）。
    // ⚠️ 若 hook 的异常外溢，上游会把它变成该次工具调用的错误结果（"Tool result was
    // replaced"），模型看到的就不是成功写入了——这一条正是那个失效模式的判据。
    expect(readFileSync(join(cwd, "sink-target.txt"), "utf8")).toBe("SINK_BOOM_OK");
    expect(result.finalText).not.toContain(boomMarker);
    expect(result.timeline.some((item) => item.type === "tool_call")).toBe(true);
  });
});
