import {
  getAgentStreamEventTurnId,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentStreamEvent,
  type AgentTimelineItem,
} from "../agent-sdk-types.js";
import { finalizeTerminalTurn } from "../lifecycle/terminal-finalizer.js";
import type { TerminalState, ToolFailureSummary } from "../lifecycle/post-turn-store.js";

export type ProviderFinalTextReducer = (params: {
  current: string;
  item: AgentTimelineItem;
}) => string;

export interface ProviderTurnRunner {
  startTurn: (prompt: AgentPromptInput, options?: AgentRunOptions) => Promise<{ turnId: string }>;
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
  getSessionId: () => string | Promise<string>;
  getRuntimeInfo?: () => AgentRuntimeInfo | Promise<AgentRuntimeInfo>;
}

export interface RunProviderTurnOptions extends ProviderTurnRunner {
  prompt: AgentPromptInput;
  runOptions?: AgentRunOptions;
  reduceFinalText?: ProviderFinalTextReducer;
}

export async function runProviderTurn({
  prompt,
  runOptions,
  startTurn,
  subscribe,
  getSessionId,
  getRuntimeInfo,
  reduceFinalText = replaceFinalTextWithAssistantMessage,
}: RunProviderTurnOptions): Promise<AgentRunResult> {
  const timeline: AgentTimelineItem[] = [];
  let finalText = "";
  let usage: AgentRunResult["usage"];
  let turnId: string | null = null;
  let terminalState: TerminalState = "failed";
  let terminalFailure: ToolFailureSummary | null = null;
  let canceled = false;
  let servedModel: string | undefined;
  let servedProvider: AgentRunResult["servedProvider"];
  const bufferedEvents: AgentStreamEvent[] = [];
  let settled = false;
  let finalized = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  let unsubscribe: () => void = () => undefined;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (runOptions?.postTurn) {
      const executionContext = {
        ...(runOptions.postTurn.executionContext ?? {}),
        model: servedModel,
        provider: servedProvider,
        routingEvidenceSource: 'adapter' as const,
      };
      finalizeTerminalTurn({
        ...runOptions.postTurn,
        executionContext,
        terminalState,
        assistantResponse: finalText,
        toolFailures: collectToolFailures(timeline, terminalFailure),
      });
    }
  };

  const resolveTerminalRouting = async (): Promise<void> => {
    // Without a terminal event there is no served provider. Do not turn a
    // configured runtime snapshot into false completion evidence.
    if (!servedProvider || !getRuntimeInfo) return;
    try {
      const info = await getRuntimeInfo();
      const runtimeModel = typeof info.extra?.runtimeModel === "string"
        ? info.extra.runtimeModel.trim()
        : "";
      const model = typeof info.model === "string" ? info.model.trim() : "";
      servedModel = runtimeModel || model || servedModel;
    } catch {
      // The terminal provider event remains valid evidence. A missing model is
      // handled by the shared post-turn routing gate, never by config fallback.
    }
  };

  const processEvent = (event: AgentStreamEvent) => {
    if (settled) {
      return;
    }
    const eventTurnId = getAgentStreamEventTurnId(event);
    if (turnId && eventTurnId && eventTurnId !== turnId) {
      return;
    }
    if (event.type === "timeline") {
      timeline.push(event.item);
      finalText = reduceFinalText({ current: finalText, item: event.item });
      return;
    }
    if (event.type === "model_changed") {
      servedProvider = event.provider;
      const runtimeModel = typeof event.runtimeInfo.extra?.runtimeModel === "string"
        ? event.runtimeInfo.extra.runtimeModel.trim()
        : "";
      const model = typeof event.runtimeInfo.model === "string" ? event.runtimeInfo.model.trim() : "";
      servedModel = runtimeModel || model || servedModel;
      return;
    }
    if (event.type === "turn_completed") {
      servedProvider = event.provider;
      usage = event.usage;
      terminalState = "completed";
      settled = true;
      resolveCompletion();
      return;
    }
    if (event.type === "turn_failed") {
      servedProvider = event.provider;
      terminalState = "failed";
      terminalFailure = {
        tool: "provider",
        ...(event.code ? { code: event.code } : {}),
        summary: event.error,
      };
      settled = true;
      rejectCompletion(new Error(event.error));
      return;
    }
    if (event.type === "turn_canceled") {
      servedProvider = event.provider;
      terminalState = "canceled";
      canceled = true;
      settled = true;
      resolveCompletion();
    }
  };

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  try {
    unsubscribe = subscribe((event) => {
      if (!turnId) {
        bufferedEvents.push(event);
        return;
      }
      processEvent(event);
    });
    const result = await startTurn(prompt, runOptions);
    turnId = result.turnId;
    for (const event of bufferedEvents) {
      processEvent(event);
    }
    await completion;
    await resolveTerminalRouting();
    // Persist before provider session-id bookkeeping: a terminal turn must not
    // lose its durable snapshot because getSessionId() hangs or throws.
    finalize();
    return {
      sessionId: await getSessionId(),
      finalText,
      usage,
      timeline,
      ...(canceled ? { canceled: true } : {}),
      ...(servedModel ? { servedModel } : {}),
      ...(servedProvider ? { servedProvider } : {}),
    };
  } catch (error) {
    if (!terminalFailure) {
      terminalState = canceled ? "canceled" : "failed";
      terminalFailure = {
        tool: "provider",
        summary: error instanceof Error ? error.message : String(error),
      };
    }
    await resolveTerminalRouting();
    finalize();
    throw error;
  } finally {
    unsubscribe();
    finalize();
  }
}

function collectToolFailures(
  timeline: AgentTimelineItem[],
  terminalFailure: ToolFailureSummary | null,
): ToolFailureSummary[] {
  const failures: ToolFailureSummary[] = [];
  for (const item of timeline) {
    if (item.type === "tool_call" && item.status === "failed") {
      const error = item.error as { code?: unknown; message?: unknown } | null;
      failures.push({
        tool: item.name,
        ...(typeof error?.code === "string" ? { code: error.code } : {}),
        summary:
          typeof error?.message === "string"
            ? error.message
            : error === null || error === undefined
              ? "tool call failed"
              : String(error),
      });
    } else if (item.type === "error") {
      failures.push({ tool: "provider", summary: item.message });
    }
  }
  if (terminalFailure) failures.push(terminalFailure);
  return failures;
}

export function replaceFinalTextWithAssistantMessage({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  return item.type === "assistant_message" ? item.text : current;
}

export function appendOrReplaceGrowingAssistantMessage({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  if (item.type !== "assistant_message") {
    return current;
  }
  if (!current) {
    return item.text;
  }
  return item.text.startsWith(current) ? item.text : `${current}${item.text}`;
}
