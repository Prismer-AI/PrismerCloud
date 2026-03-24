/**
 * Prismer SDK — Multi-Tab Coordination
 *
 * Uses BroadcastChannel API to coordinate multiple browser tabs.
 * Protocol: "Last login wins" — the most recently opened tab becomes leader.
 * Leader runs outbox flush + sync. Passive tabs receive events from leader.
 *
 * Fallback: In environments without BroadcastChannel (Node.js, old browsers),
 * this is a no-op — single-tab/single-process behavior.
 */

import type { OfflineManager, SyncEvent } from './offline';

interface TabMessage {
  type: 'tab.claim' | 'tab.release' | 'tab.ack' | 'sync.event' | 'outbox.flushed';
  tabId: string;
  payload?: unknown;
}

/**
 * TabCoordinator manages leadership election and event relay
 * between multiple browser tabs sharing the same IndexedDB.
 */
export class TabCoordinator {
  private channel: BroadcastChannel | null = null;
  private tabId: string;
  private _isLeader = false;
  private disposed = false;

  get isLeader(): boolean { return this._isLeader; }

  constructor(
    private offline: OfflineManager,
    private channelName: string = 'prismer-tab-sync',
  ) {
    this.tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Initialize tab coordination.
   * Claims leadership immediately (last-login-wins).
   */
  init(): void {
    if (typeof BroadcastChannel === 'undefined') {
      // No BroadcastChannel — assume single tab, always leader
      this._isLeader = true;
      return;
    }

    this.channel = new BroadcastChannel(this.channelName);
    this.channel.onmessage = (e: MessageEvent<TabMessage>) => this.handleMessage(e.data);

    // Claim leadership (last login wins)
    this.claimLeadership();
  }

  /**
   * Release leadership and clean up.
   */
  destroy(): void {
    this.disposed = true;
    if (this.channel) {
      if (this._isLeader) {
        this.broadcast({ type: 'tab.release', tabId: this.tabId });
      }
      this.channel.close();
      this.channel = null;
    }
    this._isLeader = false;
  }

  /**
   * Relay a sync event to passive tabs.
   * Called by the leader tab after processing a sync event.
   */
  relaySyncEvent(event: SyncEvent): void {
    if (this._isLeader && this.channel) {
      this.broadcast({ type: 'sync.event', tabId: this.tabId, payload: event });
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private claimLeadership(): void {
    this._isLeader = true;
    this.broadcast({ type: 'tab.claim', tabId: this.tabId });
    this.onBecomeLeader();
  }

  private demoteToPassive(): void {
    if (!this._isLeader) return;
    this._isLeader = false;
    this.onBecomePassive();
  }

  private handleMessage(msg: TabMessage): void {
    if (this.disposed) return;

    switch (msg.type) {
      case 'tab.claim': {
        if (msg.tabId !== this.tabId) {
          // Another tab claimed leadership — demote self
          this.demoteToPassive();
          // Acknowledge the new leader
          this.broadcast({ type: 'tab.ack', tabId: this.tabId });
        }
        break;
      }
      case 'tab.release': {
        if (!this._isLeader) {
          // Leader released — claim leadership
          this.claimLeadership();
        }
        break;
      }
      case 'sync.event': {
        if (!this._isLeader && msg.payload) {
          // Passive tab receives sync event from leader — apply locally
          this.offline['applySyncEvent'](msg.payload as SyncEvent).catch(() => {});
        }
        break;
      }
    }
  }

  private onBecomeLeader(): void {
    // Leader starts outbox flush + sync
    // OfflineManager's timer and sync are already running — no action needed
    // because init() starts them. If they were stopped, restart.
  }

  private onBecomePassive(): void {
    // Passive tab stops outbox flush + sync (leader handles it)
    // We stop the continuous sync to avoid duplicate event processing
    this.offline.stopContinuousSync();
  }

  private broadcast(msg: TabMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      // Channel may be closed
    }
  }
}
