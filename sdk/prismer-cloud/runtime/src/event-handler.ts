/**
 * event-handler.ts — PARA event subscription and processing for Daemon
 *
 * Implements PARA event subscription, Tier-based event routing, and
 * integration with daemon startup workflow.
 *
 * Reference: docs/version190/04-sandbox-permissions.md §5.3
 */

import type { EventBus, Subscription, SubscriptionHandler, EventBusEnvelope } from './event-bus.js';
import type { AgentSupervisor } from './agent-supervisor.js';
import type { ParaEvent, AgentDescriptor } from '@prismer/wire';
import type { AgentRegisterEvent, AgentStateEvent, AgentSkillActivatedEvent, AgentSkillDeactivatedEvent, AgentApprovalRequestEvent, AgentApprovalResultEvent, AgentTaskCreatedEvent, AgentTaskCompletedEvent, AgentLlmPreEvent, AgentLlmPostEvent, AgentSessionStartedEvent, AgentSessionEndedEvent } from '@prismer/wire';

// ============================================================
// Types
// ============================================================

export interface EventHandlerOptions {
  bus: EventBus;
  supervisor: AgentSupervisor;
  /** Optional tier filter for event routing */
  tierFilter?: number;
}

/**
 * Event subscription configuration.
 * Stores both the handler function and the Subscription object from EventBus.
 */
export interface EventSubscription {
  eventType: string;
  handler: SubscriptionHandler<ParaEvent>;
  /** Minimum tier required to receive this event */
  minTier?: number;
  /** Reference to the actual Subscription object from EventBus */
  subscription?: Subscription;
}

// ============================================================
// Event Handler
// ============================================================

export class EventHandler {
  private readonly _bus: EventBus;
  private readonly _supervisor: AgentSupervisor;
  private readonly _tierFilter?: number;
  private readonly _subscriptions = new Map<string, Set<EventSubscription>>();
  private readonly _blockedEvents: string[] = [];
  private _registered = false;

  constructor(opts: EventHandlerOptions) {
    this._bus = opts.bus;
    this._supervisor = opts.supervisor;
    this._tierFilter = opts.tierFilter;
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Start subscribing to PARA events.
   * Must be called after daemon is fully initialized.
   */
  start(): void {
    if (this._registered) {
      return;
    }

    // Subscribe to core PARA events
    this._subscribe('agent.register', this._handleAgentRegister.bind(this));
    this._subscribe('agent.session.started', this._handleSessionStarted.bind(this));
    this._subscribe('agent.session.ended', this._handleSessionEnded.bind(this));
    this._subscribe('agent.state', this._handleAgentState.bind(this));
    this._subscribe('agent.skill.activated', this._handleSkillActivated.bind(this));
    this._subscribe('agent.skill.deactivated', this._handleSkillDeactivated.bind(this));
    this._subscribe('agent.approval.request', this._handleApprovalRequest.bind(this));
    this._subscribe('agent.approval.result', this._handleApprovalResult.bind(this));
    this._subscribe('agent.task.created', this._handleTaskCreated.bind(this));
    this._subscribe('agent.task.completed', this._handleTaskCompleted.bind(this));
    this._subscribe('agent.llm.pre', this._handleLlmPre.bind(this));
    this._subscribe('agent.llm.post', this._handleLlmPost.bind(this));

    this._registered = true;
  }

  /**
   * Stop all event subscriptions.
   */
  stop(): void {
    if (!this._registered) {
      return;
    }

    for (const [eventType, subs] of this._subscriptions.entries()) {
      for (const sub of subs) {
        sub.subscription?.unsubscribe();
      }
      subs.clear();
    }

    this._subscriptions.clear();
    this._registered = false;
  }

  // ============================================================
  // Subscription API
  // ============================================================

  /**
   * Subscribe to a specific PARA event type with optional tier filter.
   */
  private _subscribe(eventType: string, handler: SubscriptionHandler<ParaEvent>): void {
    // Apply tier filter
    if (this._tierFilter !== undefined) {
      const allowedEvents: string[] = [
        // Tier 1 (Trusted): Read + safe write with approval
        'agent.fs.op',
        'agent.file.watched',
        'agent.config.read',
        'agent.config.write',

        // Tier 2 (Trusted): Most operations with approval
        'agent.task.create',
        'agent.task.complete',
        'agent.approval.create',
        'agent.approval.approve',
        'agent.approval.deny',
        'agent.approval.timeout',

        // Tier 3 (Privileged): Most operations with approval
        'agent.llm.pre',
        'agent.llm.post',
        'agent.turn.step',
        'agent.turn.end',
        'agent.message',
        'agent.channel.inbound',
        'agent.channel.outbound.sent',
        'agent.channel.transcribed',
      ];

      // Check if event is allowed at current tier
      if (!allowedEvents.includes(eventType)) {
        console.warn(`[EventHandler] Event '${eventType}' not allowed at tier ${this._tierFilter}`);
        return;
      }
    }

    if (!this._subscriptions.has(eventType)) {
      this._subscriptions.set(eventType, new Set());
    }

    const subs = this._subscriptions.get(eventType)!;
    const busSubscription = this._bus.subscribe(eventType, handler);
    const eventSub = { eventType, handler, minTier: this._tierFilter, subscription: busSubscription };
    subs.add(eventSub);
  }

  /**
   * Unsubscribe from a specific event type.
   */
  unsubscribe(eventType: string, handler?: SubscriptionHandler<ParaEvent>): void {
    const subs = this._subscriptions.get(eventType);
    if (!subs) {
      return;
    }

    if (handler) {
      // Unsubscribe specific handler
      for (const sub of subs) {
        if (sub.handler === handler) {
          sub.subscription?.unsubscribe();
          subs.delete(sub);
          break;
        }
      }
    } else {
      // Unsubscribe all handlers for this event type
      for (const sub of subs) {
        sub.subscription?.unsubscribe();
      }
      subs.clear();
    }

    if (subs.size === 0) {
      this._subscriptions.delete(eventType);
    }
  }

  // ============================================================
  // Event Handlers
  // ============================================================

  /**
   * Handle agent registration event
   */
  private async _handleAgentRegister(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.register') {
      return;
    }

    const agent: AgentDescriptor = envelope.payload.agent;
    console.log(`[EventHandler] Agent registered: ${agent.adapter} (${agent.id})`);

    if (agent.tiersSupported.length === 0) {
      console.warn(`[EventHandler] Agent ${agent.id} has no tiers`);
    }

    // TODO: Fix AgentDescriptor type mismatch between wire and runtime packages
    // await this._supervisor.register(agent);
  }

  /**
   * Handle session started event
   */
  private async _handleSessionStarted(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.session.started') return;

    console.log(`[EventHandler] Session started`);
  }

  /**
   * Handle session ended event
   */
  private async _handleSessionEnded(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.session.ended') return;

    console.log(`[EventHandler] Session ended`);
  }

  /**
   * Handle agent state change
   */
  private async _handleAgentState(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.state') return;

    // TODO: Implement agent state tracking based on wire package event structure
    console.log(`[EventHandler] Agent state: ${envelope.payload.status}`);
  }

  /**
   * Handle skill activation
   */
  private async _handleSkillActivated(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.skill.activated') return;

    console.log(`[EventHandler] Skill activated`);
  }

  /**
   * Handle skill deactivation
   */
  private async _handleSkillDeactivated(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.skill.deactivated') return;

    console.log(`[EventHandler] Skill deactivated`);
  }

  /**
   * Handle approval request
   */
  private async _handleApprovalRequest(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.approval.request') return;

    console.log(`[EventHandler] Approval request`);
    // TODO: Implement approval workflow
  }

  /**
   * Handle approval result
   */
  private async _handleApprovalResult(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.approval.result') return;

    console.log(`[EventHandler] Approval result`);
    // TODO: Implement approval workflow
  }

  /**
   * Handle task creation
   */
  private async _handleTaskCreated(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.task.created') return;

    console.log(`[EventHandler] Task created`);
    // TODO: Implement task workflow
  }

  /**
   * Handle task completion
   */
  private async _handleTaskCompleted(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.task.completed') return;

    console.log(`[EventHandler] Task completed`);
    // TODO: Implement task workflow
  }

  /**
   * Handle LLM pre-request
   */
  private async _handleLlmPre(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.llm.pre') {
      return;
    }

    console.log('[EventHandler] LLM pre:', envelope.requestId);
  }

  /**
   * Handle LLM post-request
   */
  private async _handleLlmPost(envelope: EventBusEnvelope<ParaEvent>): Promise<void> {
    if (envelope.payload.type !== 'agent.llm.post') {
      return;
    }

    console.log('[EventHandler] LLM post:', envelope.requestId);
  }
}
