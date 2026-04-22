/**
 * Prismer Runtime — Task Router
 *
 * v1.9.0 Task Router: HTTP API for routing tasks to agents,
 * capability matching, and SSE streaming of task state changes.
 *
 * Integrates with:
 * - Cloud API (/api/im/tasks) for persistent task store
 * - AgentSupervisor for local agent status
 * - EventBus for SSE streaming
 *
 * Design reference: docs/version190/IMPLEMENTATION-PLAN-RUNTIME-GAP.md §P1
 */

import * as http from 'node:http';
import type { EventBus } from './event-bus.js';
import type { AgentSupervisor } from './agent-supervisor.js';
import { sendJson } from './http/helpers.js';
import { handleSse } from './http/sse.js';
import type { SseDeps } from './http/sse.js';
import type { RouteHandler } from './daemon-http.js';

// ─── State Enum (§16.4) ───────────────────────────────

/**
 * Task routing state machine per §16.4.
 *
 * State transitions:
 *   created → dispatching → step_running → step_completed → (next step or completed)
 *   step_running → step_failed → retrying (×3) → retry_exhausted → needs_human
 *   step_running → step_timeout → rerouting → step_running (new agent)
 */
export enum TaskRouteState {
  Created = 'created',
  Dispatching = 'dispatching',
  StepRunning = 'step_running',
  StepCompleted = 'step_completed',
  StepFailed = 'step_failed',
  StepTimeout = 'step_timeout',
  Retrying = 'retrying',
  RetryExhausted = 'retry_exhausted',
  NeedsHuman = 'needs_human',
  Rerouting = 'rerouting',
  Completed = 'completed',
  Cancelled = 'cancelled',
}

const MAX_STEP_RETRIES = 3;

// ─── Types ─────────────────────────────────────────────

export interface TaskRouterOptions {
  eventBus: EventBus;
  supervisor: AgentSupervisor;
  cloudBaseUrl?: string; // default: https://prismer.cloud
  apiToken?: string; // Prismer API key for Cloud API calls
}

export interface TaskInfo {
  id: string;
  title: string;
  status: TaskRouteState | string; // allow string for backwards compat with cloud API
  requiresCapability?: string | null;
  runtimeRoute?: unknown[] | null;
  assigneeId?: string | null;
  progress?: number | null;
  statusMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouteTaskRequest {
  taskId?: string;
  priority?: 'high' | 'normal' | 'low';
  preferredAgentId?: string;
}

export interface RouteTaskResponse {
  taskId: string;
  agentId: string;
  capability: string;
  stepIdx: number;
  totalSteps: number;
}

export interface AssignTaskRequest {
  agentId: string;
  taskId?: string;
}

export interface StepCompletedRequest {
  taskId?: string;
  stepId: string;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CancelTaskRequest {
  taskId?: string;
  reason: string;
}

export interface StepFailedRequest {
  taskId?: string;
  stepId: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StepTimeoutRequest {
  taskId?: string;
  stepId: string;
  capability?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthenticatedIdentity {
  agentId: string;
  bearerSub?: string;
}

// ─── TaskRouter ─────────────────────────────────────

export class TaskRouter {
  private readonly _bus: EventBus;
  private readonly _supervisor: AgentSupervisor;
  private readonly _cloudBaseUrl: string;
  private readonly _apiToken: string | undefined;

  private _sseClients = new Set<http.ServerResponse>();
  /** Per-step retry counters: key = `${taskId}:${stepId}` */
  private readonly _retryCounters = new Map<string, number>();

  constructor(opts: TaskRouterOptions) {
    this._bus = opts.eventBus;
    this._supervisor = opts.supervisor;
    this._cloudBaseUrl = opts.cloudBaseUrl ?? 'https://prismer.cloud';
    this._apiToken = opts.apiToken;
  }

  /**
   * Register HTTP routes with the daemon server.
   * Call this from daemon-http.ts to expose task router endpoints.
   */
  registerRoutes(server: {
    registerRoute: (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      handler: RouteHandler,
    ) => void;
  }): void {
    // POST /tasks/:id/route — Route task to optimal agent
    server.registerRoute('POST', '/tasks/:id/route', async (req, res, ctx) => {
      await this._handleRouteTask(req, res, ctx.body);
    });

    // POST /tasks/:id/assign — Manually assign task to specific agent
    server.registerRoute('POST', '/tasks/:id/assign', async (req, res, ctx) => {
      await this._handleAssignTask(req, res, ctx.body);
    });

    // POST /tasks/:id/step-completed — Record step completion
    server.registerRoute('POST', '/tasks/:id/step-completed', async (req, res, ctx) => {
      await this._handleStepCompleted(req, res, ctx.body);
    });

    // POST /tasks/:id/cancel — Cancel a task
    server.registerRoute('POST', '/tasks/:id/cancel', async (req, res, ctx) => {
      await this._handleCancelTask(req, res, ctx.body);
    });

    // POST /tasks/:id/step-failed — Record step failure with retry logic
    server.registerRoute('POST', '/tasks/:id/step-failed', async (req, res, ctx) => {
      await this._handleStepFailed(req, res, ctx.body);
    });

    // POST /tasks/:id/step-timeout — Handle step timeout with rerouting
    server.registerRoute('POST', '/tasks/:id/step-timeout', async (req, res, ctx) => {
      await this._handleStepTimeout(req, res, ctx.body);
    });

    // GET /tasks/:id — Get task details
    server.registerRoute('GET', '/tasks/:id', async (req, res) => {
      await this._handleGetTask(req, res);
    });

    // GET /tasks — List tasks (filtered by status, agent, capability)
    server.registerRoute('GET', '/tasks', async (req, res) => {
      await this._handleListTasks(req, res);
    });

    // GET /tasks/events — SSE stream for task state changes
    server.registerRoute('GET', '/tasks/events', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const sseDeps: SseDeps = {
        bus: this._bus,
        sseClients: this._sseClients,
      };
      await handleSse(req, res, url, sseDeps);
    });
  }

  // ─── Route Handlers ─────────────────────────────────

  private async _handleRouteTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestBody: Buffer,
  ): Promise<void> {
    try {
      // Extract taskId from URL path
      const match = req.url?.match(/\/tasks\/([^/]+)\/route/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const input: RouteTaskRequest = requestBody.length
        ? JSON.parse(requestBody.toString('utf8'))
        : {};

      // Validate input
      if (input.taskId !== undefined && input.taskId !== taskId) {
        return sendJson(res, 400, { error: 'taskId-mismatch' });
      }

      // Publish dispatching state before calling cloud API
      this._publishState(taskId, TaskRouteState.Dispatching);

      // Call Cloud API to route task
      const cloudResult = await this._callCloudApi(
        `/tasks/${taskId}/route`,
        'POST',
        { ...input, taskId } as unknown as Record<string, unknown>,
      );

      if (!cloudResult.ok) {
        return sendJson(res, cloudResult.status || 500, {
          error: 'route-failed',
          message: cloudResult.error,
        });
      }

      // Emit routed event to local agents (backwards compat)
      const response = cloudResult.data as RouteTaskResponse;
      this._bus.publish('task.routed', {
        taskId: response.taskId,
        agentId: response.agentId,
        capability: response.capability,
        stepIdx: response.stepIdx,
        totalSteps: response.totalSteps,
      });

      // Publish step_running state
      this._publishState(taskId, TaskRouteState.StepRunning, {
        agentId: response.agentId,
        capability: response.capability,
        stepIdx: response.stepIdx,
        totalSteps: response.totalSteps,
      });

      sendJson(res, 200, response);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleAssignTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestBody: Buffer,
  ): Promise<void> {
    try {
      const match = req.url?.match(/\/tasks\/([^/]+)\/assign/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const input: AssignTaskRequest = requestBody.length
        ? JSON.parse(requestBody.toString('utf8'))
        : ({} as AssignTaskRequest);

      // Validate input
      if (input.taskId !== undefined && input.taskId !== taskId) {
        return sendJson(res, 400, { error: 'taskId-mismatch' });
      }
      if (!input.agentId) {
        return sendJson(res, 400, { error: 'agentId-required' });
      }

      // Verify agent exists locally
      const agentStatus = this._supervisor.get(input.agentId);
      if (!agentStatus) {
        return sendJson(res, 404, { error: 'agent-not-found' });
      }

      // Call Cloud API to assign task
      const cloudResult = await this._callCloudApi(
        `/tasks/${taskId}/assign`,
        'POST',
        { ...input, taskId } as unknown as Record<string, unknown>,
      );

      if (!cloudResult.ok) {
        return sendJson(res, cloudResult.status || 500, {
          error: 'assign-failed',
          message: cloudResult.error,
        });
      }

      // Emit assigned event
      this._bus.publish('task.assigned', {
        taskId,
        agentId: input.agentId,
      });

      sendJson(res, 200, cloudResult.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleStepCompleted(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestBody: Buffer,
  ): Promise<void> {
    try {
      const match = req.url?.match(/\/tasks\/([^/]+)\/step-completed/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const input: StepCompletedRequest = requestBody.length
        ? JSON.parse(requestBody.toString('utf8'))
        : ({} as StepCompletedRequest);

      // Validate input
      if (input.taskId !== undefined && input.taskId !== taskId) {
        return sendJson(res, 400, { error: 'taskId-mismatch' });
      }
      if (!input.stepId) {
        return sendJson(res, 400, { error: 'stepId-required' });
      }

      // Call Cloud API to record step completion
      const cloudResult = await this._callCloudApi(
        `/tasks/${taskId}/step-completed`,
        'POST',
        { ...input, taskId } as unknown as Record<string, unknown>,
      );

      if (!cloudResult.ok) {
        return sendJson(res, cloudResult.status || 500, {
          error: 'step-complete-failed',
          message: cloudResult.error,
        });
      }

      // Emit step.completed event (backwards compat)
      this._bus.publish('task.step.completed', {
        taskId,
        stepId: input.stepId,
        result: input.result,
      });

      // Publish step_completed state
      this._publishState(taskId, TaskRouteState.StepCompleted, {
        stepId: input.stepId,
        result: input.result,
      });

      // Check if this was the last step (cloud response may indicate)
      const cloudData = cloudResult.data as Record<string, unknown> | undefined;
      const hasMoreSteps = cloudData?.hasMoreSteps ?? cloudData?.nextStepIdx !== undefined;

      if (hasMoreSteps) {
        // More steps to run — publish step_running for the next step
        this._publishState(taskId, TaskRouteState.StepRunning, {
          stepIdx: cloudData?.nextStepIdx,
          agentId: cloudData?.nextAgentId,
        });
      } else {
        // All steps done — publish completed
        this._publishState(taskId, TaskRouteState.Completed);
      }

      // Clear retry counters for this task's completed step
      const retryKey = `${taskId}:${input.stepId}`;
      this._retryCounters.delete(retryKey);

      sendJson(res, 200, cloudResult.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleCancelTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestBody: Buffer,
  ): Promise<void> {
    try {
      const match = req.url?.match(/\/tasks\/([^/]+)\/cancel/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const input: CancelTaskRequest = requestBody.length
        ? JSON.parse(requestBody.toString('utf8'))
        : ({} as CancelTaskRequest);

      if (input.taskId !== undefined && input.taskId !== taskId) {
        return sendJson(res, 400, { error: 'taskId-mismatch' });
      }
      if (!input.reason) {
        return sendJson(res, 400, { error: 'reason-required' });
      }

      // Call Cloud API to cancel task
      const cloudResult = await this._callCloudApi(
        `/tasks/${taskId}/cancel`,
        'POST',
        { ...input, taskId } as unknown as Record<string, unknown>,
      );

      if (!cloudResult.ok) {
        return sendJson(res, cloudResult.status || 500, {
          error: 'cancel-failed',
          message: cloudResult.error,
        });
      }

      // Emit cancelled event (backwards compat)
      this._bus.publish('task.cancelled', {
        taskId,
        reason: input.reason,
      });

      // Publish cancelled state
      this._publishState(taskId, TaskRouteState.Cancelled, {
        reason: input.reason,
      });

      // Clean up retry counters for this task to prevent memory leak (I1 review fix)
      for (const key of this._retryCounters.keys()) {
        if (key.startsWith(taskId + ':')) {
          this._retryCounters.delete(key);
        }
      }

      sendJson(res, 200, cloudResult.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleStepFailed(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestBody: Buffer,
  ): Promise<void> {
    try {
      const match = req.url?.match(/\/tasks\/([^/]+)\/step-failed/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const input: StepFailedRequest = requestBody.length
        ? JSON.parse(requestBody.toString('utf8'))
        : ({} as StepFailedRequest);

      if (input.taskId !== undefined && input.taskId !== taskId) {
        return sendJson(res, 400, { error: 'taskId-mismatch' });
      }
      if (!input.stepId) {
        return sendJson(res, 400, { error: 'stepId-required' });
      }

      // Publish step_failed state
      this._publishState(taskId, TaskRouteState.StepFailed, {
        stepId: input.stepId,
        error: input.error,
      });

      // Track retries per step
      const retryKey = `${taskId}:${input.stepId}`;
      const currentRetries = this._retryCounters.get(retryKey) ?? 0;

      if (currentRetries < MAX_STEP_RETRIES) {
        const attempt = currentRetries + 1;
        this._retryCounters.set(retryKey, attempt);

        // Publish retrying state
        this._publishState(taskId, TaskRouteState.Retrying, {
          stepId: input.stepId,
          attempt,
          maxRetries: MAX_STEP_RETRIES,
        });

        sendJson(res, 200, {
          retry: true,
          attempt,
          maxRetries: MAX_STEP_RETRIES,
        });
      } else {
        // Retries exhausted
        this._publishState(taskId, TaskRouteState.RetryExhausted, {
          stepId: input.stepId,
          attempts: currentRetries,
        });

        this._publishState(taskId, TaskRouteState.NeedsHuman, {
          stepId: input.stepId,
          reason: 'retry_exhausted',
        });

        // Clean up retry counter
        this._retryCounters.delete(retryKey);

        sendJson(res, 200, {
          retry: false,
          needsHuman: true,
          attempts: currentRetries,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleStepTimeout(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestBody: Buffer,
  ): Promise<void> {
    try {
      const match = req.url?.match(/\/tasks\/([^/]+)\/step-timeout/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const input: StepTimeoutRequest = requestBody.length
        ? JSON.parse(requestBody.toString('utf8'))
        : ({} as StepTimeoutRequest);

      if (input.taskId !== undefined && input.taskId !== taskId) {
        return sendJson(res, 400, { error: 'taskId-mismatch' });
      }
      if (!input.stepId) {
        return sendJson(res, 400, { error: 'stepId-required' });
      }

      // Publish step_timeout state
      this._publishState(taskId, TaskRouteState.StepTimeout, {
        stepId: input.stepId,
      });

      // Publish rerouting state
      this._publishState(taskId, TaskRouteState.Rerouting, {
        stepId: input.stepId,
        capability: input.capability,
      });

      // Attempt to find another agent via the supervisor
      const allAgents = this._supervisor.list();
      const runningAgents = allAgents.filter(
        (a) => a.state === 'running' || a.state === 'degraded',
      );

      // If a capability was specified, try to reroute via cloud API
      if (input.capability && runningAgents.length > 0) {
        const cloudResult = await this._callCloudApi(
          `/tasks/${taskId}/route`,
          'POST',
          {
            taskId,
            capability: input.capability,
            excludeTimedOut: true,
          } as unknown as Record<string, unknown>,
        );

        if (cloudResult.ok) {
          const routeData = cloudResult.data as RouteTaskResponse;

          // Publish step_running with the new agent
          this._publishState(taskId, TaskRouteState.StepRunning, {
            agentId: routeData.agentId,
            capability: routeData.capability,
            stepIdx: routeData.stepIdx,
            rerouted: true,
          });

          sendJson(res, 200, {
            rerouted: true,
            agentId: routeData.agentId,
            capability: routeData.capability,
            stepIdx: routeData.stepIdx,
          });
          return;
        }
      }

      // Could not reroute — escalate to human
      this._publishState(taskId, TaskRouteState.NeedsHuman, {
        stepId: input.stepId,
        reason: 'reroute_failed',
        capability: input.capability,
      });

      sendJson(res, 200, {
        rerouted: false,
        needsHuman: true,
        reason: 'no_available_agent',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleGetTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const match = req.url?.match(/\/tasks\/([^/]+)$/);
      if (!match) {
        return sendJson(res, 400, { error: 'invalid-url' });
      }
      const taskId = match[1];

      const cloudResult = await this._callCloudApi(`/tasks/${taskId}`, 'GET');

      if (!cloudResult.ok) {
        return sendJson(res, cloudResult.status || 500, {
          error: 'get-failed',
          message: cloudResult.error,
        });
      }

      sendJson(res, 200, cloudResult.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  private async _handleListTasks(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const params = new URLSearchParams(url.search);
      const status = params.get('status');
      const capability = params.get('capability');
      const agent = params.get('agent');
      const limit = params.get('limit');

      const cloudResult = await this._callCloudApi('/tasks', 'GET', undefined, {
        status: status || undefined,
        capability: capability || undefined,
        assigneeId: agent || undefined,
        limit: limit || undefined,
      });

      if (!cloudResult.ok) {
        return sendJson(res, cloudResult.status || 500, {
          error: 'list-failed',
          message: cloudResult.error,
        });
      }

      sendJson(res, 200, cloudResult.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'internal', message: msg });
    }
  }

  // ─── State Publishing ─────────────────────────────

  /** Publish a task.state event with the given TaskRouteState and optional extra fields. */
  private _publishState(
    taskId: string,
    state: TaskRouteState,
    extra?: Record<string, unknown>,
  ): void {
    this._bus.publish('task.state', {
      taskId,
      state,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  // ─── Cloud API Client ─────────────────────────────

  private async _callCloudApi(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    queryParams?: Record<string, string | undefined>,
  ): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
    const apiPath = path.startsWith('/api/') ? path : `/api/im${path}`;
    const url = new URL(apiPath, this._cloudBaseUrl);

    // Add query params
    if (queryParams) {
      Object.entries(queryParams).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, value);
        }
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this._apiToken) {
      headers['Authorization'] = `Bearer ${this._apiToken}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
      },
      body: body && method === 'POST' ? JSON.stringify(body) : undefined,
    });

    const responseBody = await response.text();
    let parsed: any = undefined;
    try {
      parsed = responseBody ? JSON.parse(responseBody) : undefined;
    } catch {
      parsed = undefined;
    }

    return {
      ok: response.ok && parsed?.ok !== false,
      status: response.status,
      data: parsed?.data ?? parsed,
      error: parsed?.error?.message ?? parsed?.error ?? (response.ok ? undefined : responseBody),
    };
  }
}
