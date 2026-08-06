/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Network } from '@capacitor/network';
import { App as CapacitorApp } from '@capacitor/app';
import type { DrainResult, Outbox, OutboxTransport } from './outbox';

/**
 * Decides when to drain the outbox.
 *
 * Connectivity comes from @capacitor/network rather than `navigator.onLine`,
 * which reports "online" for a WiFi association that has no route to anywhere -
 * exactly the situation at a site with a rig-side access point and no uplink.
 *
 * Nothing here runs while the app is closed. Capacitor has no background sync
 * without additional plugins, so a phone in a pocket does not upload overnight;
 * it catches up the moment the driller opens the app.
 */

/** Collapse a burst of saves into a single drain. */
const ENQUEUE_DEBOUNCE_MS = 1200;

/**
 * Safety net for a missed connectivity event.
 *
 * The drain is normally triggered by networkStatusChange, but that event is not
 * guaranteed - it was observed not firing at all when an Android device's
 * radios came back, leaving a full queue sitting next to a working connection
 * with nothing to wake it. On a rig that means a day's records staying on the
 * phone until someone happens to reopen the app.
 *
 * This costs nothing when the queue is empty, which is almost always.
 */
const RETRY_INTERVAL_MS = 60_000;

export interface SyncWorkerDeps {
  outbox: Outbox;
  transport: OutboxTransport;
  /** Notified after every drain so the UI can refresh its pending count. */
  onChange?: (result: DrainResult) => void;
}

export class SyncWorker {
  private readonly deps: SyncWorkerDeps;
  private running = false;
  private draining = false;
  private teardown: Array<() => void> = [];
  private pendingNudge: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SyncWorkerDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const netHandle = await Network.addListener('networkStatusChange', (status) => {
      if (status.connected) void this.syncNow();
    });
    this.teardown.push(() => void netHandle.remove());

    const appHandle = await CapacitorApp.addListener('resume', () => {
      void this.syncNow();
    });
    this.teardown.push(() => void appHandle.remove());

    // Upload as work arrives. A short debounce collapses a burst of saves -
    // ending a pipe writes the record and its borehole - into one drain.
    const unsubscribe = this.deps.outbox.subscribe(() => {
      if (this.pendingNudge !== null) clearTimeout(this.pendingNudge);
      this.pendingNudge = setTimeout(() => {
        this.pendingNudge = null;
        void this.syncNow();
      }, ENQUEUE_DEBOUNCE_MS);
    });
    this.teardown.push(() => {
      unsubscribe();
      if (this.pendingNudge !== null) clearTimeout(this.pendingNudge);
      this.pendingNudge = null;
    });

    this.ticker = setInterval(() => {
      if (this.deps.outbox.depth() > 0) void this.syncNow();
    }, RETRY_INTERVAL_MS);
    this.teardown.push(() => {
      if (this.ticker !== null) clearInterval(this.ticker);
      this.ticker = null;
    });

    // Catch up on whatever accumulated while the app was closed.
    void this.syncNow();
  }

  stop(): void {
    this.running = false;
    for (const off of this.teardown) off();
    this.teardown = [];
  }

  /**
   * Drain now if connected. Safe to call from anywhere; overlapping calls
   * collapse into the one already in flight so a burst of saves does not fire
   * several concurrent drains over a weak link.
   */
  async syncNow(): Promise<DrainResult> {
    const idle: DrainResult = { sent: 0, failed: 0, parked: 0 };
    if (this.draining) return idle;
    if (this.deps.outbox.depth() === 0) return idle;

    const status = await Network.getStatus().catch(() => ({ connected: true }));
    if (!status.connected) return idle;

    this.draining = true;
    try {
      const result = await this.deps.outbox.drain(this.deps.transport);
      this.deps.onChange?.(result);
      return result;
    } finally {
      this.draining = false;
    }
  }
}
